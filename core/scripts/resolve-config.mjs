#!/usr/bin/env node
// resolve-config.mjs — the single source of resolved configuration (spec 4.1).
//
// Usage:  node resolve-config.mjs [workspaceRoot]
// Prints a JSON object to stdout:
//   { found, workspaceRoot, config, fastMode, units, codebase,
//     links, missingLinks, urlLinks, configErrors }
// Exit code is always 0 — callers branch on `found` / `missingLinks`, so this
// script never itself breaks a skill. Secrets stay in .env; the printed
// `config` contains resolved values but is meant for in-session use, not disk.
//
// `units` — ГОТОВЫЙ список рабочих копий (id, путь, ветка, описание,
// состояние), `codebase` — какие юниты составляют кодовую базу FE и BE.
// Этапы берут ИХ и НЕ разбирают config.repos сами: форма настроек (группа
// backend из четырёх частей или одиночный репозиторий) — знание ядра, а не
// текста промпта.

import { readConfig, repoState, codebaseUnits } from './lib/config.mjs';

const startDir = process.argv[2] || process.cwd();

try {
  const result = readConfig(startDir);
  if (result.found && !result.error) {
    result.units = result.units.map((u) => {
      const l = result.links[u.id];
      const { state, hint } = repoState(result, u.id);
      return { ...u, path: l.path, inside: l.inside, state, hint };
    });
    result.codebase = { FE: codebaseUnits(result, 'FE'), BE: codebaseUnits(result, 'BE') };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) {
  // Fail-open: emit a structured error rather than crashing the caller.
  process.stdout.write(
    JSON.stringify({ found: false, error: String(e && e.message ? e.message : e) }) + '\n',
  );
}
