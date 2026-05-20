// CSP uses a nonce placeholder — Next.js middleware generates a per-request nonce
// stored in the x-nonce response header and injects it into the CSP header.
// 'unsafe-inline' is kept as fallback for older browsers (nonce takes precedence).
// 'unsafe-eval' is required by Monaco editor and the React dev overlay in development.
const ContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss: ws:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['monaco-editor', '@kubernetes/client-node'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: ContentSecurityPolicy },
          // HSTS: 2 years, include subdomains, eligible for preload list
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Prevent framing — frame-ancestors 'none' in CSP covers modern browsers;
          // X-Frame-Options covers legacy browsers
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), battery=()' },
          // Disable DNS prefetching to prevent information leakage
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          // Prevent cross-origin window interactions (window.opener attacks)
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // Prevent other sites from loading our resources
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          // COEP was removed because it breaks the PWA and some cross-origin subresource loads
          // without tangible security benefit here (we do not use SharedArrayBuffer).
          { key: 'X-Download-Options', value: 'noopen' },
          { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          // Explicitly disable legacy XSS auditor (can create vulnerabilities)
          { key: 'X-XSS-Protection', value: '0' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
