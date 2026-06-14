// app/api/seed/route.ts
// Run this ONCE to load 90 days of historical candles
// After that, /api/cron handles daily updates

import pool from '@/lib/db'
import { fetchTopCoins, fetchCandles, fetchCandlesGate } from '@/lib/exchanges'
import { CryptoRow } from '@/types'
import {
  calculateMetrics,
  aggregateCandles,
  INTERVAL_GROUPS
} from '@/lib/analysis'

export async function GET() {
  try {
    console.log('Seed started — this will take a while...')

    // ── Step 1: fetch top 1200 coins ──────────────────────
    const coins = await fetchTopCoins(1200)
    console.log(`Got ${coins.length} coins`)

    // ── Step 2: upsert coins ─────────────────────────────
    for (const coin of coins) {
      await upsertCoin(coin)
    }
    console.log(`Upserted ${coins.length} coins`)

    // ── Step 3: fetch 90 days of candles ─────────────────
    const BATCH_SIZE = 5  // smaller batches for heavy load
    const BATCH_DELAY = 3000  // 3s between batches
    let candleCount = 0
    let errorCount = 0

    for (let i = 0; i < coins.length; i += BATCH_SIZE) {
      const batch = coins.slice(i, i + BATCH_SIZE)
      console.log(`Seeding coins ${i + 1}-${i + batch.length} of ${coins.length}...`)

      await Promise.all(batch.map(async (coin) => {
        try {
          const inserted = await fetch90Days(coin.coin_id, coin.symbol)
          candleCount += inserted
        } catch (err) {
          console.error(`Error seeding ${coin.symbol}:`, err)
          errorCount++
        }
      }))

      if (i + BATCH_SIZE < coins.length) {
        await sleep(BATCH_DELAY)
      }
    }

    console.log(`Candles saved: ${candleCount}, errors: ${errorCount}`)

    // ── Step 4: delete candles older than 90 days ────────
    await pool.query(`
      DELETE FROM ohlcv_data
      WHERE open_time < NOW() - INTERVAL '90 days'
    `)

    // ── Step 5: calculate metrics ─────────────────────────
    console.log('Calculating metrics...')
    await calculateAllMetrics()
    console.log('Seed complete!')

    return Response.json({
      success: true,
      coins_processed: coins.length,
      candles_saved: candleCount,
      errors: errorCount,
    })

  } catch (error) {
    console.error('Seed failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}

// ── Fetch 90 days of 5m candles for one coin ─────────────
async function fetch90Days(
  coin_id: string,
  symbol: string
): Promise<number> {
  const DAYS = 90
  const CANDLES_PER_DAY = 288
  const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY
  const PER_REQUEST = 1000

  // first check if this coin trades on Binance
  const testCandles = await fetchCandles(symbol, '5m', 1)
  const useBinance = testCandles.length > 0

  if (!useBinance) {
    // test Gate.io too
    const testGate = await fetchCandlesGate(symbol, '5m', 1)
    if (testGate.length === 0) {
      // coin doesn't trade on either exchange — skip
      console.log(`${symbol}: not found on Binance or Gate.io, skipping`)
      return 0
    }
    console.log(`${symbol}: using Gate.io`)
    // record which exchange this coin uses
    await pool.query(
      `UPDATE cryptos SET exchange = 'gate' WHERE coin_id = $1`,
      [coin_id]
    )
  }

  let inserted = 0
  const now = Date.now()
  const requests = Math.ceil(TOTAL_CANDLES / PER_REQUEST)

  for (let i = 0; i < requests; i++) {
    const startTime = now - ((i + 1) * PER_REQUEST * 5 * 60 * 1000)

    const candles = useBinance
      ? await fetchCandles(symbol, '5m', PER_REQUEST, startTime)
      : await fetchCandlesGate(symbol, '5m', PER_REQUEST, startTime)

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
    await sleep(200)
  }

  return inserted
}

// ── Calculate metrics (same as cron) ─────────────────────
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

// ── Helpers ───────────────────────────────────────────────
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
