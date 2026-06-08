import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getRepoFile } from '@/lib/github'
import { safeDecrypt } from '@/lib/crypto'

/**
 * GET /api/bot/state
 *
 * Reads `dashboard/btc_paper_state.json` from the user's connected bot
 * fork via the GitHub Contents API and returns the parsed JSON. This
 * is how the dashboard displays bankrolls, open positions, and recent
 * trades — the bot commits the file back to the fork on every event.
 *
 * Returns 200 with `{ state: null }` when:
 *   - GitHub not connected (no error)
 *   - File doesn't exist yet (bot hasn't run)
 *   - File exists but is unparseable (logged + null)
 */

// Tiny in-memory cache so dashboard polling at 30s intervals doesn't
// hit GitHub's 5000/hour quota.  Keyed per (owner, repo).
type CacheEntry = { ts: number; value: any }
const CACHE_MS = 20_000
const _cache: Map<string, CacheEntry> = (globalThis as any).__botStateCache ??= new Map()

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = (user.privateMetadata ?? {}) as Record<string, string>

  if (!meta.githubPat || !meta.githubRepo) {
    return NextResponse.json({ state: null, reason: 'github-not-connected' })
  }
  const [owner, repo] = meta.githubRepo.split('/')
  if (!owner || !repo) return NextResponse.json({ state: null, reason: 'repo-malformed' })

  const cacheKey = `${owner}/${repo}`
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return NextResponse.json({ state: cached.value, cached: true })
  }

  const pat = safeDecrypt(meta.githubPat)
  let raw: string | null = null
  try {
    raw = await getRepoFile(pat, owner, repo, 'dashboard/btc_paper_state.json')
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }

  if (raw == null) {
    _cache.set(cacheKey, { ts: Date.now(), value: null })
    return NextResponse.json({ state: null, reason: 'no-state-yet' })
  }

  try {
    const parsed = JSON.parse(raw)
    _cache.set(cacheKey, { ts: Date.now(), value: parsed })
    return NextResponse.json({ state: parsed })
  } catch (err: any) {
    return NextResponse.json({ state: null, reason: 'parse-error', error: err.message })
  }
}
