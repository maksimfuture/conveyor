#!/usr/bin/env node
// resolve-config.mjs — the single source of resolved configuration (spec 4.1).
//
// Usage:  node resolve-config.mjs [workspaceRoot]
// Prints a JSON object to stdout:
//   { found, workspaceRoot, config, repoCacheEnabled, links, missingVars }
// Exit code is always 0 — callers branch on `found` / `missingVars`, so this
// script never itself breaks a skill. Secrets stay in .env; the printed
// `config` contains resolved values but is meant for in-session use, not disk.

import { readConfig } from './lib/config.mjs';

const startDir = process.argv[2] || process.cwd();

try {
  const result = readConfig(startDir);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) {
  // Fail-open: emit a structured error rather than crashing the caller.
  process.stdout.write(
    JSON.stringify({ found: false, error: String(e && e.message ? e.message : e) }) + '\n',
  );
}
