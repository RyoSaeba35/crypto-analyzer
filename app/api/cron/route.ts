// app/api/cron/route.ts
import pool from '@/lib/db'
import { NextRequest } from 'next/server'
import {
  fetchTopCoins, fetchCandles, fetchCandlesGate, fetchCandlesKucoin,
  backfillCandles, has1mDepth, backfill1mCandles, insert1mCandles
} from '@/lib/exchanges'
import { calculateScore } from '@/lib/scoring'
import { CryptoRow, ScreenerCrypto, MetricSet } from '@/types'
import {
  calculateMetrics,
  aggregateCandles,
  INTERVAL_GROUPS
} from '@/lib/analysis'

let diskFull = false

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    console.log('Daily cron job started...')

    console.log('Fetching top coins from CoinGecko...')
    const coins = await fetchTopCoins(1200)
    console.log(`Got ${coins.length} coins`)

    for (const coin of coins) {
      await upsertCoin(coin)
    }
    console.log(`Upserted ${coins.length} coins`)

    const BATCH_SIZE = 10
    const BATCH_DELAY = 2000
    let candleCount = 0
    let errorCount = 0
    diskFull = false

    for (let i = 0; i < coins.length; i += BATCH_SIZE) {
      const batch = coins.slice(i, i + BATCH_SIZE)
      console.log(`Processing coins ${i + 1}-${i + batch.length} of ${coins.length}...`)

      await Promise.all(batch.map(async (coin) => {
        try {
          const inserted = await fetchMissingCandles(coin.coin_id, coin.symbol)
          candleCount += inserted
        } catch (err) {
          console.error(`Error processing ${coin.symbol}:`, err)
          errorCount++
        }
      }))

      if (i + BATCH_SIZE < coins.length) {
        await sleep(BATCH_DELAY)
      }
    }

    console.log(`Candles saved: ${candleCount}, errors: ${errorCount}`)

    const deleted = await pool.query(`
      DELETE FROM ohlcv_data
      WHERE open_time < NOW() - INTERVAL '90 days'
    `)
    console.log(`Deleted ${deleted.rowCount} old candles`)

    console.log('Calculating metrics...')
    await calculateAllMetrics()
    console.log('Metrics calculated')

    // ── Step 6: maintain 1m candles for top 10 (age + depth
    // filtered, by score) PLUS any manually pinned coins ──
    console.log('Updating 1m candles...')
    let new1mCandles = 0
    let new1mErrors = 0

    try {
      const top10 = await getTop10Coins()
      const pinned = await getPinnedCoins()

      const maintainMap = new Map<string, ScreenerCrypto & { exchange: string }>()
      for (const c of top10) maintainMap.set(c.coin_id, c)
      for (const c of pinned) maintainMap.set(c.coin_id, c)
      const toMaintain = Array.from(maintainMap.values())

      console.log(`Top 10: ${top10.map(c => c.symbol).join(', ')}`)
      console.log(`Pinned: ${pinned.map(c => c.symbol).join(', ') || 'none'}`)

      for (const coin of toMaintain) {
        try {
          const { rows: existing } = await pool.query(
            `SELECT 1 FROM ohlcv_1m WHERE coin_id = $1 LIMIT 1`,
            [coin.coin_id]
          )

          if (existing.length === 0) {
            console.log(`${coin.symbol}: backfilling 60 days of 1m...`)
            new1mCandles += await backfill1mCandles(coin.coin_id, coin.symbol, coin.exchange, 60)
          } else {
            new1mCandles += await fetchMissing1mCandles(coin.coin_id, coin.symbol, coin.exchange)
          }
        } catch (err) {
          console.error(`Error updating 1m for ${coin.symbol}:`, err)
          new1mErrors++
        }
        await sleep(150)
      }

      // Actively prune anyone no longer in top 10 AND not pinned —
      // don't wait up to 60 days for the age trim to catch rotation.
      const keepIds = toMaintain.map(c => c.coin_id)
      const pruned = keepIds.length > 0
        ? await pool.query(`DELETE FROM ohlcv_1m WHERE coin_id != ALL($1)`, [keepIds])
        : await pool.query(`DELETE FROM ohlcv_1m`)
      console.log(`Pruned ${pruned.rowCount} rows for coins no longer tracked`)

      const deleted1m = await pool.query(`
        DELETE FROM ohlcv_1m WHERE open_time < NOW() - INTERVAL '60 days'
      `)
      console.log(`1m candles added: ${new1mCandles}, age-trimmed: ${deleted1m.rowCount}, errors: ${new1mErrors}`)
    } catch (err) {
      console.error('1m update step failed:', err)
    }

    return Response.json({
      success: true,
      coins_processed: coins.length,
      candles_saved: candleCount,
      errors: errorCount,
      candles_1m_added: new1mCandles,
      candles_1m_errors: new1mErrors,
    })

  } catch (error) {
    console.error('Daily cron failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}

async function fetchMissingCandles(coin_id: string, symbol: string): Promise<number> {
  const { rows } = await pool.query(`
    SELECT MAX(o.open_time) as last_time, c.exchange
    FROM ohlcv_data o
    JOIN cryptos c ON c.coin_id = o.coin_id
    WHERE o.coin_id = $1 AND o.interval = '5m'
    GROUP BY c.exchange
  `, [coin_id])

  if (rows.length === 0 || !rows[0].last_time) {
    if (diskFull) {
      console.log(`${symbol}: skipping backfill, database is out of disk space`)
      return 0
    }

    console.log(`${symbol}: no existing 5m data, running full backfill...`)
    try {
      return await backfillCandles(coin_id, symbol, 90)
    } catch (err: unknown) {
      if (isDiskFullError(err)) {
        diskFull = true
        console.error(`Database out of disk space — stopping new-coin backfills for this run`)
        return 0
      }
      throw err
    }
  }

  const lastTime = rows[0].last_time as Date
  const exchange = rows[0].exchange as string
  const useBinance = exchange !== 'gate'

  const startTime = lastTime.getTime()
  const now = Date.now()
  const msSinceLastCandle = now - startTime
  const candlesNeeded = Math.ceil(msSinceLastCandle / (5 * 60 * 1000))

  if (candlesNeeded <= 0) return 0

  let inserted = 0
  const PER_REQUEST = 1000
  const requests = Math.ceil(candlesNeeded / PER_REQUEST)

  for (let i = 0; i < requests; i++) {
    const batchStart = startTime + (i * PER_REQUEST * 5 * 60 * 1000)
    if (batchStart >= now) break

    const candles = useBinance
      ? await fetchCandles(symbol, '5m', PER_REQUEST, batchStart)
      : await fetchCandlesGate(symbol, '5m', PER_REQUEST, batchStart)

    if (candles.length === 0) continue

    const values: (string | number | Date)[] = []
    const placeholders: string[] = []

    candles.forEach((candle, idx) => {
      const base = idx * 8
      placeholders.push(
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`
      )
      values.push(
        coin_id, '5m', candle.open_time,
        candle.open, candle.high, candle.low,
        candle.close, candle.volume,
      )
    })

    await pool.query(`
      INSERT INTO ohlcv_data
        (coin_id, interval, open_time, open, high, low, close, volume)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (coin_id, interval, open_time) DO NOTHING
    `, values)

    inserted += candles.length
    await sleep(100)
  }

  return inserted
}

function isDiskFullError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '53100'
  )
}

async function calculateAllMetrics() {
  const { rows: coins } = await pool.query(
    'SELECT coin_id FROM cryptos ORDER BY market_cap_rank ASC'
  )

  const WINDOWS = [1, 7, 15, 30, 90]
  const INTERVALS = ['5m', '10m', '20m', '30m', '1h']

  for (const coin of coins) {
    const { rows: candles } = await pool.query(`
      SELECT * FROM ohlcv_data
      WHERE coin_id = $1 AND interval = '5m'
      ORDER BY open_time ASC
    `, [coin.coin_id])

    if (candles.length === 0) continue

    for (const intervalName of INTERVALS) {
      const groupSize = INTERVAL_GROUPS[intervalName]
      const aggregated = aggregateCandles(candles, groupSize)

      for (const windowDays of WINDOWS) {
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - windowDays)
        const windowCandles = aggregated.filter(c => c.open_time >= cutoff)

        if (windowCandles.length === 0) continue

        const metrics = calculateMetrics(coin.coin_id, intervalName, windowCandles, windowDays)

        await pool.query(`
          INSERT INTO computed_metrics (
            coin_id, interval, window_days,
            avg_amplitude, count_above_default,
            avg_recovery_days, max_drop, net_var,
            actual_days, last_calculated
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT (coin_id, interval, window_days) DO UPDATE SET
            avg_amplitude       = EXCLUDED.avg_amplitude,
            count_above_default = EXCLUDED.count_above_default,
            avg_recovery_days   = EXCLUDED.avg_recovery_days,
            max_drop            = EXCLUDED.max_drop,
            net_var             = EXCLUDED.net_var,
            actual_days         = EXCLUDED.actual_days,
            last_calculated     = NOW()
        `, [
          metrics.coin_id, metrics.interval, metrics.window_days,
          metrics.avg_amplitude, metrics.count_above_default,
          metrics.avg_recovery_days, metrics.max_drop, metrics.net_var,
          metrics.actual_days,
        ])
      }
    }
  }
}

async function upsertCoin(coin: CryptoRow) {
  await pool.query(`
    INSERT INTO cryptos (
      coin_id, symbol, name, market_cap,
      market_cap_rank, total_volume, current_price,
      image_url, last_updated, exchange
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
    ON CONFLICT (coin_id) DO UPDATE SET
      symbol          = EXCLUDED.symbol,
      name            = EXCLUDED.name,
      market_cap      = EXCLUDED.market_cap,
      market_cap_rank = EXCLUDED.market_cap_rank,
      total_volume    = EXCLUDED.total_volume,
      current_price   = EXCLUDED.current_price,
      image_url       = EXCLUDED.image_url,
      last_updated    = NOW()
  `, [
    coin.coin_id, coin.symbol, coin.name, coin.market_cap,
    coin.market_cap_rank, coin.total_volume, coin.current_price,
    coin.image_url, coin.exchange,
  ])
}

// ── Top 10 by score, age-filtered (>=30 days of 5m history),
// verified to have 30+ days of real 1m depth before acceptance ──
async function getTop10Coins(): Promise<(ScreenerCrypto & { exchange: string })[]> {
  const { rows } = await pool.query(`
    SELECT
      c.coin_id, c.symbol, c.name, c.image_url, c.current_price,
      c.market_cap_rank, c.market_cap, c.total_volume, c.exchange,
      m.interval, m.window_days, m.avg_amplitude,
      m.count_above_default, m.avg_recovery_days,
      m.max_drop, m.net_var, m.actual_days
    FROM cryptos c
    JOIN computed_metrics m ON c.coin_id = m.coin_id
    WHERE c.last_updated > NOW() - INTERVAL '2 days'
  `)

  const coinsMap = new Map<string, ScreenerCrypto & { exchange: string }>()

  for (const row of rows) {
    if (!coinsMap.has(row.coin_id)) {
      coinsMap.set(row.coin_id, {
        coin_id: row.coin_id, symbol: row.symbol, name: row.name,
        image_url: row.image_url, current_price: row.current_price,
        market_cap_rank: row.market_cap_rank, market_cap: row.market_cap,
        total_volume: row.total_volume, exchange: row.exchange,
        metrics: {},
      })
    }
    const coin = coinsMap.get(row.coin_id)!
    coin.metrics[`${row.interval}_${row.window_days}`] = {
      interval: row.interval, window_days: row.window_days,
      avg_amplitude: row.avg_amplitude, count_above_default: row.count_above_default,
      avg_recovery_days: row.avg_recovery_days, max_drop: row.max_drop,
      net_var: row.net_var, actual_days: row.actual_days,
    } as MetricSet
  }

  const MIN_AGE_DAYS = 30

  const eligible = Array.from(coinsMap.values())
    .filter(coin => (coin.metrics['5m_30']?.actual_days ?? 0) >= MIN_AGE_DAYS)
    .map(coin => ({ coin, score: calculateScore(coin) }))
    .sort((a, b) => b.score - a.score)

  const selected: (ScreenerCrypto & { exchange: string })[] = []
  for (const { coin } of eligible) {
    if (selected.length >= 10) break
    const hasDepth = await has1mDepth(coin.symbol, coin.exchange)
    if (hasDepth) {
      selected.push(coin)
    } else {
      console.log(`${coin.symbol}: scored well but 1m history doesn't reach 30 days, skipping`)
    }
    await sleep(100)
  }

  return selected
}

// ── Manually pinned coins — the 5-coin cap is enforced at pin
// time (see app/api/backtest-coins/pin/route.ts), not here ──
async function getPinnedCoins(): Promise<(ScreenerCrypto & { exchange: string })[]> {
  const { rows } = await pool.query(`
    SELECT c.coin_id, c.symbol, c.name, c.image_url, c.current_price,
           c.market_cap_rank, c.market_cap, c.total_volume, c.exchange
    FROM pinned_backtest_coins p
    JOIN cryptos c ON c.coin_id = p.coin_id
  `)

  return rows.map(row => ({
    coin_id: row.coin_id, symbol: row.symbol, name: row.name,
    image_url: row.image_url, current_price: row.current_price,
    market_cap_rank: row.market_cap_rank, market_cap: row.market_cap,
    total_volume: row.total_volume, exchange: row.exchange,
    metrics: {},
  }))
}

async function fetchMissing1mCandles(coin_id: string, symbol: string, exchange: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT MAX(open_time) as last_time FROM ohlcv_1m WHERE coin_id = $1`,
    [coin_id]
  )
  if (rows.length === 0 || !rows[0].last_time) return 0

  const lastTime = (rows[0].last_time as Date).getTime()
  const now = Date.now()
  const candlesNeeded = Math.ceil((now - lastTime) / (60 * 1000))
  if (candlesNeeded <= 0) return 0

  const useBinance = exchange !== 'gate'
  let inserted = 0
  const PER_REQUEST = 1000
  const requests = Math.ceil(candlesNeeded / PER_REQUEST)

  for (let i = 0; i < requests; i++) {
    const batchStart = lastTime + (i * PER_REQUEST * 60 * 1000)
    if (batchStart >= now) break

    let candles = await fetchCandlesKucoin(symbol, '1min', PER_REQUEST, batchStart)
    if (candles.length === 0) {
      candles = useBinance
        ? await fetchCandles(symbol, '1m', PER_REQUEST, batchStart)
        : await fetchCandlesGate(symbol, '1m', PER_REQUEST, batchStart)
    }
    if (candles.length === 0) continue

    inserted += await insert1mCandles(coin_id, candles)
    await sleep(100)
  }

  return inserted
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
