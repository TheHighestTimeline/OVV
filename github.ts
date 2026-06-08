@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    background-color: #0a0b0d;
    color: #e5e7eb;
    font-family: 'Inter', -apple-system, sans-serif;
  }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: #111318; }
  ::-webkit-scrollbar-thumb { background: #252c3a; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #4f8ef7; }
}

@layer components {
  .card { @apply bg-[#111318] border border-[#252c3a] rounded-xl p-5; }
  .btn-primary {
    @apply bg-[#00d17a] text-[#0a0b0d] font-semibold px-5 py-2.5 rounded-lg
           hover:brightness-110 active:scale-95 transition-all duration-150
           disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2;
  }
  .btn-danger {
    @apply bg-[#ff4d6d] text-white font-semibold px-5 py-2.5 rounded-lg
           hover:brightness-110 active:scale-95 transition-all duration-150
           disabled:opacity-40 disabled:cursor-not-allowed;
  }
  .btn-secondary {
    @apply bg-[#1e2330] text-gray-300 font-medium px-5 py-2.5 rounded-lg border border-[#252c3a]
           hover:bg-[#252c3a] active:scale-95 transition-all duration-150;
  }
  .badge-green  { @apply text-[#00d17a] bg-[#00d17a]/10 px-2 py-0.5 rounded text-xs font-mono font-medium; }
  .badge-red    { @apply text-[#ff4d6d] bg-[#ff4d6d]/10 px-2 py-0.5 rounded text-xs font-mono font-medium; }
  .badge-blue   { @apply text-[#4f8ef7] bg-[#4f8ef7]/10 px-2 py-0.5 rounded text-xs font-mono font-medium; }
  .badge-yellow { @apply text-[#f5c842] bg-[#f5c842]/10 px-2 py-0.5 rounded text-xs font-mono font-medium; }
  .input {
    @apply w-full bg-[#181b22] border border-[#252c3a] rounded-lg px-4 py-2.5
           text-white placeholder-gray-600 focus:outline-none focus:border-[#4f8ef7]
           transition-colors text-sm;
  }
}
