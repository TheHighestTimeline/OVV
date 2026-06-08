import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { checkCsrf } from '@/lib/csrf'
import { dispatchBotWorkflow, pushBotSecrets, validatePatForRepo } from '@/lib/github'
import { getPortfolioBalance } from '@/lib/kalshi'
import { safeDecrypt } from '@/lib/crypto'

/**
 * POST /api/bot/start
 *
 * Pre-flight:
 *   1. Validate the user has Kalshi creds + a connected GitHub repo.
 *   2. Push the user's Kalshi UUID and PEM as encrypted Actions secrets
 *      (real libsodium sealed-box) on the user's fork.
 *   3. Dispatch the bot.yml workflow with the chosen mode.
 *
 * Request body (optional): { mode: 'paper' | 'live' }
 * Default mode is 'paper'. 'live' requires `confirm: 'I UNDERSTAND'`
 * so it can't be tripped from a random fetch call.
 */
export async function POST(request: Request) {
  try {
  const csrf = checkCsrf(request); if (csrf) return csrf

  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Parse + validate body.
  let body: { mode?: 'paper' | 'live'; confirm?: string } = {}
  try { body = await request.json() } catch { /* empty body OK */ }
  const mode = body.mode === 'live' ? 'live' : 'paper'
  if (mode === 'live' && body.confirm !== 'I UNDERSTAND') {
    return NextResponse.json(
      { error: 'Live mode requires { confirm: "I UNDERSTAND" } in the request body.' },
      { status: 400 },
    )
  }

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = (user.privateMetadata ?? {}) as Record<string, string>

  if (!meta.kalshiApiKey || !meta.kalshiPrivateKey) {
    return NextResponse.json({ error: 'Kalshi API credentials not configured. Open Settings and add your key + PEM.' }, { status: 400 })
  }
  if (!meta.githubPat || !meta.githubRepo) {
    return NextResponse.json({ error: 'GitHub not connected. Open Settings and connect your bot repo.' }, { status: 400 })
  }

  const [owner, repo] = meta.githubRepo.split('/')
  if (!owner || !repo) {
    return NextResponse.json({ error: 'githubRepo is malformed — reconnect GitHub from Settings.' }, { status: 400 })
  }

  function decryptField(label: string, value: string, fixHint: string): string {
    try {
      return safeDecrypt(value)
    } catch (e: any) {
      // Friendly, actionable message instead of the raw "tried 1 key" line.
      throw new Error(
        `${label} was encrypted with a previous ENCRYPTION_KEY and can't be decrypted now. ${fixHint}`
      )
    }
  }
  const pat   = decryptField(
    'Your stored GitHub Personal Access Token',
    meta.githubPat,
    'Open ⚙ API Keys → GitHub Connection and paste a fresh PAT to re-save it under the current key.',
  )
  const keyId = decryptField(
    'Your stored Kalshi Key ID',
    meta.kalshiApiKey,
    'Open ⚙ API Keys → Kalshi credentials and re-paste your Key ID + private key.',
  )
  const pem   = decryptField(
    'Your stored Kalshi private key',
    meta.kalshiPrivateKey,
    'Open ⚙ API Keys → Kalshi credentials and re-paste your Key ID + private key.',
  )

  // 1) PAT scope check.
  const probe = await validatePatForRepo(pat, owner, repo)
  if (!probe.ok) {
    return NextResponse.json(
      { error: `Your GitHub token can't read Actions secrets on ${owner}/${repo}. Recreate the fine-grained PAT with Contents + Actions + Secrets scopes. (${probe.error})` },
      { status: 400 },
    )
  }

  // 2) Push (or refresh) the bot's secrets, sealed-box encrypted.
  try {
    await pushBotSecrets(pat, owner, repo, {
      kalshiKeyId: keyId,
      kalshiPem:   pem,
    })
  } catch (err: any) {
    return NextResponse.json({ error: `Pushing secrets to ${owner}/${repo} failed: ${err.message}` }, { status: 502 })
  }

  // 3) Dispatch the workflow.
  try {
    await dispatchBotWorkflow(pat, owner, repo, mode)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }

  // 4) Best-effort: also return current portfolio balance so the dashboard can show it.
  let balance: number | null = null
  let portfolioValue: number | null = null
  try {
    const data = await getPortfolioBalance(keyId, pem)
    balance        = data.available_balance
    portfolioValue = data.portfolio_value
  } catch { /* ignore — Kalshi sometimes flakes; don't fail the start */ }

  return NextResponse.json({ ok: true, mode, balance, portfolioValue })
  } catch (err: any) {
    // Defensive: any uncaught throw (e.g. safeDecrypt on a stale credential)
    // would otherwise become an empty 500 and the frontend would show
    // "Failed to execute 'json' on 'Response': Unexpected end of JSON input".
    return NextResponse.json({
      error: `Start failed: ${err?.message || String(err)}`,
    }, { status: 500 })
  }
}
