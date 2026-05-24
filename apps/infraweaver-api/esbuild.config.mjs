// esbuild.config.mjs — Bundle the InfraWeaver API into a single ESM file.
//
// @kubernetes/client-node is kept external because it is a pure-ESM package
// that imports other ESM-only modules. Bundling it would require resolving
// every sub-entry-point which adds significant complexity with no size benefit
// (it's already a peer dep that must ship with the image anyway — 57 MB).
//
// All other production dependencies (hono, zod, ws, simple-git, etc.) are
// inlined so the final image only needs node_modules/@kubernetes/client-node.

import * as esbuild from 'esbuild';

const result = await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.mjs',
  external: [
    '@kubernetes/client-node',
    // Node built-ins are always external; listing them makes intent explicit
    'node:*',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'stream',
    'child_process', 'events', 'url', 'util', 'buffer', 'tty',
  ],
  // Tree-shake aggressively
  treeShaking: true,
  // Preserve dynamic import() calls so async splitting works at runtime
  splitting: false,
  // Source maps for production debugging
  sourcemap: 'external',
  minify: false,     // readable output; enable if image size is critical
  logLevel: 'info',
  metafile: true,
});

// Print a compact size summary
const outputs = Object.entries(result.metafile.outputs);
const totalBytes = outputs.reduce((sum, [, meta]) => sum + meta.bytes, 0);
console.log(`\nBundle summary:`);
for (const [file, meta] of outputs) {
  console.log(`  ${file}: ${(meta.bytes / 1024).toFixed(1)} kB`);
}
console.log(`  Total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
