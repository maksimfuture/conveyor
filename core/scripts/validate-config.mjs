#!/usr/bin/env node
// validate-config.mjs — SessionStart hook (spec 8.1) and the first-step check
// that stage scripts reuse (spec 8.3).
//
// Behaviour:
//   - No settings.json in cwd            -> silent, exit 0 (fail-open).
//   - settings.json present but ${VAR}s  -> emit additionalContext warning
//     unresolved                            naming the vars + blocked stages.
//   - Also lists active tasks (some stage done, some not) as a nudge.
//
// Reads the hook JSON from stdin (SessionStart passes { cwd, ... }); falls
// back to process.cwd() when run directly. Any internal error is swallowed
// (fail-open) so a broken validator never blocks a session.

import fs from 'node:fs';
import path from 'node:path';
import {
  readConfig,
  readScopeState,
  requiredRepoKeys,
  REPO_KEYS,
  scopeFilePath,
  LEGACY_SCOPE_FILE,
} from './lib/config.mjs';

const STAGES_NEEDING_REPO = [
  'create-feature',
  'create-specification',
  'create-plan',
  'implement-plan',
  'create-requirements-auto-test',
  'implement-auto-test',
];

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emitContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    }) + '\n',
  );
}

function listActiveTasks(workspaceRoot) {
  const tasksDir = path.join(workspaceRoot, 'tasks');
  const active = [];
  for (const type of ['FE', 'BE']) {
    const dir = path.join(tasksDir, type);
    if (!fs.existsSync(dir)) continue;
    for (const taskId of fs.readdirSync(dir)) {
      const metaPath = path.join(dir, taskId, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const stages = Object.values(meta.stages || {});
        const done = stages.filter((s) => s && s.done).length;
        if (done > 0 && done < stages.length) {
          active.push(`${meta.taskId || taskId} (${meta.type || type}) ${done}/${stages.length}`);
        }
      } catch {
        /* ignore a broken meta.json here; /task-status reports it */
      }
    }
  }
  return active;
}

function main() {
  let cwd = process.cwd();
  const stdin = readStdin();
  if (stdin) {
    try {
      const parsed = JSON.parse(stdin);
      if (parsed && parsed.cwd) cwd = parsed.cwd;
    } catch {
      /* not JSON — use process.cwd() */
    }
  }

  const cfg = readConfig(cwd);
  if (!cfg.found) return; // silent — plugin only active in a conveyor workspace

  const lines = [];

  if (cfg.error) {
    lines.push(`⚠ conveyor: ${cfg.error}`);
  } else if (cfg.missingVars.length) {
    // Map each missing var to the stages it blocks.
    const blocked = new Set();
    for (const stage of STAGES_NEEDING_REPO) {
      const keys = requiredRepoKeys(stage, 'FE').concat(requiredRepoKeys(stage, 'BE'));
      for (const key of new Set(keys)) {
        const link = cfg.links[key];
        if (link && link.varName && cfg.missingVars.includes(link.varName)) blocked.add(stage);
      }
    }
    lines.push(
      `⚠ conveyor: не заполнены переменные .env: ${cfg.missingVars.join(', ')}.`,
      blocked.size
        ? `Заблокированы этапы: ${[...blocked].join(', ')}. Заполните .env по образцу .env.example.`
        : 'Заполните .env по образцу .env.example.',
    );

    // Also flag git-URL links while the cache is disabled.
    if (!cfg.repoCacheEnabled) {
      const gitUrls = REPO_KEYS.filter((k) => cfg.links[k].isGitUrl);
      if (gitUrls.length) {
        lines.push(
          `⚠ repoCache выключен, но ссылки заданы git-URL: ${gitUrls.join(', ')}. ` +
            'Укажите локальные пути или включите CONVEYOR_REPO_CACHE=true.',
        );
      }
    }
  }

  const active = listActiveTasks(cfg.workspaceRoot);
  if (active.length) lines.push(`Активные задачи: ${active.join('; ')}.`);

  if (cfg.fastMode) {
    lines.push('conveyor: быстрый режим (CONVEYOR_FAST) включён — цикл ревью отключён.');
  }

  // Рабочая область (scope): устаревшую снимаем, про активную предупреждаем,
  // повреждённую просим снять — иначе guard'ы будут блокировать запись в репо.
  const scopeState = readScopeState(cfg.workspaceRoot);
  if (scopeState.state === 'stale') {
    try {
      fs.unlinkSync(scopeFilePath(cfg.workspaceRoot));
      lines.push('conveyor: снята устаревшая рабочая область этапа (старше TTL).');
    } catch {
      /* не критично */
    }
  } else if (scopeState.state === 'active') {
    const s = scopeState.scope;
    lines.push(
      `⚠ conveyor: активна рабочая область этапа «${s.stage}»` +
        (s.taskId ? ` (${s.taskId})` : '') +
        ` с ${s.setAt || '?'} — запись разрешена только в: ${s.writeRepos.length ? s.writeRepos.join(', ') : 'артефакты задачи'}. ` +
        'Если этап не выполняется — снимите: node <plugin>/core/scripts/scope.mjs clear.',
    );
  } else if (scopeState.state === 'corrupt') {
    lines.push(
      '⚠ conveyor: файл рабочей области повреждён — запись в репозитории заблокирована. ' +
        'Снимите: node <plugin>/core/scripts/scope.mjs clear.',
    );
  }

  // Легаси-уборка: scope раньше жил в .cache/active-scope.json — убрать
  // старый файл и пустые каталоги .cache/repos и .cache (rmdir не трогает
  // непустые: клоны при repoCache остаются).
  try {
    fs.unlinkSync(path.join(cfg.workspaceRoot, LEGACY_SCOPE_FILE));
  } catch {
    /* отсутствует */
  }
  for (const d of [
    path.join(cfg.workspaceRoot, '.cache', 'repos'),
    path.join(cfg.workspaceRoot, '.cache'),
  ]) {
    try {
      fs.rmdirSync(d);
    } catch {
      /* не пустой или отсутствует */
    }
  }

  if (lines.length) emitContext(lines.join('\n'));
}

try {
  main();
} catch {
  /* fail-open */
}
