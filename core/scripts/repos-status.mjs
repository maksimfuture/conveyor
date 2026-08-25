#!/usr/bin/env node
// repos-status.mjs — состояние рабочих копий репозиториев конвейера.
// Используют /setup (таблица «что настроено») и validate-config (SessionStart).
// Плагин НЕ клонирует: задача скрипта — внятно сказать, чего не хватает, и
// куда пользователю склонировать репозиторий руками. Поле hint пишется так,
// чтобы его можно было показать КАК ЕСТЬ, без переформулирования.
//
// Usage: node repos-status.mjs [workspaceRoot]
// Output (stdout, JSON):
//   { ok, workspaceRoot, configErrors,
//     repos: [{ id, description, link, path, state, branch, clean, hint }],
//     summary: { ok, problems } }
// state: ok | missing | not-a-repo | link-empty | link-is-url | outside
//
// Строка — на ЮНИТ (рабочую копию), а не на ключ настроек: у бэкенда,
// разложенного на core/api/common/config, их четыре, и части одной группы
// идут подряд — в таблице /setup они читаются как один блок.

import { execFileSync } from 'node:child_process';
import { readConfig, repoState, unitIds } from './lib/config.mjs';

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
for (const id of unitIds(cfg)) {
  const l = cfg.links[id];
  const unit = cfg.units.find((u) => u.id === id);
  // Состояние и подсказку считает ядро (config.repoState) — тот же критерий
  // применяет SessionStart-хук validate-config. Здесь остаётся только то,
  // ради чего нужен git: ветка и чистота дерева.
  const { state, hint } = repoState(cfg, id);
  // id вместо прежнего key: у части группы это `backend.api` — по нему её
  // называют и настройки, и рабочая область этапа. Отдельных полей key/part
  // здесь нет намеренно: id их содержит, а лишнее поле в таблице /setup
  // пришлось бы объяснять человеку.
  const entry = { id, description: unit.description, link: l.value, path: l.path, state, branch: null, clean: null, hint };

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
    {
      ok: true,
      workspaceRoot: cfg.workspaceRoot,
      // Претензии к ФОРМЕ settings.json (группа под чужим ключом, лишний
      // ключ). Состояния копий их не показывают: запись, которую плагин не
      // использует, не «сломана» — её просто нет в таблице, и без этого
      // списка человек правит настройки и не понимает, почему ничего не
      // изменилось.
      configErrors: cfg.configErrors || [],
      repos,
      summary: { ok: okCount, problems: repos.length - okCount },
    },
    null,
    2,
  ) + '\n',
);
