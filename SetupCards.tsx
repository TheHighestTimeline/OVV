import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getCurrentBtcEvent, getEventMarkets, pickActiveMarket } from '@/lib/kalshi'
import { safeDecrypt } from '@/lib/crypto'

const BINANCE = 'https://data-api.binance.vision'

async function fetchKlines(interval: string, limit: number): Promise<number[][]> {
  try {
    const res = await fetch(
      `${BINANCE}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`,
      { next: { revalidate: 0 } }
    )
    if (!res.ok) return []
    return res.json()
  } catch { return [] }
}

async function fetchPrice(): Promise<number | null> {
  try {
    const res = await fetch(`${BINANCE}/api/v3/ticker/price?symbol=BTCUSDT`, { next: { revalidate: 0 } })
    if (!res.ok) return null
    const d = await res.json()
    return parseFloat(d.price)
  } catch { return null }
}

function calcRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gain += d; else loss -= d
  }
  let ag = gain / period, al = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    ag = (ag * (period - 1) + Math.max(d, 0)) / period
    al = (al * (period - 1) + Math.max(-d, 0)) / period
  }
  if (al === 0) return 100
  return 100 - 100 / (1 + ag / al)
}

function tfTrend(klines: number[][]): 'UP' | 'DOWN' | null {
  if (!klines || klines.length < 5) return null
  const closes = klines.map(k => parseFloat(k[4] as any))
  const r = calcRsi(closes)
  const n = closes.length
  const slopeUp = closes[n-1] > closes[n-2] && closes[n-2] > closes[n-3]
  const slopeDn = closes[n-1] < closes[n-2] && closes[n-2] < closes[n-3]
  const bull = (r !== null && r > 55 ? 1 : 0) + (slopeUp ? 1 : 0)
  const bear = (r !== null && r < 45 ? 1 : 0) + (slopeDn ? 1 : 0)
  if (bull >= 2 || (bull === 1 && bear === 0)) return 'UP'
  if (bear >= 2 || (bear === 1 && bull === 0)) return 'DOWN'
  return null
}

function calcMode4Status(
  confluenceScore: number,
  confluenceDir: 'UP' | 'DOWN' | null,
  minutesIn: number,
  minutesLeft: number,
  yesMid: number,
  noMid: number,
): 'green' | 'yellow' | 'gray' {
  const inWindow = minutesIn >= 7 && minutesIn <= 12 && minutesLeft >= 3 && minutesLeft <= 8
  const midOk    = (confluenceDir === 'UP'  && yesMid >= 0.90 && yesMid <= 0.96)
               || (confluenceDir === 'DOWN' && noMid  >= 0.90 && noMid  <= 0.96)
  const confluence = confluenceScore >= 4
  if (confluence && inWindow && midOk) return 'green'
  if (confluenceScore >= 3)            return 'yellow'
  return 'gray'
}

export async function GET() {
  const TFS    = ['1m','3m','5m','15m','30m','1h','4h'] as const
  const LIMITS: Record<string, number> = { '1m':60,'3m':30,'5m':35,'15m':25,'30m':25,'1h':25,'4h':20 }

  const [price, ...klinesArr] = await Promise.all([
    fetchPrice(),
    ...TFS.map(tf => fetchKlines(tf, LIMITS[tf]))
  ])

  const signals: Record<string, 'UP' | 'DOWN' | null> = {}
  TFS.forEach((tf, i) => { signals[tf] = tfTrend(klinesArr[i]) })

  const up = Object.values(signals).filter(v => v === 'UP').length
  const dn = Object.values(signals).filter(v => v === 'DOWN').length

  let confluenceDir: 'UP' | 'DOWN' | null = null
  let confluenceScore = Math.max(up, dn)
  if (up > dn && up >= 4) confluenceDir = 'UP'
  if (dn > up && dn >= 4) confluenceDir = 'DOWN'

  const closes1m = klinesArr[0].map(k => parseFloat(k[4] as any))
  const closes5m = klinesArr[2].map(k => parseFloat(k[4] as any))
  const rsi1m = calcRsi(closes1m)
  const rsi5m = calcRsi(closes5m)

  let contract: Record<string, any> | null = null

  try {
    const { userId } = await auth()
    if (userId) {
      const clerk = await clerkClient()
      const user  = await clerk.users.getUser(userId)
      const meta  = user.privateMetadata as Record<string, string>
      if (meta.kalshiApiKey && meta.kalshiPrivateKey) {
        const keyId  = safeDecrypt(meta.kalshiApiKey)
        const pem    = safeDecrypt(meta.kalshiPrivateKey)
        const event  = await getCurrentBtcEvent(keyId, pem)
        if (event) {
          const markets = await getEventMarkets(keyId, pem, event.event_ticker)
          const mkt     = pickActiveMarket(markets)
          if (mkt) {
            const now         = Date.now()
            const openMs      = new Date(mkt.open_time ?? event.open_time).getTime()
            const closeMs     = new Date(mkt.close_time).getTime()
            const minutesIn   = Math.max(0, (now - openMs) / 60_000)
            const minutesLeft = Math.max(0, (closeMs - now) / 60_000)
            const yesMid = (mkt.yes_bid + mkt.yes_ask) / 2 / 100
            const noMid  = (mkt.no_bid  + mkt.no_ask)  / 2 / 100
            const strike = parseFloat(mkt.ticker.split('-T')[1]?.replace('_', '.') ?? '0')
            const dist   = price != null ? price - strike : null
            contract = {
              ticker:      mkt.ticker,
              strike,
              dist:        dist != null ? parseFloat(dist.toFixed(0)) : null,
              yesMid:      parseFloat(yesMid.toFixed(3)),
              noMid:       parseFloat(noMid.toFixed(3)),
              volume:      mkt.volume ?? 0,
              minutesIn:   parseFloat(minutesIn.toFixed(1)),
              minutesLeft: parseFloat(minutesLeft.toFixed(1)),
              mode4Status: calcMode4Status(confluenceScore, confluenceDir, minutesIn, minutesLeft, yesMid, noMid),
            }
          }
        }
      }
    }
  } catch { /* Kalshi fetch failed — return signal data only */ }

  return NextResponse.json({
    ts: new Date().toISOString(),
    btcPrice: price,
    rsi1m: rsi1m !== null ? parseFloat(rsi1m.toFixed(1)) : null,
    rsi5m: rsi5m !== null ? parseFloat(rsi5m.toFixed(1)) : null,
    signals,
    confluenceDir,
    confluenceScore,
    totalTFs: TFS.length,
    contract,
  })
}
