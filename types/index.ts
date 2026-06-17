// types/index.ts
// TypeScript types and interfaces

export interface CryptoRow {
  coin_id:         string
  symbol:          string
  name:            string
  market_cap:      number
  market_cap_rank: number
  total_volume:    number
  current_price:   number
  image_url:       string
  last_updated:    Date
  exchange:        string
}

export interface OhlcvRow {
  id:        number
  coin_id:   string
  interval:  string
  open_time: Date
  open:      number
  high:      number
  low:       number
  close:     number
  volume:    number
}

export interface ComputedMetricRow {
  id:                   number
  coin_id:              string
  interval:             string
  window_days:          number
  avg_amplitude:        number
  count_above_default:  number
  avg_recovery_days:    number
  max_drop:             number
  net_var:              number
  actual_days:          number
  last_calculated:      Date
}

export interface MetricSet {
  interval:            string
  window_days:         number
  avg_amplitude:       number
  count_above_default: number
  avg_recovery_days:   number
  max_drop:            number
  net_var:             number
  actual_days:         number
}

export interface ScreenerCrypto {
  coin_id:         string
  symbol:          string
  name:            string
  image_url:       string
  current_price:   number
  market_cap_rank: number
  market_cap:      number
  total_volume:    number
  metrics: { [interval: string]: MetricSet }
  score?: number
}

export interface CalculateParams {
  thresholds: {
    '5m':  number
    '10m': number
    '20m': number
    '30m': number
    '1h':  number
  }
  window_days:       number
  recovery_tolerance: number
}

export interface BacktestParams {
  coin_id:    string
  date_from:  string   // "2026-06-01"
  date_to:    string   // "2026-06-08"
  deviation:  number   // 2.4
  max_orders: number   // 15
  tp_target:  number   // 2.0
  multiplier: number   // 1.3
  capital:    number   // 250
  stop_loss_pct?: number
  fee_rate?:  number
}

export interface BacktestOrder {
  order_num:   number
  price:       number
  amount:      number
  timestamp:   string
}

export interface BacktestCycle {
  cycle_num:      number
  start_price:    number
  orders:         BacktestOrder[]
  avg_entry:      number
  tp_price:       number
  close_price:    number | null
  profit:         number | null
  duration_hours: number | null
  status:         'closed' | 'open_at_end' | 'stopped_out'
  capital_after:  number | null
}

export interface BacktestResult {
  coin_id:          string
  date_from:        string
  date_to:          string
  params:           BacktestParams
  total_pnl:        number
  total_pnl_pct:    number
  capital_start:    number
  capital_end:      number
  cycles_completed: number
  cycles_stuck:     number
  cycles_stopped_out: number
  win_rate:         number
  max_capital_used: number
  max_drawdown:     number
  max_drawdown_pct: number
  bot_died:         boolean
  cycles:           BacktestCycle[]
  final_state: {
    is_active:        boolean
    orders_open:      number
    capital_locked:   number
    avg_entry:        number
    tp_price:         number
    next_buy_prices:  number[]
    last_order_time:  string | null
  }
}
