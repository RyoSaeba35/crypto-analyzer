// app/api/cron/route.ts
// Runs daily — fetches missing candles since last DB entry
// Self-healing — works even if cron missed several days
//
// Also maintains 1m candle data (ohlcv_1m) for the top 25
// coins by score, used by the backtester. New entrants to
// the top 25 get a full 60-day backfill; existing ones get
// a cheap incremental top-up. Data is trimmed to 60 days.

import pool from '@/lib/db'
import { NextRequest } from 'next/server'
import {
  fetchTopCoins, fetchCandles, fetchCandlesGate, fetchCandlesKucoin,
  backfillCandles90d
} from '@/lib/exchanges'
import { calculateScore } from '@/lib/scoring'
import { CryptoRow, OhlcvRow, ScreenerCrypto, MetricSet } from '@/types'
import {
  calculateMetrics,
  aggregateCandles,
  INTERVAL_GROUPS
} from '@/lib/analysis'


export async function GET(request: NextRequest) {
  //  Auth check
  const secret = request.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    console.log('Daily cron job started...')

    //  Step 1: fetch top 1200 coins─
    console.log('Fetching top coins from CoinGecko...')
    const coins = await fetchTopCoins(1200)
    console.log(`Got ${coins.length} coins`)

    //  Step 2: upsert coins
    for (const coin of coins) {
      await upsertCoin(coin)
    }
    console.log(`Upserted ${coins.length} coins`)

    //  Step 3: fetch missing candles for each coin
    // processes in batches of 10 to respect Binance rate limits
    const BATCH_SIZE = 10
    const BATCH_DELAY = 2000
    let candleCount = 0
    let errorCount = 0
    let diskFull = false


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

    //  Step 4: delete candles older than 60 days
    const deleted = await pool.query(`
      DELETE FROM ohlcv_data
      WHERE open_time < NOW() - INTERVAL '60 days'
    `)
    console.log(`Deleted ${deleted.rowCount} old candles`)

    //  Step 5: recalculate all metrics─
    console.log('Calculating metrics...')
    await calculateAllMetrics()
    console.log('Metrics calculated')

    //  Step 6: update 1m candles for top 25 coins ─
    console.log('Updating 1m candles for top 25...')
    let new1mCandles = 0
    let new1mErrors = 0

    try {
      const top25 = await getTop25Coins()
      console.log(`Top 25: ${top25.map(c => c.symbol).join(', ')}`)

      for (const coin of top25) {
        try {
          const { rows: existing } = await pool.query(
            `SELECT 1 FROM ohlcv_1m WHERE coin_id = $1 LIMIT 1`,
            [coin.coin_id]
          )

          if (existing.length === 0) {
            console.log(`${coin.symbol}: new to top 25, backfilling 60 days...`)
            new1mCandles += await fetch60Days1m(coin.coin_id, coin.symbol, coin.exchange)
          } else {
            new1mCandles += await fetchMissing1mCandles(coin.coin_id, coin.symbol, coin.exchange)
          }
        } catch (err) {
          console.error(`Error updating 1m for ${coin.symbol}:`, err)
          new1mErrors++
        }
        await sleep(150)
      }

      const deleted1m = await pool.query(`
        DELETE FROM ohlcv_1m WHERE open_time < NOW() - INTERVAL '60 days'
      `)
      console.log(`1m candles added: ${new1mCandles}, trimmed: ${deleted1m.rowCount}, errors: ${new1mErrors}`)
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

//  Fetch all candles since last DB entry
async function fetchMissingCandles(
  coin_id: string,
  symbol: string
): Promise<number> {
  const { rows } = await pool.query(`
    SELECT
      MAX(o.open_time) as last_time,
      c.exchange
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
      return await backfillCandles(coin_id, symbol, 60)
    } catch (err: any) {
      if (err?.code === '53100') {
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

//  Calculate metrics for all coins─
async function calculateAllMetrics() {
  const { rows: coins } = await pool.query(
    'SELECT coin_id FROM cryptos ORDER BY market_cap_rank ASC'
  )

  const WINDOWS = [1, 7, 15, 30, 60]
  const INTERVALS = ['5m', '10m', '20m', '30m', '1h']

  for (const coin of coins) {
    // fetch all 5m candles for this coin
    const { rows: candles } = await pool.query(`
      SELECT * FROM ohlcv_data
      WHERE coin_id = $1 AND interval = '5m'
      ORDER BY open_time ASC
    `, [coin.coin_id])

    if (candles.length === 0) continue

    for (const intervalName of INTERVALS) {
      // aggregate 5m candles into target interval
      const groupSize = INTERVAL_GROUPS[intervalName]
      const aggregated = aggregateCandles(candles, groupSize)

      for (const windowDays of WINDOWS) {
        // filter to only the window period
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - windowDays)
        const windowCandles = aggregated.filter(c => c.open_time >= cutoff)

        if (windowCandles.length === 0) continue

        const metrics = calculateMetrics(
          coin.coin_id,
          intervalName,
          windowCandles,
          windowDays
        )

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

//  Helper: upsert one coin
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

//  Get current top 25 coins by score─
// Same shape/scoring as /api/cryptos + lib/scoring, used to
// decide which coins get 1m data maintained in ohlcv_1m.
async function getTop25Coins(): Promise<(ScreenerCrypto & { exchange: string })[]> {
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
        coin_id:         row.coin_id,
        symbol:          row.symbol,
        name:            row.name,
        image_url:       row.image_url,
        current_price:   row.current_price,
        market_cap_rank: row.market_cap_rank,
        market_cap:      row.market_cap,
        total_volume:    row.total_volume,
        exchange:        row.exchange,
        metrics:         {},
      })
    }

    const coin = coinsMap.get(row.coin_id)!
    coin.metrics[`${row.interval}_${row.window_days}`] = {
      interval:            row.interval,
      window_days:         row.window_days,
      avg_amplitude:       row.avg_amplitude,
      count_above_default: row.count_above_default,
      avg_recovery_days:   row.avg_recovery_days,
      max_drop:            row.max_drop,
      net_var:             row.net_var,
      actual_days:         row.actual_days,
    } as MetricSet
  }

  return Array.from(coinsMap.values())
    .map(coin => ({ coin, score: calculateScore(coin) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(c => c.coin)
}

//  Incremental 1m update (small, daily top-up)
// Tries KuCoin first (often deeper/cleaner history), falls
// back to the coin's existing exchange (gate/binance).
async function fetchMissing1mCandles(
  coin_id: string,
  symbol: string,
  exchange: string
): Promise<number> {
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

//  Full 60-day backfill (for new top-25 entrants)
async function fetch60Days1m(
  coin_id: string,
  symbol: string,
  exchange: string
): Promise<number> {
  const TOTAL_CANDLES = 60 * 1440
  const PER_REQUEST = 1000
  const useBinance = exchange !== 'gate'
  const now = Date.now()
  const requests = Math.ceil(TOTAL_CANDLES / PER_REQUEST)

  let inserted = 0
  for (let i = 0; i < requests; i++) {
    const startTime = now - ((i + 1) * PER_REQUEST * 60 * 1000)

    let candles = await fetchCandlesKucoin(symbol, '1min', PER_REQUEST, startTime)
    if (candles.length === 0) {
      candles = useBinance
        ? await fetchCandles(symbol, '1m', PER_REQUEST, startTime)
        : await fetchCandlesGate(symbol, '1m', PER_REQUEST, startTime)
    }
    if (candles.length === 0) {
      await sleep(150)
      continue
    }

    inserted += await insert1mCandles(coin_id, candles)
    if ((i + 1) % 20 === 0) console.log(`  ${symbol}: ${i + 1}/${requests} requests done`)
    await sleep(150)
  }

  return inserted
}

//  Shared insert helper for ohlcv_1m
async function insert1mCandles(coin_id: string, candles: OhlcvRow[]): Promise<number> {
  const values: (string | number | Date)[] = []
  const placeholders: string[] = []

  candles.forEach((candle, idx) => {
    const base = idx * 7
    placeholders.push(
      `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`
    )
    values.push(
      coin_id, candle.open_time,
      candle.open, candle.high, candle.low,
      candle.close, candle.volume,
    )
  })

  await pool.query(`
    INSERT INTO ohlcv_1m (coin_id, open_time, open, high, low, close, volume)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (coin_id, open_time) DO NOTHING
  `, values)

  return candles.length
}

//  Helper: sleep
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
