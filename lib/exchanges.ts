// lib/exchanges.ts
import { CryptoRow, OhlcvRow } from '../types'

const BINANCE_API = 'https://api.binance.com/api/v3'
const COINGECKO_API = 'https://api.coingecko.com/api/v3'

type BinanceCandle = [
  number, string, string, string, string,
  string, number, string, number, string, string, string
]

const STABLECOINS = new Set([
  'usdt', 'usdc', 'busd', 'dai', 'tusd', 'usdp',
  'usdd', 'gusd', 'frax', 'lusd', 'susd', 'usds', 'pyusd', 'usdg', 'usde'
])

export async function fetchTopCoins(limit: number = 800): Promise<CryptoRow[]> {
  const coins: CryptoRow[] = []
  const perPage = 250
  const pages = Math.ceil(limit / perPage)

  for (let page = 1; page <= pages; page++) {
    const url = `${COINGECKO_API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}`
    const response = await fetch(url)

    if (!response.ok) {
      console.error(`CoinGecko error on page ${page}: ${response.status}`)
      break
    }

    const data = await response.json()

    for (const coin of data) {
      if (STABLECOINS.has(coin.symbol.toLowerCase())) continue

      coins.push({
        coin_id:         coin.id,
        symbol:          coin.symbol.toUpperCase(),
        name:            coin.name,
        market_cap:      coin.market_cap,
        market_cap_rank: coin.market_cap_rank,
        total_volume:    coin.total_volume,
        current_price:   coin.current_price,
        image_url:       coin.image,
        last_updated:    new Date(),
        exchange:        'binance',
      })
    }

    if (page < pages) await sleep(1000)
  }

  return coins.slice(0, limit)
}

export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number = 1000,
  startTime?: number   // optional unix timestamp in milliseconds
): Promise<OhlcvRow[]> {
  let url = `${BINANCE_API}/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`

  if (startTime) {
    url += `&startTime=${startTime}`
  }

  const response = await fetch(url)

  if (!response.ok) {
    console.error(`Binance error for ${symbol} ${interval}: ${response.status}`)
    return []
  }

  const data = await response.json()

  return data.map((candle: BinanceCandle) => ({
    id:        0,
    coin_id:   symbol,
    interval:  interval,
    open_time: new Date(candle[0]),
    open:      parseFloat(candle[1]),
    high:      parseFloat(candle[2]),
    low:       parseFloat(candle[3]),
    close:     parseFloat(candle[4]),
    volume:    parseFloat(candle[7]),
  }))
}

// ─── Gate.io fallback ─────────────────────────────────────
// Used when a coin doesn't trade on Binance

type GateCandle = [
  string, // [0] timestamp in seconds
  string, // [1] quote volume (USDT)
  string, // [2] close
  string, // [3] high
  string, // [4] low
  string, // [5] open
  string, // [6] base volume (coin)
  string  // [7] is_closed
]

const GATE_API = 'https://api.gateio.ws/api/v4'

export async function fetchCandlesGate(
  symbol: string,   // e.g. "SOL" → we build "SOL_USDT"
  interval: string, // e.g. "5m" — Gate.io uses same format
  limit: number = 1000,
  startTime?: number  // unix timestamp in milliseconds
): Promise<OhlcvRow[]> {
  let url = `${GATE_API}/spot/candlesticks?currency_pair=${symbol}_USDT&interval=${interval}&limit=${limit}`

  if (startTime) {
    // Gate.io uses seconds not milliseconds
    url += `&from=${Math.floor(startTime / 1000)}`
  }

  const response = await fetch(url)

  if (!response.ok) {
    return []
  }

  const data = await response.json()

  return data.map((candle: GateCandle) => ({
    id:        0,
    coin_id:   symbol,
    interval:  interval,
    open_time: new Date(parseInt(candle[0]) * 1000), // seconds → ms
    open:      parseFloat(candle[5]),
    high:      parseFloat(candle[3]),
    low:       parseFloat(candle[4]),
    close:     parseFloat(candle[2]),
    volume:    parseFloat(candle[1]), // USDT volume
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── KuCoin fallback ──────────────────────────────────────
// Often has deeper 1m history than Gate.io for smaller-cap coins

type KucoinCandle = [string, string, string, string, string, string, string]
// [timestamp_sec, open, close, high, low, volume, turnover]

const KUCOIN_API = 'https://api.kucoin.com/api/v1'

export async function fetchCandlesKucoin(
  symbol: string,
  interval: string,  // e.g. "1min" — KuCoin format differs from Binance/Gate
  limit: number = 1000,
  startTime?: number  // unix timestamp in milliseconds
): Promise<OhlcvRow[]> {
  let url = `${KUCOIN_API}/market/candles?type=${interval}&symbol=${symbol}-USDT`

  if (startTime) {
    const startSec = Math.floor(startTime / 1000)
    const endSec = startSec + (limit * 60)  // limit candles × 60s each
    url += `&startAt=${startSec}&endAt=${endSec}`
  }

  const response = await fetch(url)

  if (!response.ok) {
    return []
  }

  const data = await response.json()

  if (data.code !== '200000' || !Array.isArray(data.data)) {
    return []
  }

  const candles: KucoinCandle[] = data.data

  return candles.map((candle) => ({
    id:        0,
    coin_id:   symbol,
    interval:  interval,
    open_time: new Date(parseInt(candle[0]) * 1000),
    open:      parseFloat(candle[1]),
    high:      parseFloat(candle[3]),
    low:       parseFloat(candle[4]),
    close:     parseFloat(candle[2]),
    volume:    parseFloat(candle[5]),
  })).reverse()  // KuCoin returns newest-first; we want oldest-first
}
