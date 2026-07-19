// Jest stub for Next.js's `server-only` marker package. The real module throws
// if bundled into a client component; under jest (jsdom, CJS) there is no such
// boundary, so any module chain that reaches `import "server-only"` would fail
// to resolve. Mapping the specifier here lets server-only modules be unit-tested
// directly. Intentionally empty.
export {};
