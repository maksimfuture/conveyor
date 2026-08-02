#!/usr/bin/env node
// guard-writes.mjs — PreToolUse hook for Write / Edit / NotebookEdit (spec 8.1).
//
// Allows writes only inside the allowed roots (workspace, repo working copies,
// system temp). Blocks everything else, and blocks writing an unusable
// repos.*.link into settings.json: the link must resolve INSIDE the workspace
// root (repos/<dir>), so a git URL or a path leading outside («../repo», an
// absolute path elsewhere) is rejected. The criterion is shared with the core
// — isUsableLink in lib/config.mjs.
//
// Fail policy (spec 8.1): if there is no settings.json in cwd, allow silently
// (the plugin is only active inside a conveyor workspace). Once config IS
// loaded, be fail-closed: an unparseable target path is denied with a reason.

import fs from 'node:fs';
import path from 'node:path';
import { readConfigForHook, checkWrite, isUsableLink } from './lib/config.mjs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function decide(decision, reason) {
  // decision: 'allow' | 'deny' | 'ask'
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + '\n',
  );
}

// Best-effort: repos.*.link — путь к рабочей копии ОТНОСИТЕЛЬНО корня проекта
// (repos/<dir>). Критерий пригодности — общий с ядром (isUsableLink):
// git-URL плагин не принимает, а путь наружу («../repo», чужой каталог)
// рабочей копии не даёт. Возвращает непригодные значения.
function badLinkValues(text, workspaceRoot) {
  const out = [];
  if (!text) return out;
  // match "link": "value" pairs
  const re = /"link"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const val = m[1].trim();
    // пусто — ещё не заданная ссылка; ${VAR} — подстановка, её резолвит .env
    if (val === '' || /^\$\{[A-Za-z0-9_]+\}$/.test(val)) continue;
    if (!isUsableLink(val, workspaceRoot)) out.push(val);
  }
  return out;
}

function main() {
  const stdin = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(stdin || '{}');
  } catch {
    payload = {};
  }

  const cwd = payload.cwd || process.cwd();
  // Не доверяем одному cwd: агент мог `cd` наружу — тогда workspace ищется
  // через $CLAUDE_PROJECT_DIR / $CONVEYOR_WORKSPACE (см. lib/config.mjs).
  const cfg = readConfigForHook(cwd);
  if (!cfg.found) return; // allow silently — нигде нет conveyor workspace

  const input = payload.tool_input || {};
  // Write/Edit use file_path; NotebookEdit uses notebook_path.
  const rawTarget = input.file_path || input.notebook_path;
  if (!rawTarget) {
    // Can't determine a path with config loaded -> fail-closed.
    return decide('deny', 'conveyor guard-writes: не удалось определить путь записи.');
  }

  const target = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(cwd, rawTarget);

  const verdict = checkWrite(target, cfg);
  if (!verdict.allowed) {
    return decide(
      'deny',
      `conveyor: запись запрещена — ${target}: ${verdict.reason}. ` +
        'Разрешены: рабочий репозиторий (артефакты задачи), репозитории рабочей ' +
        'области текущего этапа, системный temp.',
    );
  }

  // Guard settings.json against links the pipeline cannot use.
  const settingsPath = path.join(cfg.workspaceRoot, 'settings.json');
  if (path.resolve(target) === settingsPath) {
    const bad = badLinkValues(input.content || input.new_string || '', cfg.workspaceRoot);
    if (bad.length) {
      return decide(
        'deny',
        'conveyor: в settings.json поля repos.*.link — путь к рабочей копии ВНУТРИ ' +
          'корня проекта (например repos/backend): не git-URL и не путь наружу ' +
          `(«../», абсолютный). Отвергнуто: ${bad.join(', ')}.`,
      );
    }
  }

  // Allowed — stay silent so we do not spam the transcript.
}

try {
  main();
} catch (e) {
  // Config was reachable enough to get here; fail-closed with explanation.
  decide('deny', `conveyor guard-writes: внутренняя ошибка — ${e && e.message}. Действие заблокировано.`);
}
