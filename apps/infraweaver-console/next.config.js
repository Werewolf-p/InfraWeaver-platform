// CSP is now set dynamically in middleware.ts with a per-request nonce
// (script-src uses 'nonce-{nonce}' + 'strict-dynamic' so CSP3 browsers ignore 'unsafe-inline').
// These static headers remain as a fallback / defence-in-depth for paths the middleware
// does not intercept (e.g. _next/static). The middleware CSP header overrides this one for
// all page and API responses.

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['monaco-editor', '@kubernetes/client-node'],
  // In-cluster BuildKit runs in a 4-CPU / 12Gi cgroup, but Next derives its build
  // worker count from os.cpus() (the node's 10 cores -> 9 workers), over-subscribing
  // the cgroup and SIGSEGV-ing the build / page-data workers. Pin an explicit, small
  // worker count so the build is deterministic inside the constrained build sandbox.
  experimental: { cpus: 2 },
  async redirects() {
    return [
      // The standalone Pods page was folded into the Apps page (each app drills
      // into its own pods). Keep old links/bookmarks working — both the index and
      // any old per-pod detail route (/pods/<ns>/<name>) land on /apps.
      { source: '/pods', destination: '/apps', permanent: false },
      { source: '/pods/:path*', destination: '/apps', permanent: false },
    ]
  },
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
