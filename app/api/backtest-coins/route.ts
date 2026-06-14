// app/api/backtest-coins/route.ts
// Returns the coins available for backtesting (those with
// 1m data in ohlcv_1m), along with each coin's available
// date range and a flag for "limited data" (< 30 days).

import pool from '@/lib/db'

export async function GET() {
  try {
    const { rows } = await pool.query(`
      SELECT
        o.coin_id,
        c.symbol,
        c.name,
        MIN(o.open_time) as earliest,
        MAX(o.open_time) as latest,
        COUNT(*) as candle_count
      FROM ohlcv_1m o
      JOIN cryptos c ON c.coin_id = o.coin_id
      GROUP BY o.coin_id, c.symbol, c.name
      ORDER BY c.symbol ASC
    `)

    const coins = rows.map(row => {
      const earliest = new Date(row.earliest)
      const latest = new Date(row.latest)
      const daysSpan = (latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24)

      return {
        coin_id:      row.coin_id,
        symbol:       row.symbol,
        name:         row.name,
        earliest:     earliest.toISOString(),
        latest:       latest.toISOString(),
        days_span:    Math.round(daysSpan * 10) / 10,
        candle_count: Number(row.candle_count),
        limited_data: daysSpan < 30,  // flag for UI warning
      }
    })

    return Response.json({ success: true, coins })

  } catch (error) {
    console.error('backtest-coins failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}
