import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={200}>
      <App />
      <Toaster position="bottom-right" richColors />
    </TooltipProvider>
  </StrictMode>,
)
