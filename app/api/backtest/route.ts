// app/api/backtest/route.ts
// Runs a DCA bot backtest for a given coin, date range,
// and bot parameters, using 1m candle data.

import pool from '@/lib/db'
import { runBacktest } from '@/lib/backtest'
import type { OhlcvRow, BacktestParams } from '@/types'

export async function POST(request: Request) {
  try {
    const body = await request.json() as BacktestParams

    const {
      coin_id, date_from, date_to,
      deviation, max_orders, tp_target, multiplier, capital, stop_loss_pct
    } = body

    // ── Basic validation ──────────────────────────────────
    if (!coin_id || !date_from || !date_to) {
      return Response.json(
        { success: false, error: 'Missing coin_id, date_from, or date_to' },
        { status: 400 }
      )
    }

    if (deviation <= 0 || max_orders <= 0 || tp_target <= 0 || multiplier < 1 || capital <= 0) {
      return Response.json(
        { success: false, error: 'Invalid parameters — check deviation, max_orders, tp_target, multiplier (>=1), and capital' },
        { status: 400 }
      )
    }

    if (stop_loss_pct !== undefined && (stop_loss_pct <= 0 || stop_loss_pct >= 100)) {
      return Response.json(
        { success: false, error: 'Invalid stop_loss_pct — must be between 0 and 100 (exclusive)' },
        { status: 400 }
      )
    }

    // ── Validate minimum capital for order1Size >= 1 USDT ────
    const totalOrders = max_orders + 1
    const minCapital = multiplier === 1
      ? totalOrders
      : (Math.pow(multiplier, totalOrders) - 1) / (multiplier - 1)

    if (capital < minCapital) {
      return Response.json(
        {
          success: false,
          error: `Capital too low for these settings — the first order would be below 1 USDT. Minimum initial investment for max_orders=${max_orders} (${totalOrders} total orders) and multiplier=${multiplier} is ${minCapital.toFixed(2)} USDT.`
        },
        { status: 400 }
      )
    }

    // ── Fetch candles for the requested range ─────────────
    const { rows } = await pool.query(`
      SELECT id, coin_id, open_time, open, high, low, close, volume
      FROM ohlcv_1m
      WHERE coin_id = $1 AND open_time >= $2 AND open_time <= $3
      ORDER BY open_time ASC
    `, [coin_id, date_from, date_to])

    if (rows.length === 0) {
      return Response.json(
        { success: false, error: 'No candle data found for this coin and date range' },
        { status: 404 }
      )
    }

    const candles: OhlcvRow[] = rows.map(row => ({
      id:        row.id,
      coin_id:   row.coin_id,
      interval:  '1m',
      open_time: new Date(row.open_time),
      open:      Number(row.open),
      high:      Number(row.high),
      low:       Number(row.low),
      close:     Number(row.close),
      volume:    Number(row.volume),
    }))

    // ── Run the simulation ─────────────────────────────────
    const result = runBacktest(candles, {
      coin_id, date_from, date_to,
      deviation, max_orders, tp_target, multiplier, capital, stop_loss_pct
    })

    result.coin_id = coin_id

    return Response.json({ success: true, result })

  } catch (error) {
    console.error('Backtest failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}
