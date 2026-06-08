import { SignUp } from '@clerk/nextjs'

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-[#0a0b0d] flex flex-col items-center justify-center px-4">
      <div className="flex items-center gap-2 mb-8">
        <div className="w-8 h-8 bg-[#00d17a] rounded-lg flex items-center justify-center">
          <svg className="w-5 h-5 text-[#0a0b0d]" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/>
          </svg>
        </div>
        <span className="text-xl font-bold text-white">KalshiBot</span>
      </div>
      <SignUp
        appearance={{
          variables: {
            colorPrimary: '#00d17a',
            colorBackground: '#111318',
            colorText: '#e5e7eb',
            colorInputBackground: '#181b22',
            colorInputText: '#ffffff',
            borderRadius: '0.75rem',
          },
          elements: {
            card: 'shadow-2xl border border-[#252c3a]',
            headerTitle: 'text-white font-semibold',
            headerSubtitle: 'text-gray-400',
            socialButtonsBlockButton: 'border border-[#252c3a] hover:bg-[#1e2330]',
            formFieldInput: 'bg-[#181b22] border-[#252c3a] text-white',
            footerActionLink: 'text-[#4f8ef7]',
          }
        }}
      />
    </div>
  )
}
