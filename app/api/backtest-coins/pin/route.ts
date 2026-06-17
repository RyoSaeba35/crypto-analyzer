// app/api/backtest-coins/pin/route.ts
import pool from '@/lib/db'
import { has1mDepth, backfill1mCandles } from '@/lib/exchanges'

const MAX_PINS = 5

export async function POST(request: Request) {
  try {
    const { coin_id, replace_coin_id } = await request.json()

    if (!coin_id) {
      return Response.json({ success: false, error: 'coin_id required' }, { status: 400 })
    }

    const { rows: coinRows } = await pool.query(
      `SELECT coin_id, symbol, exchange FROM cryptos WHERE coin_id = $1`,
      [coin_id]
    )
    if (coinRows.length === 0) {
      return Response.json({ success: false, error: 'Unknown coin' }, { status: 404 })
    }
    const { symbol, exchange } = coinRows[0]

    const { rows: alreadyPinned } = await pool.query(
      `SELECT 1 FROM pinned_backtest_coins WHERE coin_id = $1`,
      [coin_id]
    )
    if (alreadyPinned.length > 0) {
      return Response.json({ success: true, message: 'Already pinned' })
    }

    const hasDepth = await has1mDepth(coin_id, exchange, 30)
    if (!hasDepth) {
      return Response.json(
        { success: false, error: 'This coin has less than 30 days of 1-minute history available — not enough for a meaningful backtest' },
        { status: 400 }
      )
    }

    if (replace_coin_id) {
      const { rows: toReplace } = await pool.query(
        `SELECT 1 FROM pinned_backtest_coins WHERE coin_id = $1`,
        [replace_coin_id]
      )
      if (toReplace.length === 0) {
        return Response.json({ success: false, error: 'replace_coin_id is not currently pinned' }, { status: 400 })
      }
      await pool.query(`DELETE FROM ohlcv_1m WHERE coin_id = $1`, [replace_coin_id])
      await pool.query(`DELETE FROM pinned_backtest_coins WHERE coin_id = $1`, [replace_coin_id])
    } else {
      const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM pinned_backtest_coins`)
      if (Number(countRows[0].count) >= MAX_PINS) {
        return Response.json(
          { success: false, error: `Max ${MAX_PINS} pinned coins reached — remove one first or specify replace_coin_id` },
          { status: 400 }
        )
      }
    }

    await pool.query(`INSERT INTO pinned_backtest_coins (coin_id) VALUES ($1)`, [coin_id])
    const inserted = await backfill1mCandles(coin_id, symbol, exchange, 60)

    return Response.json({ success: true, candles_inserted: inserted })

  } catch (error) {
    console.error('Pin failed:', error)
    return Response.json({ success: false, error: String(error) }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const coin_id = searchParams.get('coin_id')

    if (!coin_id) {
      return Response.json({ success: false, error: 'coin_id required' }, { status: 400 })
    }

    await pool.query(`DELETE FROM ohlcv_1m WHERE coin_id = $1`, [coin_id])
    const result = await pool.query(`DELETE FROM pinned_backtest_coins WHERE coin_id = $1`, [coin_id])

    return Response.json({ success: true, removed: (result.rowCount ?? 0) > 0 })

  } catch (error) {
    console.error('Unpin failed:', error)
    return Response.json({ success: false, error: String(error) }, { status: 500 })
  }
}
