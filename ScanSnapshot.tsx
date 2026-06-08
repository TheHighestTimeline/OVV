import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getSettlements } from '@/lib/kalshi'
import { safeDecrypt } from '@/lib/crypto'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = user.privateMetadata as Record<string, string>

  if (!meta.kalshiApiKey || !meta.kalshiPrivateKey) {
    return NextResponse.json({ settlements: [] })
  }

  try {
    const settlements = await getSettlements(
      safeDecrypt(meta.kalshiApiKey),
      safeDecrypt(meta.kalshiPrivateKey)
    )
    return NextResponse.json({ settlements })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  }
}
