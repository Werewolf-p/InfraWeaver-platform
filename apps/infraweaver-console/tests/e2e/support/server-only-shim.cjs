// Preloaded via NODE_OPTIONS=--require. In a plain-Node/Playwright process the
// `import "server-only"` / `import "client-only"` marker packages are either
// unresolvable (this repo relies on Next's webpack alias) or throw by design.
// Both are compile-time-only guards with no runtime behaviour, so we resolve
// them to an empty module. Mirrors jest's `jest.mock("server-only", …, {virtual:true})`.
const Module = require("node:module");
const original = Module._resolveFilename;
const EMPTY = require.resolve("./empty-module.cjs");
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only" || request === "client-only") return EMPTY;
  return original.call(this, request, ...rest);
};
