'use client'

import { useState, useEffect, Suspense } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import type { ScreenerCrypto as Coin, MetricSet } from '@/types'
import { calculateScore, scoreColor, trendLabel, isHighRisk } from '@/lib/scoring'

//  Types

interface ApiResponse {
  success: boolean
  count:   number
  coins:   Coin[]
}

//  Component

function ScreenerContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [coins, setCoins]                 = useState<Coin[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState<string | null>(null)
  const [sortBy, setSortBy]               = useState<string>('score')
  const [sortDir, setSortDir]             = useState<'asc' | 'desc'>('desc')

  //  Filters initialized from URL query params
  const [minVolume, setMinVolume] = useState(
    Number(searchParams.get('minVolume')) || 5_000_000
  )
  const [showLowVolume, setShowLowVolume] = useState(
    searchParams.get('showLowVolume') === 'true'
  )
  const [minAge, setMinAge] = useState(
    Number(searchParams.get('minAge')) || 30
  )
  const [showNewCoins, setShowNewCoins] = useState(
    searchParams.get('showNewCoins') === 'true'
  )
  const [showFilters, setShowFilters] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const [selectedCoin, setSelectedCoin]   = useState<Coin | null>(null)
  const [selectedMetric, setSelectedMetric] = useState<keyof MetricSet>('count_above_default')

  const [hideDeclining, setHideDeclining] = useState(
    searchParams.get('hideDeclining') === 'true'
  )

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/api/cryptos')
        const data: ApiResponse = await response.json()
        if (!data.success) throw new Error('API returned error')
        setCoins(data.coins)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  //  Sync filters to URL query params
  useEffect(() => {
    const params = new URLSearchParams()
    params.set('minVolume', String(minVolume))
    params.set('showLowVolume', String(showLowVolume))
    params.set('minAge', String(minAge))
    params.set('showNewCoins', String(showNewCoins))
    params.set('hideDeclining', String(hideDeclining))
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [minVolume, showLowVolume, minAge, showNewCoins, hideDeclining, router])

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(column)
      setSortDir('desc')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
          <p className="text-gray-500">Loading screener data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-red-500">Error: {error}</div>
      </div>
    )
  }

  if (coins.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">
          No data yet — seed is still running.
          <br />
          Check back in a few minutes.
        </div>
      </div>
    )
  }

  //  Sort coins ─
  const sortedCoins = [...coins].sort((a, b) => {
    let aVal: number
    let bVal: number

    if (sortBy === 'score') {
      aVal = calculateScore(a)
      bVal = calculateScore(b)
    } else if (sortBy === 'price') {
      aVal = a.current_price
      bVal = b.current_price
    } else if (sortBy === 'rank') {
      aVal = a.market_cap_rank
      bVal = b.market_cap_rank
    } else if (sortBy === 'market_cap') {
      aVal = a.market_cap
      bVal = b.market_cap
    } else if (sortBy === 'net_var') {
      aVal = a.metrics['5m_90']?.net_var ?? 0
      bVal = b.metrics['5m_90']?.net_var ?? 0
    } else {
      const aM = a.metrics['5m_30']
      const bM = b.metrics['5m_30']
      aVal = aM ? (aM[sortBy as keyof MetricSet] as number) ?? 0 : 0
      bVal = bM ? (bM[sortBy as keyof MetricSet] as number) ?? 0 : 0
    }

    return sortDir === 'asc' ? aVal - bVal : bVal - aVal
  })

  //  Filter by volume, age, and trend
  const visibleCoins = sortedCoins.filter(coin => {
    const volumeOk = showLowVolume || coin.total_volume >= minVolume
    const ageOk = showNewCoins || (coin.metrics['5m_90']?.actual_days ?? 0) >= minAge
    const netVar90 = coin.metrics['5m_90']?.net_var ?? 0
    const trendOk = !hideDeclining || !isHighRisk(coin)
    return volumeOk && ageOk && trendOk
  })

  //  Limit to top 50 unless "show all" is active
  const displayedCoins = showAll ? visibleCoins : visibleCoins.slice(0, 50)

  const arrow = (column: string) => {
    if (sortBy !== column) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">

        {/* Back to home */}
        <div className="mb-4">
          <Link
            href="/"
            className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
          >
            ← Back to home
          </Link>
        </div>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Crypto Volatility Screener
          </h1>
          <p className="text-gray-500 mt-1">
            {coins.length} coins analyzed — find the best DCA bot candidates
          </p>
        </div>

        {/* Legend / explainer */}
        <div className="mb-4 bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-gray-700">
          <p className="mb-1">
            <span className="font-medium">Avg Amp</span> = average % price swing per candle.{' '}
            <span className="font-medium">Count/day</span> = how often that swing exceeds a
            threshold, per day.{' '}
            <span className="font-medium">Max Drop</span> = worst peak-to-trough decline in the
            window.{' '}
            <span className="font-medium">Recovery</span> = average days to bounce back after a drop.
          </p>
          <p className="mb-1">
            <span className="font-medium">Score</span> combines all of these (activity, recovery
            speed, trend stability, and recent consistency) into a single ranking — higher means a
            more promising candidate for a DCA bot.{' '}
            <span className="text-green-600 font-medium">Green</span> (&gt;2) = strong,{' '}
            <span className="text-yellow-600 font-medium">yellow</span> (0.5–2) = moderate,{' '}
            <span className="text-gray-400 font-medium">gray</span> (&lt;0.5) = weak.
          </p>
          <p>
            <span className="font-medium">Trend (90d)</span> = net price change over 90 days.{' '}
            <span className="text-red-600 font-medium">📉 Declining</span> (&lt; -20%) coins may
            show great backtest results while in a slow death-spiral — use the &quot;hide declining
            coins&quot; filter to exclude them, or pair with a stop-loss in the backtester.
          </p>
        </div>

        {/* Filter controls */}
        <div className="mb-4 bg-white rounded-lg shadow p-4">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="text-sm font-medium text-gray-700 hover:text-gray-900 flex items-center gap-2"
          >
            Filters {showFilters ? '▲' : '▼'}
            <span className="text-gray-500 font-normal">
              ({visibleCoins.length} of {coins.length} coins shown)
            </span>
          </button>

          {showFilters && (
            <div className="mt-3 flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                Min daily volume:
                <input
                  type="number"
                  value={minVolume}
                  onChange={(e) => setMinVolume(Number(e.target.value))}
                  step={1_000_000}
                  className="border border-gray-300 rounded px-2 py-1 w-32 text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={showLowVolume}
                  onChange={(e) => setShowLowVolume(e.target.checked)}
                />
                Show low volume coins
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                Min age (days):
                <input
                  type="number"
                  value={minAge}
                  onChange={(e) => setMinAge(Number(e.target.value))}
                  step={5}
                  className="border border-gray-300 rounded px-2 py-1 w-20 text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={showNewCoins}
                  onChange={(e) => setShowNewCoins(e.target.checked)}
                />
                Show new coins
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={hideDeclining}
                  onChange={(e) => setHideDeclining(e.target.checked)}
                />
                Hide declining coins (sustained downtrend or crashed from a recent high)
              </label>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto max-h-[75vh] overflow-y-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th
                    onClick={() => handleSort('rank')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                  >
                    #{arrow('rank')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase bg-gray-50">
                    Coin
                  </th>
                  <th
                    onClick={() => handleSort('price')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                  >
                    Price{arrow('price')}
                  </th>
                  <th
                    onClick={() => handleSort('market_cap')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                  >
                    Market Cap{arrow('market_cap')}
                  </th>
                  <th
                    onClick={() => handleSort('avg_amplitude')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="Average % price swing per 5-minute candle, over the last 30 days"
                  >
                    Avg Amp 5m (30d){arrow('avg_amplitude')}
                  </th>
                  <th
                    onClick={() => handleSort('count_above_default')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="How many times per day the price swing exceeds the threshold, over the last 30 days"
                  >
                    Count/day 5m (30d){arrow('count_above_default')}
                  </th>
                  <th
                    onClick={() => handleSort('max_drop')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="Worst peak-to-trough decline over the last 30 days"
                  >
                    Max Drop (30d){arrow('max_drop')}
                  </th>
                  <th
                    onClick={() => handleSort('avg_recovery_days')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="Average days to recover after a significant drop"
                  >
                    Recovery (30d){arrow('avg_recovery_days')}
                  </th>
                  <th
                    onClick={() => handleSort('actual_days')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="How many real days of data exist within the 30-day window"
                  >
                    Data Days{arrow('actual_days')}
                  </th>
                  <th
                    onClick={() => handleSort('net_var')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="Net price change over the last 90 days — helps spot sustained downtrends vs range-bound coins"
                  >
                    Trend (90d){arrow('net_var')}
                  </th>
                  <th
                    onClick={() => handleSort('score')}
                    className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700 bg-gray-50"
                    title="Composite ranking: activity, recovery speed, trend stability, and recent consistency"
                  >
                    Score{arrow('score')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {displayedCoins.map((coin) => {
                  const m = coin.metrics['5m_30']
                  const score = calculateScore(coin)
                  const isLowVolume = coin.total_volume < minVolume
                  const isTooNew = (coin.metrics['5m_90']?.actual_days ?? 0) < minAge
                  const netVar90 = coin.metrics['5m_90']?.net_var
                  const trend = trendLabel(coin)

                  let rowClass = 'cursor-pointer hover:bg-gray-50'
                  if (isLowVolume && isTooNew) rowClass = 'cursor-pointer bg-orange-100'
                  else if (isLowVolume)        rowClass = 'cursor-pointer bg-red-50'
                  else if (isTooNew)           rowClass = 'cursor-pointer bg-yellow-50'

                  return (
                    <tr
                      key={coin.coin_id}
                      onClick={() => setSelectedCoin(coin)}
                      className={rowClass}
                    >
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {coin.market_cap_rank}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Image
                            src={coin.image_url}
                            alt={coin.name}
                            width={24}
                            height={24}
                            className="rounded-full"
                            style={{ width: '24px', height: '24px' }}
                            onError={(e: React.SyntheticEvent<HTMLImageElement>) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {coin.symbol}
                            </div>
                            <div className="text-xs text-gray-500">
                              {coin.name}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        ${coin.current_price.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        ${(coin.market_cap / 1_000_000).toFixed(1)}M
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {m ? `${m.avg_amplitude.toFixed(3)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {m ? m.count_above_default.toFixed(1) : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-red-600">
                        {m ? `${m.max_drop.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {m ? `${m.avg_recovery_days.toFixed(1)}d` : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-900">
                        {m ? `${m.actual_days}d` : '—'}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {netVar90 !== undefined ? (
                          <span className={trend.className}>
                            {trend.emoji} {netVar90.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-gray-900">—</span>
                        )}
                      </td>
                      <td className={`px-4 py-3 text-sm font-medium ${scoreColor(score)}`}>
                        {score.toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Show all / show top 50 toggle */}
        {visibleCoins.length > 50 && (
          <div className="mt-4 text-center">
            {showAll ? (
              <button
                onClick={() => setShowAll(false)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Show top 50 only
              </button>
            ) : (
              <button
                onClick={() => setShowAll(true)}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Show all {visibleCoins.length} coins
              </button>
            )}
          </div>
        )}

      </div>

      {/* Detail modal */}
      {selectedCoin && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => setSelectedCoin(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-6 max-w-2xl w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {selectedCoin.name} ({selectedCoin.symbol})
                </h2>
                <p className="text-sm text-gray-600">
                  ${selectedCoin.current_price.toLocaleString()} • Rank #{selectedCoin.market_cap_rank} • Market Cap ${(selectedCoin.market_cap / 1_000_000).toFixed(1)}M
                </p>
              </div>
              <button
                onClick={() => setSelectedCoin(null)}
                className="text-gray-500 hover:text-gray-800 text-xl font-bold"
              >
                ✕
              </button>
            </div>

            {/* Metric selector */}
            <div className="mb-4">
              <label className="text-sm text-gray-700 mr-2 font-medium">Metric:</label>
              <select
                value={selectedMetric}
                onChange={(e) => setSelectedMetric(e.target.value as keyof MetricSet)}
                className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-900 bg-white"
              >
                <option value="count_above_default">Count/day</option>
                <option value="avg_amplitude">Avg Amplitude</option>
                <option value="max_drop">Max Drop</option>
                <option value="avg_recovery_days">Avg Recovery (days)</option>
                <option value="net_var">Net Variation</option>
                <option value="actual_days">Actual Days</option>
              </select>
            </div>

            {/* Grid */}
            <table className="w-full text-sm border border-gray-200">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-200 px-3 py-2 text-left text-gray-700">Interval</th>
                  {[1, 7, 15, 30, 90].map((days) => (
                    <th key={days} className="border border-gray-200 px-3 py-2 text-center text-gray-700">
                      {days}d
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {['5m', '10m', '20m', '30m', '1h'].map((interval) => (
                  <tr key={interval}>
                    <td className="border border-gray-200 px-3 py-2 font-medium text-gray-900">
                      {interval}
                    </td>
                    {[1, 7, 15, 30, 90].map((days) => {
                      const m = selectedCoin.metrics[`${interval}_${days}`]
                      const value = m ? (m[selectedMetric] as number) : null
                      return (
                        <td key={days} className="border border-gray-200 px-3 py-2 text-center text-gray-900">
                          {value !== null
                            ? selectedMetric === 'avg_amplitude' || selectedMetric === 'max_drop' || selectedMetric === 'net_var'
                              ? `${value.toFixed(2)}%`
                              : selectedMetric === 'avg_recovery_days'
                                ? `${value.toFixed(1)}d`
                                : value.toFixed(1)
                            : '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

//  Page wrapper ─
// useSearchParams requires a Suspense boundary in Next.js

export default function ScreenerPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    }>
      <ScreenerContent />
    </Suspense>
  )
}
