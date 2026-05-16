#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const delegate = path.join(scriptDir, "..", "apps", "infraweaver-console", "scripts", "scaffold-page.mjs");

const result = spawnSync(process.execPath, [delegate, ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
