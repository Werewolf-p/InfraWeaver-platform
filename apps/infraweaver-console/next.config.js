// CSP is now set dynamically in middleware.ts with a per-request nonce
// (script-src uses 'nonce-{nonce}' + 'strict-dynamic' so CSP3 browsers ignore 'unsafe-inline').
// These static headers remain as a fallback / defence-in-depth for paths the middleware
// does not intercept (e.g. _next/static). The middleware CSP header overrides this one for
// all page and API responses.

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['monaco-editor', '@kubernetes/client-node'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // HSTS: 2 years, include subdomains, eligible for preload list
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Prevent framing — frame-ancestors 'none' in CSP covers modern browsers;
          // X-Frame-Options DENY covers legacy browsers (consistent with middleware)
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
