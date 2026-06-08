import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { checkCsrf } from '@/lib/csrf'
import { getLatestWorkflowRun, cancelWorkflowRun } from '@/lib/github'
import { safeDecrypt } from '@/lib/crypto'

export async function POST(request: Request) {
  try {
  const csrf = checkCsrf(request); if (csrf) return csrf

  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = user.privateMetadata as Record<string, string>

  if (!meta.githubPat || !meta.githubUsername || !meta.githubRepo) {
    return NextResponse.json({ error: 'GitHub not connected — connect a repo first.' }, { status: 400 })
  }

  const [owner, repo] = meta.githubRepo.split('/')
  if (!owner || !repo) {
    return NextResponse.json({ error: 'githubRepo is malformed — reconnect GitHub from Settings.' }, { status: 400 })
  }
  const decryptedPat = safeDecrypt(meta.githubPat)

  try {
    const run = await getLatestWorkflowRun(decryptedPat, owner, repo)
    if (!run) {
      return NextResponse.json({ ok: true, message: 'No active run found.' })
    }
    if (run.status === 'completed') {
      return NextResponse.json({ ok: true, message: 'Bot is already stopped.' })
    }
    await cancelWorkflowRun(decryptedPat, owner, repo, run.id)
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
  } catch (err: any) {
    return NextResponse.json({
      error: `Stop failed: ${err?.message || String(err)}`,
    }, { status: 500 })
  }
}
