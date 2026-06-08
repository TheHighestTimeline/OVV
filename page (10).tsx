import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { checkCsrf } from '@/lib/csrf'

export async function POST(request: Request) {
  const csrf = checkCsrf(request); if (csrf) return csrf

  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { pat } = await request.json()
  if (!pat) return NextResponse.json({ error: 'PAT required' }, { status: 400 })

  try {
    // Fetch user info + their repos in parallel
    const [userRes, reposRes] = await Promise.all([
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
        },
      }),
      fetch('https://api.github.com/user/repos?per_page=100&sort=updated&type=all', {
        headers: {
          Authorization: `Bearer ${pat}`,
          Accept: 'application/vnd.github+json',
        },
      }),
    ])

    if (!userRes.ok) {
      return NextResponse.json({ error: 'Invalid PAT or insufficient permissions. Make sure it has repo + workflow scopes.' }, { status: 401 })
    }

    const ghUser = await userRes.json()
    const allRepos = reposRes.ok ? await reposRes.json() : []

    // Return all repos so user can pick — highlight forks and ones named KalshiTradingBot
    const repos = allRepos.map((r: any) => ({
      id:          r.id,
      name:        r.name,
      full_name:   r.full_name,
      description: r.description,
      fork:        r.fork,
      private:     r.private,
      updated_at:  r.updated_at,
      suggested:   r.name.toLowerCase().includes('kalshi') || r.fork,
    }))

    return NextResponse.json({ login: ghUser.login, repos })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
