import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-2">
          Crypto Analyzer
        </h1>
        <p className="text-gray-500 mb-8">
          Volatility screener + DCA backtester
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/screener"
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Open Screener
          </Link>
          <Link
            href="/backtest"
            className="bg-gray-200 text-gray-700 px-6 py-3 rounded-lg hover:bg-gray-300 transition-colors"
          >
            Backtester
          </Link>
        </div>
      </div>
    </main>
  )
}
