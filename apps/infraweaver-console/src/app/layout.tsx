import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "InfraWeaver Console",
  description: "Platform management console for InfraWeaver homelab",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#020617",
};

// Inlined theme-detection script — runs before React hydrates to avoid flash.
// The nonce is forwarded from middleware via the x-nonce request header so
// the dynamic CSP (which includes 'nonce-{value}') allows this script.
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light')}catch(e){}})()`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? "";

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce || undefined}
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body className={`${inter.className} bg-white text-gray-900 dark:bg-slate-950 dark:text-white antialiased overflow-x-hidden`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
