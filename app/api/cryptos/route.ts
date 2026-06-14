// app/api/cryptos/route.ts
// Serves pre-calculated metrics to the screener frontend
// Fast — reads from computed_metrics, not raw candles

import pool from '@/lib/db'

export async function GET() {
  try {
    // join cryptos + computed_metrics to get everything in one query
    const { rows } = await pool.query(`
      SELECT
        c.coin_id,
        c.symbol,
        c.name,
        c.image_url,
        c.current_price,
        c.market_cap_rank,
        c.market_cap,
        c.total_volume,
        m.interval,
        m.window_days,
        m.avg_amplitude,
        m.count_above_default,
        m.avg_recovery_days,
        m.max_drop,
        m.net_var,
        m.actual_days
      FROM cryptos c
      JOIN computed_metrics m ON c.coin_id = m.coin_id
      WHERE c.last_updated > NOW() - INTERVAL '2 days'
      ORDER BY c.market_cap_rank ASC
    `)

    // reshape flat rows into nested structure
    // one object per coin, with metrics nested by interval and window
    const coinsMap = new Map()

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
          metrics:         {}
        })
      }

      const coin = coinsMap.get(row.coin_id)

      // key = "5m_30" meaning interval 5m, window 30 days
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
      }
    }

    const coins = Array.from(coinsMap.values())

    return Response.json({
      success: true,
      count: coins.length,
      coins,
    })

  } catch (error) {
    console.error('GET /api/cryptos failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}
