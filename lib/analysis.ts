// lib/analysis.ts
// Pure calculation functions — no API calls, no DB queries
// Takes raw candles as input, returns computed metrics

import { OhlcvRow, ComputedMetricRow } from '../types'

// ─── Default thresholds per interval ──────────────────────

export const DEFAULT_THRESHOLDS: Record<string, number> = {
  '5m':  3.0,
  '10m': 5.0,
  '20m': 7.0,
  '30m': 9.0,
  '1h':  12.0,
}

// ─── Group sizes for aggregation ──────────────────────────

export const INTERVAL_GROUPS: Record<string, number> = {
  '5m':  1,
  '10m': 2,
  '20m': 4,
  '30m': 6,
  '1h':  12,
}

// ─── Calculate amplitude of a single candle ───────────────

export function candleAmplitude(candle: OhlcvRow): number {
  return (candle.high - candle.low) / candle.low * 100
}

// ─── Average amplitude across all candles ─────────────────

export function avgAmplitude(candles: OhlcvRow[]): number {
  if (candles.length === 0) return 0
  const total = candles.reduce((sum, c) => sum + candleAmplitude(c), 0)
  return total / candles.length
}

// ─── Count candles where amplitude exceeds threshold ──────

export function countAboveThreshold(
  candles:    OhlcvRow[],
  threshold:  number,
  windowDays: number
): number {
  const count = candles.filter(c => candleAmplitude(c) > threshold).length
  return count / windowDays
}

// ─── Net variation over the period ────────────────────────

export function netVariation(candles: OhlcvRow[]): number {
  if (candles.length < 2) return 0
  const firstClose = candles[0].close
  const lastClose  = candles[candles.length - 1].close
  return (lastClose - firstClose) / firstClose * 100
}

// ─── Max drawdown ─────────────────────────────────────────

export function maxDrawdown(candles: OhlcvRow[]): number {
  if (candles.length === 0) return 0

  let peak    = candles[0].high
  let maxDrop = 0

  for (const candle of candles) {
    if (candle.high > peak) peak = candle.high
    const drop = (candle.low - peak) / peak * 100
    if (drop < maxDrop) maxDrop = drop
  }

  return maxDrop
}

// ─── Average recovery time ────────────────────────────────

export function avgRecoveryDays(candles: OhlcvRow[]): number {
  if (candles.length === 0) return 0

  const avgAmp = avgAmplitude(candles)
  const DROP_TRIGGER = avgAmp * 3
  
  const recoveryTimes: number[] = []

  let i = 0
  while (i < candles.length) {
    const startPrice = candles[i].close

    let j = i + 1
    while (j < candles.length) {
      const drop = (candles[j].low - startPrice) / startPrice * 100

      if (drop < -DROP_TRIGGER) {
        const recoveryTarget = startPrice
        let k = j + 1

        while (k < candles.length) {
          if (candles[k].high >= recoveryTarget) {
            const dropTime     = candles[j].open_time.getTime()
            const recoveryTime = candles[k].open_time.getTime()
            const days = (recoveryTime - dropTime) / (1000 * 60 * 60 * 24)
            recoveryTimes.push(days)
            i = k
            break
          }
          k++
        }

        if (k >= candles.length) {
          recoveryTimes.push(90)
          i = candles.length
        }
        break
      }
      j++
    }

    i++
  }

  if (recoveryTimes.length === 0) return 0
  return recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length
}

// ─── Aggregate 5m candles into larger intervals ───────────

export function aggregateCandles(
  candles:   OhlcvRow[],
  groupSize: number
): OhlcvRow[] {
  const result: OhlcvRow[] = []

  for (let i = 0; i < candles.length; i += groupSize) {
    const group = candles.slice(i, i + groupSize)
    if (group.length < groupSize) break

    result.push({
      id:        0,
      coin_id:   group[0].coin_id,
      interval:  group[0].interval,
      open_time: group[0].open_time,
      open:      group[0].open,
      high:      Math.max(...group.map(c => c.high)),
      low:       Math.min(...group.map(c => c.low)),
      close:     group[group.length - 1].close,
      volume:    group.reduce((sum, c) => sum + c.volume, 0),
    })
  }

  return result
}

// ─── Calculate all metrics for one coin/interval/window ───

export function calculateMetrics(
  coin_id:    string,
  interval:   string,
  candles:    OhlcvRow[],
  windowDays: number
): ComputedMetricRow {
  const threshold = DEFAULT_THRESHOLDS[interval] ?? 3.0

  const actualDays = candles.length > 0
    ? Math.round(
        (candles[candles.length - 1].open_time.getTime() - candles[0].open_time.getTime())
        / (1000 * 60 * 60 * 24)
      )
    : 0

  return {
    id:                   0,
    coin_id,
    interval,
    window_days:          windowDays,
    avg_amplitude:        avgAmplitude(candles),
    count_above_default:  countAboveThreshold(candles, threshold, windowDays),
    avg_recovery_days:    avgRecoveryDays(candles),
    max_drop:             maxDrawdown(candles),
    net_var:              netVariation(candles),
    actual_days:          actualDays,
    last_calculated:      new Date(),
  }
}
