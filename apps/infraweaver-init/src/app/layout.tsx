import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'InfraWeaver Init Wizard',
  description: 'Bootstrap and deploy an InfraWeaver cluster from a guided init wizard.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f0f0f',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.className} bg-[var(--az-bg)] text-[var(--az-text)] antialiased`}>
        {children}
      </body>
    </html>
  )
}
