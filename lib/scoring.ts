// lib/scoring.ts
// Shared scoring logic — used by the screener UI and by
// backend scripts (e.g. selecting top coins for 1m data fetch)

import type { ScreenerCrypto as Coin } from '@/types'

// ── Recency factor ────────────────────────────────────────
// Compares 7-day activity to 30-day average activity.
// If a coin was very active a while ago but has calmed down
// recently, this discounts its score accordingly.

export function recencyFactor(coin: Coin, windowDays: number = 30): number {
  const intervals = ['5m', '10m', '20m', '30m', '1h']
  let totalRatio  = 0
  let validCount  = 0

  for (const interval of intervals) {
    const mWindow = coin.metrics[`${interval}_${windowDays}`]
    const m7      = coin.metrics[`${interval}_7`]
    if (mWindow && m7 && mWindow.count_above_default > 0) {
      totalRatio += m7.count_above_default / mWindow.count_above_default
      validCount++
    }
  }

  if (validCount === 0) return 1
  const avgRatio = totalRatio / validCount
  return Math.min(1, avgRatio + 0.3)
}

// ── 90-day trend snapshot ──────────────────────────────────
// Pulls the two numbers everything below is built on, so they're
// only read from coin.metrics in one place.

function trend90(coin: Coin): { netVar90: number; maxDrop90: number } {
  const m90 = coin.metrics['5m_90']
  return {
    netVar90:  m90?.net_var  ?? 0,
    maxDrop90: m90?.max_drop ?? 0,
  }
}

// ── High-risk detection ────────────────────────────────────
// True if 90-day price action signals death-spiral risk. Two cases:
//   1. Sustained decline — net_var90 is just deeply negative.
//   2. Crashed from a recent peak but net_var still looks flat —
//      the case net_var alone misses. A coin that pumped hard and
//      then gave most of it back can land back near its starting
//      price, so net_var reads near zero even though max_drop shows
//      it fell off a cliff partway through the window — exactly
//      the H situation, if the 90d window start predates the pump.

export function isHighRisk(coin: Coin): boolean {
  const { netVar90, maxDrop90 } = trend90(coin)
  const sustainedDecline = netVar90 < -20
  const crashedFromHigh  = maxDrop90 < -50 && netVar90 > -20
  return sustainedDecline || crashedFromHigh
}

// ── Trend penalty ───────────────────────────────────────────
// Two multiplicative factors over the 90-day window:
//   - netVarPenalty: punishes large net displacement in either
//     direction — range-bound is the bot-friendly sweet spot.
//   - drawdownPenalty: punishes a severe peak-to-trough crash even
//     when net_var looks flat (see isHighRisk for why net_var alone
//     isn't enough).
// Divisors (150, 60) are starting points — worth tuning once we
// check this against a few more real coins, H included.

export function trendPenalty(coin: Coin): number {
  const { netVar90, maxDrop90 } = trend90(coin)

  const netVarPenalty   = Math.max(0.2,  1 - Math.abs(netVar90)  / 150)
  const drawdownPenalty = Math.max(0.15, 1 - Math.abs(maxDrop90) / 60)

  return netVarPenalty * drawdownPenalty
}

// ── Score calculation ────────────────────────────────────
// Pure function — takes a coin, returns a composite score
// Higher score = better DCA bot candidate

export function calculateScore(
  coin: Coin,
  windowDays: number = 30,
  recoveryTolerance: number = 3
): number {
  const m5m  = coin.metrics[`5m_${windowDays}`]
  const m10m = coin.metrics[`10m_${windowDays}`]
  const m20m = coin.metrics[`20m_${windowDays}`]
  const m30m = coin.metrics[`30m_${windowDays}`]
  const m1h  = coin.metrics[`1h_${windowDays}`]

  if (!m5m) return 0

  const composite =
    (m5m?.count_above_default  ?? 0) * 0.35 +
    (m10m?.count_above_default ?? 0) * 0.25 +
    (m20m?.count_above_default ?? 0) * 0.20 +
    (m30m?.count_above_default ?? 0) * 0.12 +
    (m1h?.count_above_default  ?? 0) * 0.08

  const recoveryFactor = Math.max(
    0,
    1 - (m5m.avg_recovery_days / recoveryTolerance)
  )

  return composite * recoveryFactor * trendPenalty(coin) * recencyFactor(coin, windowDays)
}

// ── Score color ───────────────────────────────────────────
// Visual scale: green = strong candidate, yellow = moderate,
// gray = weak/unlikely to be useful for the bot

export function scoreColor(score: number): string {
  if (score > 2)   return 'text-green-600'
  if (score > 0.5) return 'text-yellow-600'
  return 'text-gray-400'
}

export function trendLabel(coin: Coin): {
  label: string
  emoji: string
  className: string
} {
  const { netVar90, maxDrop90 } = trend90(coin)

  if (maxDrop90 < -50 && netVar90 > -20) {
    return { label: 'Crashed from high', emoji: '🕳️', className: 'text-red-600' }
  }
  if (netVar90 < -20) {
    return { label: 'Declining', emoji: '📉', className: 'text-red-600' }
  }
  if (netVar90 > 20) {
    return { label: 'Rising', emoji: '📈', className: 'text-blue-600' }
  }
  return { label: 'Ranging', emoji: '↔', className: 'text-green-600' }
}
