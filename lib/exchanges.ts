// lib/exchanges.ts
import { CryptoRow, OhlcvRow } from '../types'
import pool from './db'

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
  startTime?: number
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

// Gate.io fallback
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
  symbol: string,
  interval: string,
  limit: number = 1000,
  startTime?: number
): Promise<OhlcvRow[]> {
  let url = `${GATE_API}/spot/candlesticks?currency_pair=${symbol}_USDT&interval=${interval}&limit=${limit}`

  if (startTime) {
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
    open_time: new Date(parseInt(candle[0]) * 1000),
    open:      parseFloat(candle[5]),
    high:      parseFloat(candle[3]),
    low:       parseFloat(candle[4]),
    close:     parseFloat(candle[2]),
    volume:    parseFloat(candle[1]),
  }))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── KuCoin fallback ─
type KucoinCandle = [string, string, string, string, string, string, string]
// [timestamp_sec, open, close, high, low, volume, turnover]

const KUCOIN_API = 'https://api.kucoin.com/api/v1'

export async function fetchCandlesKucoin(
  symbol: string,
  interval: string,
  limit: number = 1000,
  startTime?: number,
): Promise<OhlcvRow[]> {
  let url = `${KUCOIN_API}/market/candles?type=${interval}&symbol=${symbol}-USDT`

  if (startTime) {
    const startSec = Math.floor(startTime / 1000)
    const endSec = startSec + (limit * 60)
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
  })).reverse()
}

export async function backfillCandles(
  coin_id: string,
  symbol: string,
  days: number = 90
): Promise<number> {
  const CANDLES_PER_DAY = 288
  const TOTAL_CANDLES = days * CANDLES_PER_DAY
  const PER_REQUEST = 1000

  const testCandles = await fetchCandles(symbol, '5m', 1)
  const useBinance = testCandles.length > 0

  if (!useBinance) {
    const testGate = await fetchCandlesGate(symbol, '5m', 1)
    if (testGate.length === 0) {
      console.log(`${symbol}: not found on Binance or Gate.io, skipping`)
      return 0
    }
    await pool.query(`UPDATE cryptos SET exchange = 'gate' WHERE coin_id = $1`, [coin_id])
  }

  let inserted = 0
  const now = Date.now()
  const requests = Math.ceil(TOTAL_CANDLES / PER_REQUEST)

  for (let i = 0; i < requests; i++) {
    const startTime = now - ((i + 1) * PER_REQUEST * 5 * 60 * 1000)

    const candles = useBinance
      ? await fetchCandles(symbol, '5m', PER_REQUEST, startTime)
      : await fetchCandlesGate(symbol, '5m', PER_REQUEST, startTime)

    if (candles.length === 0) continue

    const values: (string | number | Date)[] = []
    const placeholders: string[] = []

    candles.forEach((candle, idx) => {
      const base = idx * 8
      placeholders.push(
        `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`
      )
      values.push(
        coin_id, '5m', candle.open_time,
        candle.open, candle.high, candle.low,
        candle.close, candle.volume,
      )
    })

    await pool.query(`
      INSERT INTO ohlcv_data
        (coin_id, interval, open_time, open, high, low, close, volume)
      VALUES ${placeholders.join(',')}
      ON CONFLICT (coin_id, interval, open_time) DO NOTHING
    `, values)

    inserted += candles.length
    await sleep(200)
  }

  return inserted
}

// Probe whether 1m data actually exists this far back
export async function has1mDepth(
  symbol: string,
  exchange: string,
  days: number = 30
): Promise<boolean> {
  const targetTime = Date.now() - days * 24 * 60 * 60 * 1000
  const TOLERANCE_MS = 24 * 60 * 60 * 1000
  const useBinance = exchange !== 'gate'

  let candles = await fetchCandlesKucoin(symbol, '1min', 5, targetTime)
  if (candles.length === 0) {
    candles = useBinance
      ? await fetchCandles(symbol, '1m', 5, targetTime)
      : await fetchCandlesGate(symbol, '1m', 5, targetTime)
  }

  if (candles.length === 0) return false

  const earliest = candles[0].open_time.getTime()
  return earliest <= targetTime + TOLERANCE_MS
}

// Shared insert helper for ohlcv_1m
export async function insert1mCandles(coin_id: string, candles: OhlcvRow[]): Promise<number> {
  const values: (string | number | Date)[] = []
  const placeholders: string[] = []

  candles.forEach((candle, idx) => {
    const base = idx * 7
    placeholders.push(
      `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`
    )
    values.push(
      coin_id, candle.open_time,
      candle.open, candle.high, candle.low,
      candle.close, candle.volume,
    )
  })

  await pool.query(`
    INSERT INTO ohlcv_1m (coin_id, open_time, open, high, low, close, volume)
    VALUES ${placeholders.join(',')}
    ON CONFLICT (coin_id, open_time) DO NOTHING
  `, values)

  return candles.length
}

// Full N-day backfill for one coin's 1m candles
export async function backfill1mCandles(
  coin_id: string,
  symbol: string,
  exchange: string,
  days: number = 60
): Promise<number> {
  const TOTAL_CANDLES = days * 1440
  const PER_REQUEST = 1000
  const useBinance = exchange !== 'gate'
  const now = Date.now()
  const requests = Math.ceil(TOTAL_CANDLES / PER_REQUEST)

  let inserted = 0
  for (let i = 0; i < requests; i++) {
    const startTime = now - ((i + 1) * PER_REQUEST * 60 * 1000)

    let candles = await fetchCandlesKucoin(symbol, '1min', PER_REQUEST, startTime)
    if (candles.length === 0) {
      candles = useBinance
        ? await fetchCandles(symbol, '1m', PER_REQUEST, startTime)
        : await fetchCandlesGate(symbol, '1m', PER_REQUEST, startTime)
    }
    if (candles.length === 0) {
      await sleep(150)
      continue
    }

    inserted += await insert1mCandles(coin_id, candles)
    await sleep(150)
  }

  return inserted
}
