import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // In development, /api goes to the local API (cd backend && npm run dev), as Vercel does in production.
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
