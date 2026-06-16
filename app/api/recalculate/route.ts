// app/api/recalculate/route.ts
// Recalculates computed_metrics from existing ohlcv_data
// No API calls — fast (~20-25 min for 689 coins)

import pool from '@/lib/db'
import {
  calculateMetrics,
  aggregateCandles,
  INTERVAL_GROUPS
} from '@/lib/analysis'

export async function GET() {
  try {
    console.log('Recalculation started...')

    const { rows: coins } = await pool.query(
      'SELECT coin_id FROM cryptos ORDER BY market_cap_rank ASC'
    )

    const WINDOWS = [1, 7, 15, 30, 60]
    const INTERVALS = ['5m', '10m', '20m', '30m', '1h']

    let processed = 0

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

      processed++
      if (processed % 50 === 0) {
        console.log(`Processed ${processed}/${coins.length} coins`)
      }
    }

    console.log('Recalculation complete!')

    return Response.json({
      success: true,
      coins_processed: processed,
    })

  } catch (error) {
    console.error('Recalculation failed:', error)
    return Response.json(
      { success: false, error: String(error) },
      { status: 500 }
    )
  }
}
