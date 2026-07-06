#!/usr/bin/env node
// guard-writes.mjs — PreToolUse hook for Write / Edit / NotebookEdit (spec 8.1).
//
// Allows writes only inside the allowed roots (workspace, .cache, local link
// paths, system temp). Blocks everything else, and blocks writing plaintext
// secrets into settings.json (a repos.*.link that is not a ${VAR}).
//
// Fail policy (spec 8.1): if there is no settings.json in cwd, allow silently
// (the plugin is only active inside a conveyor workspace). Once config IS
// loaded, be fail-closed: an unparseable target path is denied with a reason.

import fs from 'node:fs';
import path from 'node:path';
import { readConfigForHook, checkWrite } from './lib/config.mjs';

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

// Best-effort: does this text put a raw (non-${VAR}) value into a repos.*.link?
function hasPlaintextLinkSecret(text) {
  if (!text) return false;
  // match "link": "value" pairs
  const re = /"link"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const val = m[1];
    if (!/^\$\{[A-Za-z0-9_]+\}$/.test(val) && val.trim() !== '') return true;
  }
  return false;
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

  // Guard settings.json against plaintext secrets in link fields.
  const settingsPath = path.join(cfg.workspaceRoot, 'settings.json');
  if (path.resolve(target) === settingsPath) {
    const text = input.content || input.new_string || '';
    if (hasPlaintextLinkSecret(text)) {
      return decide(
        'deny',
        'conveyor: в settings.json поля repos.*.link должны быть ссылками ${VAR}, ' +
          'а не открытыми путями/URL. Задайте значения в .env.',
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
