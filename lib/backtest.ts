// lib/backtest.ts
// Pure DCA bot cycle simulator — no DB, no API calls.
// Walks through 1m candles chronologically and simulates
// the bot's behavior per the rules derived from the live
// Gate.io bot screenshots.
//
// Capital compounds: profit from each closed cycle is added
// to the capital base used to size the NEXT cycle's orders.
//
// "max_orders" follows Gate's convention: it's the number of
// ADDITIONAL DCA orders after the initial order. Total orders
// per cycle = max_orders + 1.

import type { OhlcvRow, BacktestParams, BacktestCycle, BacktestOrder, BacktestResult } from '@/types'

// ── Order 1 size from capital ──────────────────────────────
// capital = order1 * (1 + mult + mult^2 + ... + mult^(n-1))
//         = order1 * (mult^n - 1)/(mult - 1)   for mult != 1
//         = order1 * n                          for mult == 1
function computeOrder1Size(capital: number, multiplier: number, totalOrders: number): number {
  if (multiplier === 1) {
    return capital / totalOrders
  }
  return capital * (multiplier - 1) / (Math.pow(multiplier, totalOrders) - 1)
}

export function runBacktest(
  candles: OhlcvRow[],
  params: BacktestParams
): BacktestResult {
  const { deviation, max_orders, tp_target, multiplier, capital } = params

  // ── Total orders per cycle = 1 initial + max_orders DCA orders ──
  const totalOrders = max_orders + 1

  // ── Compounding capital state ───────────────────────────
  // order1Size is recalculated at the start of every cycle
  // from currentCapital, so profits/losses feed forward.
  let currentCapital = capital
  let order1Size = computeOrder1Size(currentCapital, multiplier, totalOrders)

  const cycles: BacktestCycle[] = []

  // ── Current cycle state ──────────────────────────────────
  let cycleNum = 1
  let orders: BacktestOrder[] = []
  let nextTriggerPrice = 0   // price at which the NEXT order fills
  let avgEntry = 0
  let tpPrice = 0
  let cycleStartPrice = 0
  let cycleStartTime = ''

  // start a new cycle, recomputing order1Size from currentCapital
  function startNewCycle(price: number, timestamp: string) {
    cycleStartPrice = price
    cycleStartTime = timestamp

    order1Size = computeOrder1Size(currentCapital, multiplier, totalOrders)

    const amount = order1Size / price

    orders = [{
      order_num: 1,
      price,
      amount,
      timestamp,
    }]

    avgEntry = price
    tpPrice = avgEntry * (1 + tp_target / 100)
    nextTriggerPrice = price * (1 - deviation / 100)
  }

  if (candles.length === 0) {
    throw new Error('No candles provided')
  }

  startNewCycle(candles[0].open, candles[0].open_time.toISOString())

  for (let idx = 0; idx < candles.length; idx++) {
    const candle = candles[idx]

    // ── Step 1: fill any pending DCA orders (price moved down) ──
    while (
      orders.length < totalOrders &&
      candle.low <= nextTriggerPrice
    ) {
      const orderNum = orders.length + 1
      const fillPrice = nextTriggerPrice
      const amount = (order1Size * Math.pow(multiplier, orderNum - 1)) / fillPrice

      orders.push({
        order_num: orderNum,
        price:     fillPrice,
        amount,
        timestamp: candle.open_time.toISOString(),
      })

      // recalculate avg entry and TP
      const totalCost = orders.reduce((sum, o) => sum + o.price * o.amount, 0)
      const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0)
      avgEntry = totalCost / totalAmount
      tpPrice = avgEntry * (1 + tp_target / 100)

      // next trigger is based on THIS order's fill price
      nextTriggerPrice = fillPrice * (1 - deviation / 100)
    }

    // ── Step 2: check take-profit (price moved up) ──────────
    if (candle.high >= tpPrice) {
      const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0)
      const totalCost   = orders.reduce((sum, o) => sum + o.price * o.amount, 0)
      const proceeds    = totalAmount * tpPrice
      const profit      = proceeds - totalCost
      const durationHours =
        (candle.open_time.getTime() - new Date(cycleStartTime).getTime()) / (1000 * 60 * 60)

      // ── Compound: profit feeds into capital for next cycle ──
      currentCapital += profit

      cycles.push({
        cycle_num:      cycleNum,
        start_price:    cycleStartPrice,
        orders:         [...orders],
        avg_entry:      avgEntry,
        tp_price:       tpPrice,
        close_price:    tpPrice,
        profit,
        duration_hours: durationHours,
        status:         'closed',
        capital_after:  currentCapital,
      })

      cycleNum++

      // start next cycle at this candle's close price —
      // the bot sold (TP) sometime during this minute, and
      // re-buys at the price by the end of that same minute
      startNewCycle(candle.close, candle.open_time.toISOString())
    }
  }

  // ── Handle a cycle still open at the end of the period ────
  let finalState: BacktestResult['final_state']

  if (orders.length > 0 && (cycles.length === 0 || cycles[cycles.length - 1].status !== 'closed' || cycleNum > cycles.length)) {
    const lastCandle = candles[candles.length - 1]
    const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0)
    const totalCost   = orders.reduce((sum, o) => sum + o.price * o.amount, 0)
    const proceeds    = totalAmount * lastCandle.close
    const profit      = proceeds - totalCost
    const durationHours =
      (lastCandle.open_time.getTime() - new Date(cycleStartTime).getTime()) / (1000 * 60 * 60)

    cycles.push({
      cycle_num:      cycleNum,
      start_price:    cycleStartPrice,
      orders:         [...orders],
      avg_entry:      avgEntry,
      tp_price:       tpPrice,
      close_price:    lastCandle.close,
      profit,
      duration_hours: durationHours,
      status:         'open_at_end',  // not "stuck" — just ran out of data
      capital_after:  currentCapital + profit,  // hypothetical if sold now
    })

    // next buy trigger prices for the open cycle
    const nextBuyPrices: number[] = []
    let price = nextTriggerPrice
    for (let n = orders.length + 1; n <= totalOrders && nextBuyPrices.length < 12; n++) {
      nextBuyPrices.push(price)
      price = price * (1 - deviation / 100)
    }

    finalState = {
      is_active:       true,
      orders_open:     orders.length,
      capital_locked:  totalCost,
      avg_entry:       avgEntry,
      tp_price:        tpPrice,
      next_buy_prices: nextBuyPrices,
      last_order_time: orders[orders.length - 1].timestamp,
    }
  } else {
    finalState = {
      is_active:       false,
      orders_open:     0,
      capital_locked:  0,
      avg_entry:       0,
      tp_price:        0,
      next_buy_prices: [],
      last_order_time: null,
    }
  }

  // ── Summary stats ──────────────────────────────────────
  const cyclesCompleted = cycles.filter(c => c.status === 'closed').length
  const cyclesStuck     = cycles.filter(c => c.status === 'open_at_end').length
  const wins            = cycles.filter(c => (c.profit ?? 0) > 0).length
  const winRate         = cycles.length > 0 ? wins / cycles.length : 0

  const totalPnl = cycles.reduce((sum, c) => sum + (c.profit ?? 0), 0)
  const totalPnlPct = (totalPnl / capital) * 100

  const maxCapitalUsed = Math.max(
    ...cycles.map(c =>
      c.orders.reduce((sum, o) => sum + o.price * o.amount, 0)
    ),
    0
  )

  return {
    coin_id:    '',  // filled in by the API route
    date_from:  candles[0].open_time.toISOString(),
    date_to:    candles[candles.length - 1].open_time.toISOString(),
    params,
    total_pnl:        totalPnl,
    total_pnl_pct:    totalPnlPct,
    capital_start:    capital,
    capital_end:      currentCapital,  // reflects compounding
    cycles_completed: cyclesCompleted,
    cycles_stuck:     cyclesStuck,
    win_rate:         winRate,
    max_capital_used: maxCapitalUsed,
    cycles,
    final_state: finalState,
  }
}
