'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import type { BacktestResult } from '@/types'

interface CoinOption {
  coin_id:      string
  symbol:       string
  name:         string
  earliest:     string
  latest:       string
  days_span:    number
  candle_count: number
  limited_data: boolean
}

// Standard params used for the quick per-coin weekly scan
const STANDARD = { deviation: 2.4, max_orders: 15, tp_target: 2, multiplier: 1.3 }
const STANDARD_TOTAL_ORDERS = STANDARD.max_orders + 1
const STANDARD_MIN_CAPITAL = (Math.pow(STANDARD.multiplier, STANDARD_TOTAL_ORDERS) - 1) / (STANDARD.multiplier - 1)

export default function BacktestPage() {
  const [coins, setCoins]     = useState<CoinOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [coinId, setCoinId]       = useState('')
  const [dateFrom, setDateFrom]   = useState('')
  const [dateTo, setDateTo]       = useState('')
  const [deviation, setDeviation] = useState(2.4)
  const [maxOrders, setMaxOrders] = useState(15)
  const [tpTarget, setTpTarget]   = useState(2)
  const [multiplier, setMultiplier] = useState(1.3)
  const [capital, setCapital] = useState<number | ''>('')
  const [stopLoss, setStopLoss] = useState<number | ''>('')
  const [feeRate, setFeeRate] = useState<number | ''>(0.097)

  const [running, setRunning]     = useState(false)
  const [result, setResult]       = useState<BacktestResult | null>(null)
  const [runError, setRunError]   = useState<string | null>(null)
  const [showAllCycles, setShowAllCycles] = useState(false)

  const [weeklyResults, setWeeklyResults] = useState<BacktestResult[] | null>(null)
  const [weeklyRunning, setWeeklyRunning] = useState(false)
  const [weeklyProgress, setWeeklyProgress] = useState(0)
  const [weeklyError, setWeeklyError] = useState<string | null>(null)

  // Per-coin quick weekly scan (for dropdown)
  // undefined/missing = not started yet, null = failed, number = pnl_pct
  const [weeklyScanResults, setWeeklyScanResults] = useState<Record<string, number | null>>({})

  // Load available coins
  useEffect(() => {
    const fetchCoins = async () => {
      try {
        const res = await fetch('/api/backtest-coins')
        const data = await res.json()
        if (!data.success) throw new Error('API returned error')
        setCoins(data.coins)
        if (data.coins.length > 0) {
          const first = data.coins[0]
          setCoinId(first.coin_id)

          const latest = new Date(first.latest)
          const earliest = new Date(first.earliest)
          const sevenDaysBefore = new Date(latest.getTime() - 7 * 24 * 60 * 60 * 1000)
          const defaultFrom = sevenDaysBefore > earliest ? sevenDaysBefore : earliest

          setDateFrom(defaultFrom.toISOString().slice(0, 16))
          setDateTo(first.latest.slice(0, 16))
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }
    fetchCoins()
  }, [])

  // run a last-7-days backtest
  useEffect(() => {
    if (coins.length === 0) return

    let cancelled = false

    const scan = async () => {
      for (const coin of coins) {
        if (cancelled) return

        try {
          const latest = new Date(coin.latest)
          const earliest = new Date(coin.earliest)
          const sevenDaysBefore = new Date(latest.getTime() - 7 * 24 * 60 * 60 * 1000)
          const windowStart = sevenDaysBefore > earliest ? sevenDaysBefore : earliest

          const res = await fetch('/api/backtest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              coin_id:    coin.coin_id,
              date_from:  windowStart.toISOString(),
              date_to:    coin.latest,
              deviation:  STANDARD.deviation,
              max_orders: STANDARD.max_orders,
              tp_target:  STANDARD.tp_target,
              multiplier: STANDARD.multiplier,
              capital:    STANDARD_MIN_CAPITAL,
            }),
          })

          const data = await res.json()

          if (!cancelled) {
            setWeeklyScanResults(prev => ({
              ...prev,
              [coin.coin_id]: data.success ? data.result.total_pnl_pct : null,
            }))
          }
        } catch {
          if (!cancelled) {
            setWeeklyScanResults(prev => ({ ...prev, [coin.coin_id]: null }))
          }
        }
      }
    }

    scan()

    return () => { cancelled = true }
  }, [coins])

  // When coin changes, reset date range
  const handleCoinChange = (newCoinId: string) => {
    setCoinId(newCoinId)
    const coin = coins.find(c => c.coin_id === newCoinId)
    if (coin) {
      const latest = new Date(coin.latest)
      const earliest = new Date(coin.earliest)
      const sevenDaysBefore = new Date(latest.getTime() - 7 * 24 * 60 * 60 * 1000)
      const defaultFrom = sevenDaysBefore > earliest ? sevenDaysBefore : earliest

      setDateFrom(defaultFrom.toISOString().slice(0, 16))
      setDateTo(coin.latest.slice(0, 16))
    }
  }

  const formatScanResult = (coinId: string): string => {
    const val = weeklyScanResults[coinId]
    if (val === undefined) return '...'
    if (val === null) return 'err'
    return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`
  }

  // minimum capital calculation
  const totalOrders = maxOrders + 1
  const minCapital = multiplier === 1
    ? totalOrders  // n equal-sized orders, each >= 1 USDT -> capital >= n
    : (Math.pow(multiplier, totalOrders) - 1) / (multiplier - 1)
  const effectiveCapital = capital === '' ? 0 : capital
  const order1Size = multiplier === 1
    ? effectiveCapital / totalOrders
    : effectiveCapital * (multiplier - 1) / (Math.pow(multiplier, totalOrders) - 1)
  const capitalTooLow = effectiveCapital < minCapital

  // Run the backtest
  const runBacktest = async () => {
    if (capital === '' || capitalTooLow || !coinId) return

    setRunning(true)
    setRunError(null)
    setResult(null)
    setShowAllCycles(false)

    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coin_id:    coinId,
          date_from:  new Date(dateFrom).toISOString(),
          date_to:    new Date(dateTo).toISOString(),
          deviation,
          max_orders: maxOrders,
          tp_target:  tpTarget,
          multiplier,
          capital,
          stop_loss_pct: stopLoss === '' ? undefined : stopLoss,
          fee_rate: feeRate === '' ? undefined : feeRate / 100,
        }),
      })

      const data = await res.json()

      if (!data.success) {
        setRunError(data.error || 'Backtest failed')
        return
      }

      setResult(data.result)
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setRunning(false)
    }
  }

  // Run the weekly
  const runWeeklyBreakdown = async () => {
    if (capital === '' || capitalTooLow || !coinId || !dateTo) return

    setWeeklyRunning(true)
    setWeeklyError(null)
    setWeeklyResults(null)
    setWeeklyProgress(0)

    const anchor = new Date(dateTo)
    const results: BacktestResult[] = []

    try {
      for (let week = 0; week < 4; week++) {
        const windowEnd = new Date(anchor.getTime() - week * 7 * 24 * 60 * 60 * 1000)
        const windowStart = new Date(windowEnd.getTime() - 7 * 24 * 60 * 60 * 1000)

        setWeeklyProgress(week + 1)

        const res = await fetch('/api/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            coin_id:    coinId,
            date_from:  windowStart.toISOString(),
            date_to:    windowEnd.toISOString(),
            deviation,
            max_orders: maxOrders,
            tp_target:  tpTarget,
            multiplier,
            capital,
            stop_loss_pct: stopLoss === '' ? undefined : stopLoss,
            fee_rate: feeRate === '' ? undefined : feeRate / 100,
          }),
        })

        const data = await res.json()

        if (!data.success) {
          setWeeklyError(`Week ${week + 1}: ${data.error || 'Backtest failed'}`)
          return
        }

        results.push(data.result)
      }

      setWeeklyResults(results)
    } catch (err) {
      setWeeklyError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setWeeklyRunning(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4" />
          <p className="text-gray-500">Loading available coins...</p>
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

  const selectedCoin = coins.find(c => c.coin_id === coinId)

  // group coins for the dropdown
  const fullDataCoins    = coins.filter(c => !c.limited_data)
  const limitedDataCoins = coins.filter(c => c.limited_data)

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">

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
            DCA Bot Backtester
          </h1>
          <p className="text-gray-500 mt-1">
            Simulate a DCA bot&apos;s performance on historical 1-minute price data
          </p>
        </div>

        {/* Params form */}
        <div className="bg-white rounded-lg shadow p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Coin selector */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Coin
              </label>
              <select
                value={coinId}
                onChange={(e) => handleCoinChange(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
              >
                <optgroup label="Full history (~60 days)">
                  {fullDataCoins.map(c => (
                    <option key={c.coin_id} value={c.coin_id}>
                      {c.symbol} — {c.name} ({c.days_span}d)  •  {formatScanResult(c.coin_id)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Limited history (~6 days)">
                  {limitedDataCoins.map(c => (
                    <option key={c.coin_id} value={c.coin_id}>
                      {c.symbol} — {c.name} ({c.days_span}d)  •  {formatScanResult(c.coin_id)}
                    </option>
                  ))}
                </optgroup>
              </select>
              {selectedCoin?.limited_data && (
                <p className="text-xs text-yellow-600 mt-1">
                  Only {selectedCoin.days_span} days of data available for this coin
                </p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                P&L shown is a quick last-7-days estimate at standard params (2.4% / 15 / 2% / 1.3x,
                minimum capital). Scanning all coins — may take a minute to fully populate.
              </p>
            </div>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From
                </label>
                <input
                  type="datetime-local"
                  value={dateFrom}
                  min={selectedCoin?.earliest.slice(0, 16)}
                  max={selectedCoin?.latest.slice(0, 16)}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  To
                </label>
                <input
                  type="datetime-local"
                  value={dateTo}
                  min={selectedCoin?.earliest.slice(0, 16)}
                  max={selectedCoin?.latest.slice(0, 16)}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
                />
              </div>
            </div>

            {/* Deviation */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Price deviation per order (%)
              </label>
              <input
                type="number"
                value={deviation}
                step={0.1}
                min={0.1}
                onChange={(e) => setDeviation(Number(e.target.value))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
              />
            </div>

            {/* Max orders */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max DCA orders (additional, after the initial order)
              </label>
              <input
                type="number"
                value={maxOrders}
                step={1}
                min={1}
                max={20}
                onChange={(e) => setMaxOrders(Number(e.target.value))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
              />
            </div>

            {/* TP target */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Take-profit target (%)
              </label>
              <input
                type="number"
                value={tpTarget}
                step={0.1}
                min={0.1}
                onChange={(e) => setTpTarget(Number(e.target.value))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
              />
            </div>

            {/* Multiplier */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Order size multiplier
              </label>
              <input
                type="number"
                value={multiplier}
                step={0.01}
                min={1.01}
                onChange={(e) => setMultiplier(Number(e.target.value))}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white"
              />
            </div>

            {/* Stop loss */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Stop-loss (% below avg entry, optional)
              </label>
              <input
                type="number"
                value={stopLoss}
                placeholder="none"
                step={0.1}
                min={0}
                max={99}
                onChange={(e) => {
                  const val = e.target.value
                  setStopLoss(val === '' ? '' : Number(val))
                }}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white placeholder-gray-400"
              />
              <p className="text-xs mt-1 text-gray-500">
                If set, a cycle closes at a loss once price drops this far below average entry —
                prevents indefinite accumulation during a sustained downtrend.
              </p>
            </div>

            {/* Fee rate */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Trading fee (%, maker/taker)
              </label>
              <input
                type="number"
                value={feeRate}
                placeholder="0.097"
                step={0.001}
                min={0}
                max={5}
                onChange={(e) => {
                  const val = e.target.value
                  setFeeRate(val === '' ? '' : Number(val))
                }}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 bg-white placeholder-gray-400"
              />
              <p className="text-xs mt-1 text-gray-500">
                Used in the TP price formula (Gate Spot Martingale convention):
                TP = avg_entry × (1 + TP% + 0.1%) / (1 − fee%).
              </p>
            </div>

            {/* Capital */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total investment (USDT)
              </label>
              <input
                type="number"
                value={capital}
                placeholder={minCapital.toFixed(2)}
                step={1}
                min={0}
                onChange={(e) => {
                  const val = e.target.value
                  setCapital(val === '' ? '' : Number(val))
                }}
                className={`w-full border rounded px-3 py-2 text-sm text-gray-900 bg-white placeholder-gray-400 ${
                  capitalTooLow ? 'border-red-400' : 'border-gray-300'
                }`}
              />
              <p className={`text-xs mt-1 ${capitalTooLow ? 'text-red-600' : 'text-gray-500'}`}>
                Minimum investment for these settings: {minCapital.toFixed(2)} USDT
                {capital !== '' && ` (first order would be ${order1Size.toFixed(3)} USDT)`}
                {capitalTooLow && capital !== '' && ' — increase investment or reduce max orders/multiplier'}
              </p>
            </div>

          </div>

          {/* Run buttons */}
          <div className="mt-4 flex gap-2 flex-wrap">
            <button
              onClick={runBacktest}
              disabled={running || capital === '' || capitalTooLow || !coinId}
              className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {running ? 'Running...' : 'Run Backtest'}
            </button>
            <button
              onClick={runWeeklyBreakdown}
              disabled={weeklyRunning || capital === '' || capitalTooLow || !coinId}
              className="bg-gray-600 text-white px-6 py-2 rounded-lg hover:bg-gray-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {weeklyRunning ? `Running week ${weeklyProgress} of 4...` : 'Run Weekly Breakdown'}
            </button>
          </div>

          {runError && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">
              {runError}
            </div>
          )}

          {weeklyError && (
            <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">
              {weeklyError}
            </div>
          )}
        </div>

        {/* Weekly breakdown results */}
        {weeklyResults && (
          <div className="bg-white rounded-lg shadow p-4 mb-6">
            <h2 className="text-lg font-bold text-gray-900 mb-1">Weekly Breakdown</h2>
            <p className="text-sm text-gray-500 mb-4">
              Same parameters run independently on each of the last 4 non-overlapping 7-day
              windows, each starting fresh with {typeof capital === 'number' ? capital.toFixed(2) : ''} USDT —
              shows whether performance is consistent week to week.
            </p>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Week</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date Range</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">P&L</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">P&L %</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Cycles</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Win Rate</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Max Drawdown</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {weeklyResults.map((r, i) => (
                    <tr key={i} className={r.bot_died ? 'bg-red-50' : 'hover:bg-gray-50'}>
                      <td className="px-3 py-2 text-gray-900 font-medium">
                        Week {i + 1} {i === 0 ? '(most recent)' : ''}
                      </td>
                      <td className="px-3 py-2 text-gray-500 text-xs">
                        {new Date(r.date_from).toLocaleDateString()} – {new Date(r.date_to).toLocaleDateString()}
                      </td>
                      <td className={`px-3 py-2 font-medium ${r.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {r.total_pnl >= 0 ? '+' : ''}{r.total_pnl.toFixed(2)} USDT
                      </td>
                      <td className={`px-3 py-2 font-medium ${r.total_pnl_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {r.total_pnl_pct >= 0 ? '+' : ''}{r.total_pnl_pct.toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-gray-900">
                        {r.cycles_completed}
                        {r.cycles_stuck > 0 && <span className="text-yellow-600"> +{r.cycles_stuck} open</span>}
                        {r.cycles_stopped_out > 0 && <span className="text-red-600"> +{r.cycles_stopped_out} SL</span>}
                      </td>
                      <td className="px-3 py-2 text-gray-900">{(r.win_rate * 100).toFixed(0)}%</td>
                      <td className="px-3 py-2 text-gray-900">
                        -{r.max_drawdown.toFixed(2)} ({r.max_drawdown_pct.toFixed(1)}%)
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.bot_died && <span className="text-red-600 font-medium">Bot died</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Results summary */}
        {result && (
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-bold text-gray-900 mb-4">Results</h2>

            {/* Bot died warning */}
            {result.bot_died && (
              <div className="mb-4 bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
                <div className="font-medium mb-1">⚠ Bot ran out of capital</div>
                <div className="text-xs">
                  After accumulated losses, the remaining capital could no longer cover a valid
                  first order (below 1 USDT). The simulation stopped early — results below reflect
                  what happened up to that point.
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div className="bg-gray-50 rounded p-3">
                <div className="text-xs text-gray-500 uppercase">Total P&L</div>
                <div className={`text-xl font-bold ${result.total_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {result.total_pnl >= 0 ? '+' : ''}{result.total_pnl.toFixed(2)} USDT
                </div>
                <div className={`text-xs ${result.total_pnl_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {result.total_pnl_pct >= 0 ? '+' : ''}{result.total_pnl_pct.toFixed(1)}%
                </div>
              </div>

              <div className="bg-gray-50 rounded p-3">
                <div className="text-xs text-gray-500 uppercase">Cycles Completed</div>
                <div className="text-xl font-bold text-gray-900">{result.cycles_completed}</div>
                <div className="text-xs text-gray-500">
                  {result.cycles_stuck > 0 && `${result.cycles_stuck} still open`}
                  {result.cycles_stuck > 0 && result.cycles_stopped_out > 0 && ', '}
                  {result.cycles_stopped_out > 0 && `${result.cycles_stopped_out} stopped out`}
                  {result.cycles_stuck === 0 && result.cycles_stopped_out === 0 && 'none open'}
                </div>
              </div>

              <div className="bg-gray-50 rounded p-3">
                <div className="text-xs text-gray-500 uppercase">Win Rate</div>
                <div className="text-xl font-bold text-gray-900">
                  {(result.win_rate * 100).toFixed(1)}%
                </div>
              </div>

              <div className="bg-gray-50 rounded p-3">
                <div className="text-xs text-gray-500 uppercase">Capital</div>
                <div className="text-xl font-bold text-gray-900">
                  {result.capital_start.toFixed(2)} → {result.capital_end.toFixed(2)}
                </div>
                <div className="text-xs text-gray-500">USDT</div>
              </div>
            </div>

            {/* Max drawdown */}
            <div className="mb-4 bg-gray-50 rounded p-3 inline-block">
              <div className="text-xs text-gray-500 uppercase">Max Drawdown</div>
              <div className="text-lg font-bold text-gray-900">
                -{result.max_drawdown.toFixed(2)} USDT
                <span className="text-sm text-gray-500 ml-2">
                  (-{result.max_drawdown_pct.toFixed(1)}% from peak)
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Largest peak-to-trough drop in capital across all cycles
              </div>
            </div>

            {/* Final state */}
            {result.final_state.is_active && (
              <div className="bg-yellow-50 border border-yellow-100 rounded p-3 text-sm text-gray-700">
                <div className="font-medium text-yellow-800 mb-1">
                  Bot would currently be in an open cycle
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div>
                    <span className="text-gray-500">Orders filled:</span>{' '}
                    {result.final_state.orders_open}
                  </div>
                  <div>
                    <span className="text-gray-500">Capital locked:</span>{' '}
                    {result.final_state.capital_locked.toFixed(2)} USDT
                  </div>
                  <div>
                    <span className="text-gray-500">Avg entry:</span>{' '}
                    {result.final_state.avg_entry.toPrecision(6)}
                  </div>
                  <div>
                    <span className="text-gray-500">TP price:</span>{' '}
                    {result.final_state.tp_price.toPrecision(6)}
                  </div>
                  {result.final_state.last_order_time && (
                    <div className="col-span-2 md:col-span-4">
                      <span className="text-gray-500">Last order placed:</span>{' '}
                      {new Date(result.final_state.last_order_time).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Cumulative capital chart */}
            <div className="mt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">
                Capital over time ({result.cycles.length} cycles)
              </h3>
              <div className="h-64 bg-gray-50 rounded p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={result.cycles.map(c => ({
                      cycle: c.cycle_num,
                      capital: c.capital_after ?? 0,
                    }))}
                    margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="cycle"
                      tick={{ fontSize: 11 }}
                      label={{ value: 'Cycle #', position: 'insideBottom', offset: -2, fontSize: 11 }}
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      domain={['auto', 'auto']}
                      tickFormatter={(v) => `${v.toFixed(0)}`}
                    />
                    <Tooltip
                      formatter={(value) => [
                        `${typeof value === 'number' ? value.toFixed(2) : value} USDT`,
                        'Capital'
                      ]}
                      labelFormatter={(label) => `Cycle ${label}`}
                    />
                    <Line
                      type="monotone"
                      dataKey="capital"
                      stroke="#2563eb"
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Cycles table */}
            <div className="mt-6">
              <h3 className="text-sm font-medium text-gray-700 mb-2">
                Cycles
              </h3>
              <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border border-gray-200 rounded">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Start Price</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Orders</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Avg Entry</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">TP / Close</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Profit</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Capital After</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {(showAllCycles ? result.cycles : result.cycles.slice(0, 50)).map(c => (
                      <tr
                        key={c.cycle_num}
                        className={
                          c.status === 'open_at_end' ? 'bg-yellow-50'
                          : c.status === 'stopped_out' ? 'bg-red-50'
                          : 'hover:bg-gray-50'
                        }
                      >
                        <td className="px-3 py-2 text-gray-500">{c.cycle_num}</td>
                        <td className="px-3 py-2 text-gray-900">{c.start_price.toPrecision(6)}</td>
                        <td className="px-3 py-2 text-gray-900">{c.orders.length}</td>
                        <td className="px-3 py-2 text-gray-900">{c.avg_entry.toPrecision(6)}</td>
                        <td className="px-3 py-2 text-gray-900">
                          {c.close_price !== null ? c.close_price.toPrecision(6) : '—'}
                        </td>
                        <td className={`px-3 py-2 font-medium ${(c.profit ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {c.profit !== null ? `${c.profit >= 0 ? '+' : ''}${c.profit.toFixed(2)}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-900">
                          {c.duration_hours !== null ? `${c.duration_hours.toFixed(1)}h` : '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-900">
                          {c.capital_after !== null ? c.capital_after.toFixed(2) : '—'}
                        </td>
                        <td className="px-3 py-2">
                          {c.status === 'open_at_end' ? (
                            <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">open</span>
                          ) : c.status === 'stopped_out' ? (
                            <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">stopped out</span>
                          ) : (
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded">closed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {result.cycles.length > 50 && (
                <div className="mt-2 text-center">
                  {showAllCycles ? (
                    <button
                      onClick={() => setShowAllCycles(false)}
                      className="text-sm text-blue-600 hover:text-blue-800"
                    >
                      Show first 50 only
                    </button>
                  ) : (
                    <button
                      onClick={() => setShowAllCycles(true)}
                      className="text-sm text-blue-600 hover:text-blue-800"
                    >
                      Show all {result.cycles.length} cycles
                    </button>
                  )}
                </div>
              )}
            </div>

          </div>
        )}

      </div>
    </div>
  )
}
