'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useUser, UserButton } from '@clerk/nextjs'
import BTCChart           from '@/components/BTCChart'
import StatsCards         from '@/components/StatsCards'
import TradeTable         from '@/components/TradeTable'
import Modal              from '@/components/Modal'
import SetupCards, { KalshiReconnectCard } from '@/components/SetupCards'
import BacktestDashboard  from '@/components/BacktestDashboard'
import SettingsModal      from '@/components/SettingsModal'
import ScanSnapshot       from '@/components/ScanSnapshot'

type BotStatus = 'idle' | 'running' | 'starting' | 'stopping'
type ActiveTab = 'live' | 'backtest'

export default function DashboardPage() {
  const { isLoaded } = useUser()
  const [activeTab, setActiveTab] = useState<ActiveTab>('live')

  const [kalshiKeySet,    setKalshiKeySet]    = useState(false)
  const [kalshiPemSet,    setKalshiPemSet]    = useState(false)
  const [githubConnected, setGithubConnected] = useState(false)
  const [githubUsername,  setGithubUsername]  = useState<string | null>(null)
  const [githubRepo,      setGithubRepo]      = useState<string | null>(null)
  const [setupLoading,    setSetupLoading]    = useState(true)
  const [showReconnect,   setShowReconnect]   = useState(false)

  const [portfolio,   setPortfolio]   = useState<any>(null)
  const [positions,   setPositions]   = useState<any[]>([])
  const [settlements, setSettlements] = useState<any[]>([])
  const [dataLoading, setDataLoading] = useState(true)
  const [dataError,   setDataError]   = useState<string | null>(null)

  const [botStatus, setBotStatus] = useState<BotStatus>('idle')
  const [modal,     setModal]     = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ---- derived gates ----------------------------------------------------
  // kalshiReady → user can see live data (balance, positions, scanner)
  // botReady    → user can also dispatch the GitHub Actions bot
  const kalshiReady = kalshiKeySet && kalshiPemSet
  const botReady    = kalshiReady && githubConnected
  // -----------------------------------------------------------------------

  const fetchBotStatus = useCallback(async () => {
    try {
      const res  = await fetch('/api/bot/status')
      if (!res.ok) return
      const data = await res.json()
      setBotStatus(prev => {
        if (prev === 'starting' || prev === 'stopping') return prev
        return (data.status as BotStatus) ?? 'idle'
      })
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!botReady) return
    fetchBotStatus()
    statusPollRef.current = setInterval(fetchBotStatus, 30_000)
    return () => { if (statusPollRef.current !== null) clearInterval(statusPollRef.current) }
  }, [fetchBotStatus, botReady])

  const fetchSetup = useCallback(async () => {
    try {
      const res  = await fetch('/api/user')
      const data = await res.json()
      setKalshiKeySet(!!data.kalshiKeySet)
      setKalshiPemSet(!!data.kalshiPemSet)
      setGithubConnected(!!data.githubConnected)
      setGithubUsername(data.githubUsername ?? null)
      setGithubRepo(data.githubRepo ?? null)
    } finally {
      setSetupLoading(false)
    }
  }, [])

  useEffect(() => { fetchSetup() }, [fetchSetup])

  const fetchAll = useCallback(async () => {
    if (!kalshiReady) return
    setDataError(null)
    try {
      const [portRes, posRes, settRes] = await Promise.all([
        fetch('/api/kalshi/portfolio'),
        fetch('/api/kalshi/positions'),
        fetch('/api/kalshi/settlements'),
      ])
      // Surface portfolio errors so the user can see what's wrong instead
      // of silently looking at $0.00 forever.
      if (portRes.ok) {
        setPortfolio(await portRes.json())
      } else {
        const errBody = await portRes.json().catch(() => ({}))
        setDataError(errBody.error || `Kalshi portfolio fetch failed (HTTP ${portRes.status})`)
      }
      if (posRes.ok)  setPositions((await posRes.json()).positions ?? [])
      if (settRes.ok) setSettlements((await settRes.json()).settlements ?? [])
    } catch (err: any) {
      setDataError(err.message || 'Unknown fetch error')
    } finally {
      setDataLoading(false)
    }
  }, [kalshiReady])

  useEffect(() => {
    if (!kalshiReady) { setDataLoading(false); return }
    fetchAll()
    pollRef.current = setInterval(fetchAll, 30_000)
    return () => { if (pollRef.current !== null) clearInterval(pollRef.current) }
  }, [fetchAll, kalshiReady])

  const handleStart = async () => {
    setBotStatus('starting')
    try {
      const res  = await fetch('/api/bot/start', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const bal = data.balance != null ? ` Portfolio: $${data.balance.toFixed(2)}.` : ''
      setModal({ type: 'success', message: `Bot started!${bal} Happy trading!` })
      setBotStatus('running')
      fetchAll()
      setTimeout(fetchBotStatus, 5_000)
    } catch (err: any) {
      setModal({ type: 'error', message: err.message || 'Failed to start bot.' })
      setBotStatus('idle')
    }
  }

  const handleStop = async () => {
    setBotStatus('stopping')
    try {
      const res  = await fetch('/api/bot/stop', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setModal({ type: 'success', message: 'Bot stopped. No new trades will be placed.' })
      setBotStatus('idle')
      setTimeout(fetchBotStatus, 5_000)
    } catch (err: any) {
      setModal({ type: 'error', message: err.message || 'Failed to stop bot.' })
      setBotStatus('running')
    }
  }

  const currentBalance  = portfolio?.available_balance ?? 0
  const startingBalance = 50
  const profitPct       = currentBalance > 0 && startingBalance > 0
    ? (((currentBalance - startingBalance) / startingBalance) * 100).toFixed(1)
    : '0.0'
  const totalPnl = Number(currentBalance) - startingBalance

  const settleWins   = settlements.filter(s => (s.revenue ?? 0) > 0).length
  const settleLosses = settlements.length - settleWins
  const winRate      = settlements.length > 0
    ? ((settleWins / settlements.length) * 100).toFixed(1)
    : '0.0'

  const statusColor = {
    idle:     'text-gray-500',
    running:  'text-[#00d17a]',
    starting: 'text-[#f5c842]',
    stopping: 'text-[#ff4d6d]',
  }[botStatus]

  const statusLabel = {
    idle:     '○ IDLE',
    running:  '● LIVE',
    starting: '◌ STARTING',
    stopping: '◌ STOPPING',
  }[botStatus]

  if (!isLoaded || setupLoading) {
    return (
      <div className="min-h-screen bg-[#0a0b0d] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#00d17a] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0b0d]">

      <nav className="border-b border-[#252c3a] bg-[#111318]/90 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-[#00d17a] rounded-md flex items-center justify-center">
              <svg className="w-4 h-4 text-[#0a0b0d]" fill="currentColor" viewBox="0 0 20 20">
                <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/>
              </svg>
            </div>
            <span className="font-bold text-white text-sm">KalshiBot</span>
            {kalshiReady && (
              <span className={`text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-[#1e2330] ${statusColor}`}>
                {statusLabel}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {kalshiReady && (
              <>
                <button
                  onClick={() => setShowReconnect(v => !v)}
                  className="btn-secondary text-xs py-1.5 px-3"
                  title="Update Kalshi API credentials"
                >
                  ⚙ API Keys
                </button>
                <button onClick={fetchAll} className="btn-secondary text-xs py-1.5 px-3">
                  &#8635; Refresh
                </button>
              </>
            )}
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </div>
      </nav>

      <div className="border-b border-[#252c3a] bg-[#111318]/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1 pt-1">
          <button
            onClick={() => setActiveTab('live')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all ${
              activeTab === 'live' ? 'border-[#00d17a] text-[#00d17a]' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            &#9679; Live
          </button>
          <button
            onClick={() => setActiveTab('backtest')}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all ${
              activeTab === 'backtest' ? 'border-[#00d17a] text-[#00d17a]' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            &#9650; Backtest
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">

        {activeTab === 'backtest' && <BacktestDashboard />}

        {activeTab === 'live' && (
          <>
            {/* Reconnect panel — Kalshi-only inline card (kept for the
                quick first-touch reconnect that the live page surfaces). */}
            {showReconnect && kalshiReady && (
              <KalshiReconnectCard onSaved={() => { fetchSetup(); fetchAll() }} />
            )}

            {!kalshiReady && (
              <>
                <div className="mb-2">
                  <h2 className="text-white font-semibold text-lg">Welcome to KalshiBot</h2>
                  <p className="text-gray-400 text-sm mt-1">Add your Kalshi credentials to see live data. GitHub is only needed to run the trading bot.</p>
                </div>
                <SetupCards
                  kalshiKeySet={kalshiKeySet}
                  kalshiPemSet={kalshiPemSet}
                  githubConnected={githubConnected}
                  onKalshiSaved={() => { fetchSetup(); fetchAll() }}
                  onGitHubSaved={() => { fetchSetup() }}
                />
              </>
            )}

            {kalshiReady && (
              <>
                {dataError && (
                  <div className="card border-[#ff4d6d]/40 bg-[#ff4d6d]/5">
                    <div className="flex items-start gap-3">
                      <div className="text-[#ff4d6d] text-lg leading-none mt-0.5">!</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[#ff4d6d] font-semibold text-sm">Kalshi API call failed</p>
                        <p className="text-gray-400 text-xs mt-1 font-mono break-words">{dataError}</p>
                        <p className="text-gray-500 text-xs mt-2">
                          This usually means the saved key+PEM don&apos;t match, or the PEM was pasted with missing line breaks.
                          Click <span className="text-white">⚙ API Keys</span> above to re-paste them.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <StatsCards
                  currentBalance={currentBalance}
                  startingBalance={startingBalance}
                  profitPct={profitPct}
                  winRate={winRate}
                  totalTrades={settlements.length}
                  wins={settleWins}
                  losses={settleLosses}
                  totalPnl={totalPnl}
                  loading={dataLoading}
                />

                {!githubConnected ? (
                  <div className="card border-[#f5c842]/30 bg-[#f5c842]/5">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <div>
                        <h3 className="font-semibold text-white">Connect GitHub to enable bot trading</h3>
                        <p className="text-gray-400 text-sm mt-0.5">
                          Live Kalshi data above is working. To <em>run</em> the trading bot, connect a GitHub account
                          with a fork of the bot repo &mdash; the bot runs as a GitHub Actions workflow.
                        </p>
                      </div>
                      <a href="/setup" className="btn-primary shrink-0">Connect GitHub →</a>
                    </div>
                  </div>
                ) : (
                  <div className="card flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-white">Bot Control</h3>
                      <p className="text-gray-400 text-sm mt-0.5">
                        {botStatus === 'running'
                          ? 'The bot is actively trading on Kalshi markets.'
                          : botStatus === 'starting'
                          ? 'Connecting to GitHub and verifying Kalshi credentials...'
                          : 'Start the bot to begin automated BTC/RSI trading.'}
                      </p>
                    </div>
                    <div className="flex gap-3 shrink-0">
                      <button onClick={handleStart} disabled={botStatus !== 'idle'} className="btn-primary min-w-[130px]">
                        {botStatus === 'starting' ? (
                          <>
                            <span className="w-4 h-4 border-2 border-[#0a0b0d] border-t-transparent rounded-full animate-spin" />
                            Starting...
                          </>
                        ) : '▶  Start Bot'}
                      </button>
                      <button onClick={handleStop} disabled={botStatus !== 'running'} className="btn-danger min-w-[110px]">
                        {botStatus === 'stopping' ? 'Stopping...' : '■  Stop Bot'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-white">
                      BTC / USD <span className="text-gray-600 font-normal text-sm">&mdash; 15 min</span>
                    </h3>
                    <span className="text-gray-500 text-xs">Live via TradingView</span>
                  </div>
                  <BTCChart />
                </div>

                <ScanSnapshot />

                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-white">
                      Open Positions
                      <span className="ml-2 badge-blue">{positions.length}</span>
                    </h3>
                    <span className="text-gray-500 text-xs">Refreshes every 30s</span>
                  </div>
                  {dataLoading ? (
                    <div className="h-20 flex items-center justify-center text-gray-500 text-sm animate-pulse">Loading positions...</div>
                  ) : positions.length === 0 ? (
                    <div className="h-20 flex items-center justify-center text-gray-600 text-sm">No open positions right now.</div>
                  ) : (
                    <TradeTable trades={positions} type="open" />
                  )}
                </div>

                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-white">
                      Trade History
                      <span className="ml-2 badge-yellow">{settlements.length}</span>
                    </h3>
                  </div>
                  {dataLoading ? (
                    <div className="h-20 flex items-center justify-center text-gray-500 text-sm animate-pulse">Loading history...</div>
                  ) : settlements.length === 0 ? (
                    <div className="h-20 flex items-center justify-center text-gray-600 text-sm">No completed trades yet.</div>
                  ) : (
                    <TradeTable trades={settlements} type="closed" />
                  )}
                </div>

                <p className="text-center text-gray-700 text-xs pb-6">
                  Past performance does not guarantee future results. Not financial advice.
                </p>
              </>
            )}
          </>
        )}

      </div>

      {showReconnect && (
        <SettingsModal
          kalshiKeySet={kalshiKeySet}
          githubConnected={githubConnected}
          githubUsername={githubUsername}
          githubRepo={githubRepo}
          onClose={() => setShowReconnect(false)}
          onSaved={() => { fetchSetup(); fetchAll() }}
        />
      )}
      {modal && <Modal type={modal.type} message={modal.message} onClose={() => setModal(null)} />}
    </div>
  )
}
