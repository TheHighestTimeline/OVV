import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getLatestWorkflowRun } from '@/lib/github'
import { safeDecrypt } from '@/lib/crypto'

/**
 * GET /api/bot/status
 *
 * Returns the real status of the GitHub Actions bot workflow so the
 * dashboard badge stays in sync even after a page refresh.
 *
 * Response: { status: 'idle' | 'running' | 'starting' }
 */
export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = user.privateMetadata as Record<string, string>

  if (!meta.githubPat || !meta.githubRepo) {
    return NextResponse.json({ status: 'idle' })
  }

  const [owner, repo] = meta.githubRepo.split('/')
  const decryptedPat  = safeDecrypt(meta.githubPat)

  try {
    const run = await getLatestWorkflowRun(decryptedPat, owner, repo)

    if (!run) return NextResponse.json({ status: 'idle' })

    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failure') {
      return NextResponse.json({ status: 'idle' })
    }

    if (run.status === 'queued' || run.status === 'waiting') {
      return NextResponse.json({ status: 'starting', runId: run.id })
    }

    // in_progress
    return NextResponse.json({ status: 'running', runId: run.id })
  } catch {
    // If GitHub is unreachable, don't crash the dashboard
    return NextResponse.json({ status: 'idle' })
  }
}
