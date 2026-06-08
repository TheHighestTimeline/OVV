'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@clerk/nextjs'

type Step = 1 | 2 | 3 | 4

export default function SetupPage() {
  const { isLoaded } = useUser()
  const router = useRouter()
  const [step, setStep]         = useState<Step>(1)
  const [keyId, setKeyId]       = useState('')
  const [pem, setPem]           = useState('')
  const [githubUser, setGitHubUser] = useState('')
  const [githubPat, setGitHubPat]   = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')
  const [checking, setChecking] = useState(true)

  // Skip back into the dashboard if setup is already done.
  useEffect(() => {
    if (!isLoaded) return
    fetch('/api/user')
      .then(r => r.json())
      .then(d => {
        if (d.kalshiKeySet && d.githubConnected) router.replace('/dashboard')
        else if (d.kalshiKeySet) setStep(2)
      })
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [isLoaded, router])

  const saveKalshi = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!keyId.trim() || !pem.trim()) return
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kalshiApiKey: keyId.trim(), kalshiPrivateKey: pem.trim() }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      setStep(2)
    } catch (err: any) { setError(err.message) }
    finally { setSaving(false) }
  }

  const saveGitHub = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!githubUser.trim() || !githubPat.trim()) return
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubPat:      githubPat.trim(),
          githubUsername: githubUser.trim(),
          githubRepo:     `${githubUser.trim()}/KalshiTradingBot`,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      setStep(3)
    } catch (err: any) { setError(err.message) }
    finally { setSaving(false) }
  }

  if (!isLoaded || checking) {
    return (
      <div className="min-h-screen bg-[#0a0b0d] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#00d17a] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0b0d] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">

        <header className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">One-time setup</h1>
          <p className="text-gray-400 text-sm mt-1">Connect your accounts. Keys stay on your devices — we never share them.</p>
        </header>

        <Progress step={step} />

        {step === 1 && (
          <Card title="Step 1 — Kalshi credentials"
            help={<>Find both at <Link href="https://kalshi.com/profile/api-access">kalshi.com → Profile → API Access</Link>. The UUID-style key ID and the RSA private key are issued together.</>}>
            <form onSubmit={saveKalshi} className="space-y-3">
              <Field label="Key ID (UUID)">
                <input type="text" placeholder="e.g. 62d80886-c163-41a2-8ac2-968fc5180841"
                  value={keyId} onChange={e => setKeyId(e.target.value)} required
                  className="input font-mono text-xs" />
              </Field>
              <Field label="RSA Private Key (full PEM)">
                <textarea
                  placeholder={"-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"}
                  value={pem} onChange={e => setPem(e.target.value)} required rows={6}
                  className="input font-mono text-xs resize-none" />
              </Field>
              {error && <Err>{error}</Err>}
              <button type="submit" disabled={saving} className="btn-primary w-full">
                {saving ? 'Saving…' : 'Save credentials → Continue'}
              </button>
            </form>
          </Card>
        )}

        {step === 2 && (
          <Card title="Step 2 — Connect your bot repo">
            <ol className="bg-[#1e2330] rounded-lg p-4 mb-5 space-y-2 text-sm text-gray-300 list-decimal list-inside">
              <li>
                Fork the bot template:{' '}
                <Link href="https://github.com/InTheNightRaider/KalshiTradingBot/fork">
                  KalshiTradingBot (click to fork) →
                </Link>
              </li>
              <li>
                Create a <strong className="text-white">fine-grained</strong> Personal Access Token{' '}
                <Link href="https://github.com/settings/personal-access-tokens/new">
                  here →
                </Link>
              </li>
              <li>
                Repository access: <strong>Only select repositories</strong> → pick your fork.<br/>
                Permissions: <code className="text-[#f5c842]">Contents</code>, <code className="text-[#f5c842]">Actions</code>, and <code className="text-[#f5c842]">Secrets</code> — all Read &amp; Write.
              </li>
            </ol>

            <form onSubmit={saveGitHub} className="space-y-3">
              <Field label="Your GitHub Username">
                <input type="text" placeholder="e.g. johndoe"
                  value={githubUser} onChange={e => setGitHubUser(e.target.value)} required
                  className="input" />
              </Field>
              <Field label="Fine-grained PAT">
                <input type="password" placeholder="github_pat_..."
                  value={githubPat} onChange={e => setGitHubPat(e.target.value)} required
                  className="input font-mono text-xs" />
              </Field>
              <p className="text-xs text-gray-500">The token never leaves your account. We use it only to push Kalshi secrets to your fork and trigger the workflow.</p>
              {error && <Err>{error}</Err>}
              <button type="submit" disabled={saving} className="btn-primary w-full">
                {saving ? 'Validating…' : 'Connect → Continue'}
              </button>
            </form>
          </Card>
        )}

        {step === 3 && (
          <Card title="You're set!">
            <p className="text-gray-400 text-sm mb-6 max-w-xs">
              Credentials saved. The first time you click <strong>Start bot</strong>, the dashboard will push your Kalshi secrets into your fork (sealed-box encrypted) and dispatch the workflow. You can switch between paper and live in Settings.
            </p>
            <button onClick={() => router.push('/dashboard')} className="btn-primary">Go to dashboard →</button>
          </Card>
        )}

        <p className="text-center text-xs text-gray-600 mt-6">
          Your API keys are AES-256 encrypted in our database. They never appear in our logs.
        </p>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
function Progress({ step }: { step: number }) {
  return (
    <div className="flex items-center mb-8">
      {[1, 2, 3].map(s => (
        <div key={s} className="flex items-center flex-1">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold
            ${step > s ? 'bg-[#00d17a] text-[#0a0b0d]' :
              step === s ? 'bg-[#4f8ef7] text-white ring-4 ring-[#4f8ef7]/20' :
              'bg-[#252c3a] text-gray-500'}`}>
            {step > s ? '✓' : s}
          </div>
          {s < 3 && <div className={`flex-1 h-px mx-2 ${step > s ? 'bg-[#00d17a]' : 'bg-[#252c3a]'}`} />}
        </div>
      ))}
    </div>
  )
}

function Card({ title, help, children }: { title: string; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="font-semibold text-white text-lg mb-1">{title}</h2>
      {help && <p className="text-gray-400 text-sm mb-5">{help}</p>}
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-gray-400 uppercase tracking-wider mb-1.5 block">{label}</label>
      {children}
    </div>
  )
}

function Err({ children }: { children: React.ReactNode }) {
  return <div className="bg-[#ff4d6d]/10 border border-[#ff4d6d]/30 rounded-lg px-3 py-2 text-sm text-[#ff4d6d]">{children}</div>
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#4f8ef7] hover:underline">{children}</a>
}
