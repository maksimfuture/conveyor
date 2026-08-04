#!/usr/bin/env node
// repos-status.mjs — состояние рабочих копий репозиториев конвейера.
// Используют /setup (таблица «что настроено») и validate-config (SessionStart).
// Плагин НЕ клонирует: задача скрипта — внятно сказать, чего не хватает, и
// куда пользователю склонировать репозиторий руками. Поле hint пишется так,
// чтобы его можно было показать КАК ЕСТЬ, без переформулирования.
//
// Usage: node repos-status.mjs [workspaceRoot]
// Output (stdout, JSON):
//   { ok, workspaceRoot, repos: [{ key, link, path, state, branch, clean, hint }],
//     summary: { ok, problems } }
// state: ok | missing | not-a-repo | link-empty | link-is-url | outside

import { execFileSync } from 'node:child_process';
import { readConfig, repoState, REPO_KEYS } from './lib/config.mjs';

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

const cfg = readConfig(process.argv[2] || process.cwd());
if (!cfg.found) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: 'не найден рабочий репозиторий conveyor (settings.json)' }) + '\n',
  );
  process.exit(1);
}
if (cfg.error) {
  process.stdout.write(JSON.stringify({ ok: false, workspaceRoot: cfg.workspaceRoot, error: cfg.error }) + '\n');
  process.exit(1);
}

const repos = [];
for (const key of REPO_KEYS) {
  const l = cfg.links[key];
  // Состояние и подсказку считает ядро (config.repoState) — тот же критерий
  // применяет SessionStart-хук validate-config. Здесь остаётся только то,
  // ради чего нужен git: ветка и чистота дерева.
  const { state, hint } = repoState(cfg, key);
  const entry = { key, link: l.value, path: l.path, state, branch: null, clean: null, hint };

  if (state === 'ok') {
    // Ветку и чистоту дерева читаем только у пригодной копии. git может
    // отсутствовать в PATH или каталог может быть повреждён — тогда остаются
    // null: состояние копии от этого не меняется, а вызывающий видит «неизвестно».
    entry.branch = git(l.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = git(l.path, ['status', '--porcelain']);
    entry.clean = status === null ? null : status === '';
  }
  repos.push(entry);
}

const okCount = repos.filter((r) => r.state === 'ok').length;
process.stdout.write(
  JSON.stringify(
    { ok: true, workspaceRoot: cfg.workspaceRoot, repos, summary: { ok: okCount, problems: repos.length - okCount } },
    null,
    2,
  ) + '\n',
);
