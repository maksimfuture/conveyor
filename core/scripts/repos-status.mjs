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

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readConfig, REPO_KEYS, REPO_DIRS } from './lib/config.mjs';

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
  const entry = { key, link: l.value, path: l.path, state: 'ok', branch: null, clean: null, hint: null };

  // Порядок ветвлений — от причины к следствию. Границу проекта проверяем ДО
  // существования каталога: критерий пригодности ссылки один на весь плагин
  // (isUsableLink → links[key].inside), и ссылка наружу непригодна независимо
  // от того, лежит там что-нибудь или нет. Отложи её за `!existsSync`, и
  // несуществующий путь наружу получит state `missing` с подсказкой
  // «склонируйте сюда» — туда, куда клонировать нельзя вовсе: guard-writes
  // такую копию не примет, а GigaCode такую конфигурацию не разрешит.
  if (!l.value) {
    entry.state = 'link-empty';
    entry.hint = `заполните repos.${key}.link в settings.json (обычно ${REPO_DIRS[key]}) и склонируйте туда репозиторий`;
  } else if (l.isGitUrl) {
    entry.state = 'link-is-url';
    entry.hint =
      `в repos.${key}.link нужен путь, а не git-URL: плагин не клонирует — ` +
      `склонируйте репозиторий в ${REPO_DIRS[key]} и укажите этот путь`;
  } else if (!l.inside) {
    entry.state = 'outside';
    entry.hint =
      `путь repos.${key}.link ведёт за пределы рабочего репозитория (${l.path}); ` +
      `он резолвится от корня рабочего репозитория и обязан остаться внутри него — укажите ${REPO_DIRS[key]}`;
  } else if (!fs.existsSync(l.path)) {
    entry.state = 'missing';
    entry.hint = `рабочей копии нет — склонируйте репозиторий в ${l.path}`;
  } else if (!fs.existsSync(path.join(l.path, '.git'))) {
    // `git clone` в СУЩЕСТВУЮЩИЙ непустой каталог не выполняется — одного
    // «склонируйте сюда» мало: человек упрётся в ошибку git и вернётся сюда же.
    entry.state = 'not-a-repo';
    entry.hint =
      `каталог ${l.value} существует, но это не git-репозиторий: склонируйте репозиторий в ${l.path}; ` +
      `клонировать в непустой каталог git не станет — очистите его или переименуйте, если он лишний`;
  } else {
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
