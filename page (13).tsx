import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getPortfolioBalance } from '@/lib/kalshi'
import { safeDecrypt } from '@/lib/crypto'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = user.privateMetadata as Record<string, string>

  if (!meta.kalshiApiKey || !meta.kalshiPrivateKey) {
    return NextResponse.json({ error: 'Kalshi credentials not configured. Open ⚙ API Keys and paste your key + PEM.' }, { status: 400 })
  }

  // Decrypt with a useful message if it fails — usually means the
  // ENCRYPTION_KEY env var changed since the creds were saved.
  let keyId: string, pem: string
  try {
    keyId = safeDecrypt(meta.kalshiApiKey)
    pem   = safeDecrypt(meta.kalshiPrivateKey)
  } catch (err: any) {
    return NextResponse.json({
      error: `Could not decrypt stored Kalshi credentials (${err.message}). The Netlify ENCRYPTION_KEY env var has likely changed since these were saved. Open ⚙ API Keys and re-paste your key + PEM.`
    }, { status: 500 })
  }

  // Quick sanity-check the PEM — pasting through some forms strips newlines.
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY') || !pem.includes('END')) {
    return NextResponse.json({
      error: 'Stored RSA private key looks malformed (missing BEGIN/END markers). Re-paste the full PEM including header and footer lines.',
    }, { status: 400 })
  }

  try {
    const data = await getPortfolioBalance(keyId, pem)
    return NextResponse.json(data)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
