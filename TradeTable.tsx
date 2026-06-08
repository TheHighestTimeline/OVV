import { auth, clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { createPrivateKey, createPublicKey, createHash } from 'crypto'
import { getGitHubUser } from '@/lib/github'
import { encrypt, safeDecrypt, DecryptionFailedError } from '@/lib/crypto'
import { getPortfolioBalance } from '@/lib/kalshi'

/**
 * SHA-256 fingerprint of the public key derived from a private-key PEM.
 * Lets us prove byte-equivalence between the PEM the dashboard received
 * and a known-good file the user can fingerprint locally — without
 * exposing the private key itself.
 */
function publicKeyFingerprint(pem: string): string {
  const priv = createPrivateKey(pem)
  const pub  = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer
  return createHash('sha256').update(pub).digest('hex')
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const clerk = await clerkClient()
  const user  = await clerk.users.getUser(userId)
  const meta  = (user.privateMetadata ?? {}) as Record<string, string>

  return NextResponse.json({
    kalshiKeySet:    !!meta.kalshiApiKey,
    kalshiPemSet:    !!meta.kalshiPrivateKey,
    githubConnected: !!meta.githubPat && !!meta.githubUsername,
    githubUsername:  meta.githubUsername ?? null,
    githubRepo:      meta.githubRepo ?? null,
  })
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body  = await request.json()
  const clerk = await clerkClient()

  const existingUser = await clerk.users.getUser(userId)
  const existingMeta = (existingUser.privateMetadata ?? {}) as Record<string, string>

  const update: Record<string, string> = {}

  let pendingKeyId: string | null = null
  let pendingPem:   string | null = null

  if (body.kalshiApiKey) {
    pendingKeyId = String(body.kalshiApiKey).trim()
    if (pendingKeyId.length < 16 || /\s/.test(pendingKeyId)) {
      return NextResponse.json({
        error: 'Key ID looks malformed. It should be a UUID like 62d80886-c163-41a2-8ac2-968fc5180841.',
      }, { status: 400 })
    }
  }

  if (body.kalshiPrivateKey) {
    pendingPem = String(body.kalshiPrivateKey).trim()
    if (!pendingPem.includes('-----BEGIN') || !pendingPem.includes('PRIVATE KEY') || !pendingPem.includes('-----END')) {
      return NextResponse.json({
        error: 'kalshiPrivateKey must be a full PEM including both -----BEGIN ... PRIVATE KEY----- and -----END ... PRIVATE KEY----- lines.',
      }, { status: 400 })
    }
    try {
      createPrivateKey(pendingPem)
    } catch (e: any) {
      return NextResponse.json({
        error: `RSA private key failed to parse: ${e.message}. The PEM may have been pasted with mangled line breaks or character corruption.`,
      }, { status: 400 })
    }
  }

  if (pendingKeyId || pendingPem) {
    let keyIdForCheck: string | null = null
    let pemForCheck:   string | null = null

    try {
      keyIdForCheck = pendingKeyId ?? (existingMeta.kalshiApiKey      ? safeDecrypt(existingMeta.kalshiApiKey)      : null)
      pemForCheck   = pendingPem   ?? (existingMeta.kalshiPrivateKey  ? safeDecrypt(existingMeta.kalshiPrivateKey)  : null)
    } catch (e) {
      if (e instanceof DecryptionFailedError) {
        return NextResponse.json({
          error: 'Your previously stored Kalshi credentials can no longer be decrypted (ENCRYPTION_KEY likely rotated). Please re-paste BOTH the Key ID and the private key together.',
        }, { status: 400 })
      }
      throw e
    }

    if (!keyIdForCheck || !pemForCheck) {
      return NextResponse.json({
        error: 'Both Key ID and private key are required for the initial Kalshi save.',
      }, { status: 400 })
    }

    try {
      await getPortfolioBalance(keyIdForCheck, pemForCheck)
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg.includes('INCORRECT_API_KEY_SIGNATURE') || msg.includes(' 401')) {
        // Compute the fingerprint of the public key that the *received* PEM
        // produces. The user can compare this to the known-good file's
        // fingerprint to prove whether bytes survived the round trip.
        let fp = 'unavailable'
        try { fp = publicKeyFingerprint(pemForCheck) } catch {}
        return NextResponse.json({
          error:
            'Kalshi rejected the Key ID + private key pair (INCORRECT_API_KEY_SIGNATURE). ' +
            `keyId="${keyIdForCheck}" pem_length=${pemForCheck.length} pubkey_sha256=${fp.slice(0, 16)}… ` +
            'If your local file fingerprint differs, the upload/paste corrupted the bytes — use "Choose .pem file" instead of pasting. ' +
            'If the fingerprints match, the key_id belongs to a different RSA key than this PEM — generate a fresh pair at kalshi.com → Profile → API Access.',
        }, { status: 400 })
      }
      return NextResponse.json({
        error: `Live Kalshi check failed before save: ${msg.slice(0, 300)}`,
      }, { status: 400 })
    }

    if (pendingKeyId) update.kalshiApiKey     = encrypt(pendingKeyId)
    if (pendingPem)   update.kalshiPrivateKey = encrypt(pendingPem)
  }

  if (body.githubPat) {
    try {
      const login = await getGitHubUser(body.githubPat)
      if (body.githubUsername && login.toLowerCase() !== body.githubUsername.toLowerCase()) {
        return NextResponse.json({
          error: `PAT belongs to GitHub user "${login}" but you entered "${body.githubUsername}". Use the correct username.`
        }, { status: 400 })
      }
      update.githubPat      = encrypt(String(body.githubPat).trim())
      update.githubUsername = login
      update.githubRepo     = body.githubRepo ?? `${login}/KalshiTradingBot`
    } catch (err: any) {
      return NextResponse.json({ error: `GitHub validation failed: ${err.message}` }, { status: 400 })
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'No fields to update.' }, { status: 400 })
  }

  await clerk.users.updateUserMetadata(userId, { privateMetadata: update })
  return NextResponse.json({ ok: true })
}
