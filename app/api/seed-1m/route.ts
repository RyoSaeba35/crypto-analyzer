// app/api/seed-1m/route.ts
// Fetches 60 days of 1-minute candles for the top 25 coins
// by score (for use by the backtester). Tries KuCoin first
// (often has deeper 1m history), falls back to the coin's
// existing exchange (gate/binance) if KuCoin doesn't have it.
// Run this manually — it's a long operation (~20-30 min).

import pool from '@/lib/db'
import { fetchCandles, fetchCandlesGate, fetchCandlesKucoin } from '@/lib/exchanges'
import { calculateScore } from '@/lib/scoring'
import type { ScreenerCrypto, MetricSet } from '@/types'

export async function GET() {
  try {
    console.log('1m seed started — this will take 20-30 minutes...')

    //  Step 1: load coins + metrics, same shape as /api/cryptos
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
      const key = `${row.interval}_${row.window_days}`
      coin.metrics[key] = {
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

    const allCoins = Array.from(coinsMap.values())

    //  Step 2: rank by score, take top 25
    const top25 = allCoins
      .map(coin => ({ coin, score: calculateScore(coin) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)

    console.log('Top 25 by score:')
    top25.forEach((c, i) => console.log(`${i + 1}. ${c.coin.symbol} — ${c.score.toFixed(2)}`))

    //  Step 3: fetch 60 days of 1m candles for each
    let totalCandles = 0
    let errorCount = 0

    for (const { coin } of top25) {
      try {
        const inserted = await fetch60Days1m(coin.coin_id, coin.symbol, coin.exchange)
        totalCandles += inserted
        console.log(`${coin.symbol}: ${inserted} 1m candles inserted`)
      } catch (err) {
        console.error(`Error fetching 1m for ${coin.symbol}:`, err)
        errorCount++
      }
    }

    console.log(`1m seed complete. Total candles: ${totalCandles}, errors: ${errorCount}`)

    return Response.json({
      success: true,
      coins_processed: top25.map(c => ({ symbol: c.coin.symbol, score: c.score })),
      total_candles: totalCandles,
      errors: errorCount,
    })

  } catch (error) {
    console.error('1m seed failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}

//  Fetch 60 days of 1m candles for one coin
// Tries KuCoin first (often deeper 1m history), falls back
// to the coin's existing exchange (gate/binance) for any
// requests where KuCoin returns nothing.
async function fetch60Days1m(
  coin_id: string,
  symbol: string,
  exchange: string
): Promise<number> {
  const DAYS = 60
  const CANDLES_PER_DAY = 1440  // 1m candles
  const TOTAL_CANDLES = DAYS * CANDLES_PER_DAY
  const PER_REQUEST = 1000

  const useBinance = exchange !== 'gate'

  let inserted = 0
  const now = Date.now()
  const requests = Math.ceil(TOTAL_CANDLES / PER_REQUEST)

  for (let i = 0; i < requests; i++) {
    const startTime = now - ((i + 1) * PER_REQUEST * 60 * 1000)

    // try KuCoin first
    let candles = await fetchCandlesKucoin(symbol, '1min', PER_REQUEST, startTime)

    // fall back to the coin's existing exchange if KuCoin has nothing
    if (candles.length === 0) {
      candles = useBinance
        ? await fetchCandles(symbol, '1m', PER_REQUEST, startTime)
        : await fetchCandlesGate(symbol, '1m', PER_REQUEST, startTime)
    }

    if (candles.length === 0) {
      await sleep(150)
      continue
    }

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
      INSERT INTO ohlcv_1m
        (coin_id, open_time, open, high, low, close, volume)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (coin_id, open_time) DO NOTHING
    `, values)

    inserted += candles.length

    if ((i + 1) % 20 === 0) {
      console.log(`  ${symbol}: ${i + 1}/${requests} requests done`)
    }

    await sleep(150)
  }

  return inserted
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
