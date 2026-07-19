// Pin the test timezone so date/cron logic is deterministic regardless of the
// host's local TZ (CI runs UTC; dev machines may not).
process.env.TZ = "UTC";

/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  // @noble/* v2 ship ESM-only; jest's CJS runtime needs them transpiled.
  transform: {
    "^.+\\.[tj]sx?$": ["ts-jest", { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: ["/node_modules/(?!@noble/)"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["**/tests/unit/**/*.test.{ts,tsx}"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // Next's server-only marker is unresolvable under jest's CJS runtime; stub
    // it so server modules that import it can be unit-tested directly.
    "^server-only$": "<rootDir>/tests/stubs/server-only.ts",
  },
};
module.exports = config;
