// lib/scoring.ts

import type { ScreenerCrypto as Coin } from '@/types'

// Recency factor
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

//  90-day trend snapshot
function trend90(coin: Coin): { netVar90: number; maxDrop90: number } {
  const m90 = coin.metrics['5m_90']
  return {
    netVar90:  m90?.net_var  ?? 0,
    maxDrop90: m90?.max_drop ?? 0,
  }
}

//  High-risk detection
export function isHighRisk(coin: Coin): boolean {
  const { netVar90, maxDrop90 } = trend90(coin)
  const sustainedDecline = netVar90 < -20
  const crashedFromHigh  = maxDrop90 < -50 && netVar90 > -20
  return sustainedDecline || crashedFromHigh
}

//  Trend penalty
const CRASH_KILL_THRESHOLD = -70

export function trendPenalty(coin: Coin): number {
  const { netVar90, maxDrop90 } = trend90(coin)

  if (maxDrop90 < CRASH_KILL_THRESHOLD) return 0

  const netVarPenalty   = Math.max(0.2,  1 - Math.abs(netVar90)  / 150)
  const drawdownPenalty = Math.max(0.15, 1 - Math.abs(maxDrop90) / 60)

  return netVarPenalty * drawdownPenalty
}

//  Score calculation
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

//  Score color
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
