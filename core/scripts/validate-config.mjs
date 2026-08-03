#!/usr/bin/env node
// validate-config.mjs — SessionStart hook (spec 8.1) and the first-step check
// that stage scripts reuse (spec 8.3).
//
// Behaviour:
//   - No settings.json in cwd            -> silent, exit 0 (fail-open).
//   - settings.json present, но ссылка   -> emit additionalContext warning
//     на репозиторий пустая / git-URL /      naming the repos + blocked stages.
//     ведёт за пределы проекта
//   - Also lists active tasks (some stage done, some not) as a nudge.
//
// Reads the hook JSON from stdin (SessionStart passes { cwd, ... }); falls
// back to process.cwd() when run directly. Any internal error is swallowed
// (fail-open) so a broken validator never blocks a session.

import fs from 'node:fs';
import path from 'node:path';
import {
  readConfig,
  readJsonFile,
  readScopeState,
  requiredRepoKeys,
  STAGE_NAMES,
  scopeFilePath,
  LEGACY_SCOPE_FILE,
} from './lib/config.mjs';

// Этапы, которым нужна рабочая копия, выводим из ядра, а не дублируем списком:
// иначе переименование этапа тихо роняет его в `default: []` и подсказка
// «Заблокированы этапы» схлопывается в пустую.
const STAGES_NEEDING_REPO = STAGE_NAMES.filter(
  (stage) => requiredRepoKeys(stage, 'FE').length || requiredRepoKeys(stage, 'BE').length,
);

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
        const meta = readJsonFile(metaPath);
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
  } else {
    // Ссылка непригодна в трёх случаях: она пустая, задана git-URL (плагин не
    // клонирует) ИЛИ ведёт за пределы рабочего репозитория. Третью категорию
    // берём из уже посчитанного resolve-config поля inside — второго критерия
    // границы проекта не заводим.
    const outsideLinks = Object.entries(cfg.links)
      .filter(([, l]) => l.value && !l.isGitUrl && !l.inside)
      .map(([key]) => key);
    const unusable = new Set([...cfg.missingLinks, ...cfg.urlLinks, ...outsideLinks]);
    if (unusable.size) {
      // Map each unusable link to the stages it blocks.
      const blocked = new Set();
      for (const stage of STAGES_NEEDING_REPO) {
        const keys = requiredRepoKeys(stage, 'FE').concat(requiredRepoKeys(stage, 'BE'));
        for (const key of new Set(keys)) {
          if (unusable.has(key)) blocked.add(stage);
        }
      }
      if (cfg.missingLinks.length) {
        lines.push(`⚠ conveyor: не заданы пути к рабочим копиям (repos.*.link): ${cfg.missingLinks.join(', ')}.`);
      }
      if (cfg.urlLinks.length) {
        lines.push(
          `⚠ conveyor: ссылки заданы git-URL: ${cfg.urlLinks.join(', ')} — плагин не клонирует. ` +
            'Склонируйте репозитории сами и укажите пути в settings.json.',
        );
      }
      if (outsideLinks.length) {
        lines.push(
          `⚠ conveyor: рабочие копии вне рабочего репозитория: ${outsideLinks.join(', ')}. ` +
            'Путь в repos.*.link резолвится от корня рабочего репозитория и обязан остаться ' +
            'внутри него (например repos/backend).',
        );
      }
      lines.push(
        blocked.size
          ? `Заблокированы этапы: ${[...blocked].join(', ')}. Запустите /conveyor:setup.`
          : 'Запустите /conveyor:setup.',
      );
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

  // Мусорный файл `nul` в корне workspace — след cmd-идиомы `> nul`
  // (в bash-подобной оболочке она СОЗДАЁТ файл). На Windows нужен префикс
  // \\?\: без него имя `nul` парсится как NUL-девайс, а не файл на диске.
  const nulPath = path.join(cfg.workspaceRoot, 'nul');
  const nulReal = process.platform === 'win32' ? '\\\\?\\' + nulPath : nulPath;
  try {
    if (fs.existsSync(nulReal)) {
      fs.unlinkSync(nulReal);
      lines.push('conveyor: удалён мусорный файл `nul` (след cmd-идиомы `> nul`).');
    }
  } catch {
    lines.push('⚠ conveyor: в корне workspace лежит файл `nul` (след `> nul`) — удалите вручную.');
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
