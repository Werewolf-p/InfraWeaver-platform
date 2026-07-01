import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // ── Module boundary: core/shared code must not import addon internals ─────────
  // Addons may depend on core (@/lib, host registry, @/lib/addon-sdk), but core
  // and shared code must NOT reach into @/addons/*. Extract shared logic into
  // @/lib or expose it via the host registry / addon-sdk barrel instead.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/addons/**",
      "src/generated/**",
      "src/app/(dashboard)/game-hub/**",
      "src/app/(dashboard)/gameservers/**",
      "src/app/game-hub-status/**",
      "src/app/(dashboard)/wordpress/**",
      "src/app/api/game-hub/**",
      "src/app/api/gameservers/**",
      "src/app/api/wordpress/**",
      // Addon-owned UI surfaces not under the app tree.
      "src/components/game-hub/**",
      "src/components/wordpress/**",
      // Host shims that intentionally bridge core import paths to the addon.
      "src/lib/game-eggs.ts",
      "src/lib/game-hub.ts",
      "src/lib/game-hub-server.ts",
      "src/lib/game-hub-manifest.ts",
      "src/lib/game-hub-players.ts",
      "src/lib/game-hub-probes.ts",
      "src/lib/pelican-eggs.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{
        group: ["@/addons/*", "@/addons/**"],
        message: "Core/shared code must not import addon internals. Extract shared logic to @/lib or use the host registry.",
      }]}],
    },
  },
]);

export default eslintConfig;
