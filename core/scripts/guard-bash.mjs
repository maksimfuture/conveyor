#!/usr/bin/env node
// guard-bash.mjs — PreToolUse hook for Bash (spec 8.1 + stage scope).
//
// Rules are computed from the command TEXT (plus the declared cwd); repo
// state is never queried (slow/flaky from a hook):
//   deny — git push --force / --force-with-lease
//   deny — push to a main branch (any repos.*.mainBranch)
//   deny — deleting a main branch (branch -d/-D or push --delete)
//   deny — file writes outside allowed roots / outside the stage scope
//          (redirects, tee, dd of=, sed -i, cp/mv/rsync/install, rm/rmdir,
//           touch/mkdir, ln, git apply -C)
//   ask  — git reset --hard, git clean -f, any other git push
//   ask  — working-tree-mutating git (checkout/restore/stash/…) in a repo
//          OUTSIDE the active stage scope
//   ask  — write targets / cd that contain $VAR, backticks or ~ (нельзя
//          вычислить реальный путь)
//   allow — everything else
//
// `cd`/`pushd` inside compound commands IS tracked: relative targets resolve
// against the effective cwd, not the session cwd.
//
// Workspace resolution does NOT trust payload.cwd alone (an agent can `cd`
// out of the workspace): readConfigForHook falls back to
// $CLAUDE_PROJECT_DIR / $CONVEYOR_WORKSPACE.
//
// Fail policy: no conveyor workspace found anywhere -> allow silently.
// Internal errors -> deny (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import {
  readConfigForHook,
  checkWrite,
  readScope,
  repoRootFor,
  realResolve,
  isInside,
  unitIds,
} from './lib/config.mjs';
import { joinContinuations, gitSubcommand, gitArgs, normalizeRefspec } from './lib/git-args.mjs';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function decide(decision, reason) {
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

// Split a shell line into simple sub-commands on && ; | to inspect each.
// Продолжения строк склеиваем ДО разбиения: `git \`+перенос+`push --force` —
// это одна команда, а не «git» и «push --force». Раньше она разъезжалась на
// две половины, и ни одна под git-гарды не попадала.
function subCommands(command) {
  return joinContinuations(command)
    .split(/&&|\|\||;|\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(cmd) {
  // Rough tokenizer: strips simple quotes, splits on whitespace.
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// $VAR / `...` / ~ — путь не вычислить лексически.
function hasSubstitution(s) {
  return /[$`]/.test(s) || s === '~' || s.startsWith('~/');
}

// Имена устройств cmd.exe: в POSIX-оболочке `> nul` СОЗДАЁТ файл nul —
// частая ошибка Windows-привычки. Отбрасывать вывод надо в /dev/null.
const WIN_DEVICE = /^(nul|con|prn|aux|com[1-9]|lpt[1-9])$/i;

function nonFlags(args) {
  return args.filter((t) => !t.startsWith('-'));
}

// Collect write-target paths of one simple command (best-effort deny-list).
function collectWriteTargets(sub, tok) {
  const targets = [];

  // > file / >> file (включая 2>file); дескрипторные формы (>&2) отбрасываем.
  const redir = /(?:^|\s)\d?>>?\s*("[^"]+"|'[^']+'|[^\s|;&]+)/g;
  let m;
  while ((m = redir.exec(sub))) {
    const t = m[1].replace(/^['"]|['"]$/g, '');
    if (!t.startsWith('&')) targets.push(t);
  }

  const cmd = tok[0];
  const args = tok.slice(1);
  switch (cmd) {
    case 'tee':
      targets.push(...nonFlags(args));
      break;
    case 'dd':
      for (const a of args) {
        const mm = a.match(/^of=(.+)$/);
        if (mm) targets.push(mm[1]);
      }
      break;
    case 'sed': {
      // -i и -i.bak (суффиксная форма); первый non-flag — скрипт, остальные — файлы.
      if (args.some((a) => a.startsWith('-i'))) {
        targets.push(...nonFlags(args).slice(1));
      }
      break;
    }
    case 'cp':
    case 'mv':
    case 'rsync':
    case 'install': {
      const ti = args.indexOf('-t');
      if (ti !== -1 && args[ti + 1]) targets.push(args[ti + 1]);
      else {
        const nf = nonFlags(args);
        if (nf.length >= 2) targets.push(nf[nf.length - 1]);
      }
      break;
    }
    case 'rm':
    case 'rmdir':
    case 'touch':
    case 'mkdir':
      // Удаление/создание — тоже мутация рабочей копии.
      targets.push(...nonFlags(args));
      break;
    case 'ln': {
      const nf = nonFlags(args);
      if (nf.length) targets.push(nf[nf.length - 1]);
      break;
    }
    case 'git': {
      if (args.includes('apply')) {
        const ci = args.indexOf('-C');
        if (ci !== -1 && args[ci + 1]) targets.push(args[ci + 1]);
      }
      break;
    }
    default:
      break;
  }
  return targets;
}

// Основные ветки ВСЕХ рабочих копий: у бэкенда их четыре, и у каждой части
// своя настройка. Пропусти хоть одну — push в её основную ветку пройдёт.
function mainBranches(cfg) {
  const set = new Set();
  for (const id of unitIds(cfg)) {
    const b = cfg.links[id] && cfg.links[id].mainBranch;
    if (b) set.add(b);
  }
  return set;
}

// git-подкоманды, мутирующие рабочее дерево/историю рабочей копии.
const MUTATING_GIT = new Set([
  'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick',
  'reset', 'clean', 'commit', 'am', 'apply', 'revert', 'rm', 'mv', 'worktree',
]);

// Разбор аргументов git — в core/scripts/lib/git-args.mjs (gitSubcommand,
// gitArgs, normalizeRefspec). Держится отдельно: от него зависит, найдут ли
// git-гарды, к чему прицепиться.

function classifyGit(tok, mains, cfg, effCwd) {
  if (tok[0] !== 'git') return null;
  const rest = tok.slice(1);
  const has = (f) => rest.includes(f);
  const sub = gitSubcommand(rest);

  if (sub === 'push') {
    if (has('--force') || has('-f') || has('--force-with-lease')) {
      return { decision: 'deny', reason: 'push --force запрещён политикой conveyor.' };
    }
    const delIdx = rest.indexOf('--delete');
    if (delIdx !== -1) {
      const br = normalizeRefspec(rest[delIdx + 1]).branch;
      if (br && mains.has(br)) {
        return { decision: 'deny', reason: `удаление основной ветки ${br} запрещено.` };
      }
    }
    // Цели push ищем среди аргументов ПОДКОМАНДЫ: путь из `--git-dir <path>`
    // не должен приниматься за имя ветки. Каждую цель нормализуем — `+main`
    // это форс в main, `HEAD:refs/heads/main` тоже main; раньше обе формы
    // понижались до «ask».
    for (const t of gitArgs(rest)) {
      if (t.startsWith('-')) continue;
      const { branch, forced } = normalizeRefspec(t);
      if (branch && mains.has(branch)) {
        return {
          decision: 'deny',
          reason: forced
            ? `push --force в основную ветку ${branch} запрещён политикой conveyor.`
            : `push в основную ветку ${branch} запрещён; работайте в ветке задачи.`,
        };
      }
      if (forced) {
        return { decision: 'deny', reason: `push --force (refspec «${t}») запрещён политикой conveyor.` };
      }
    }
    return { decision: 'ask', reason: 'git push — подтвердите отправку в удалённый репозиторий.' };
  }

  if (sub === 'branch' && (has('-d') || has('-D'))) {
    for (const t of rest.slice(1)) {
      if (mains.has(t)) return { decision: 'deny', reason: `удаление основной ветки ${t} запрещено.` };
    }
  }

  if (sub === 'reset' && has('--hard')) {
    return { decision: 'ask', reason: 'git reset --hard может потерять изменения — подтвердите.' };
  }
  if (sub === 'clean' && (has('-f') || has('-fd') || has('-df') || has('-xf'))) {
    return { decision: 'ask', reason: 'git clean -f удаляет неотслеживаемые файлы — подтвердите.' };
  }

  // Scope: мутации рабочего дерева в репозитории вне рабочей области → ask.
  const scope = readScope(cfg.workspaceRoot);
  if (scope && sub && MUTATING_GIT.has(sub)) {
    const ci = rest.indexOf('-C');
    let repoDir = null;
    if (ci !== -1 && rest[ci + 1]) {
      const v = rest[ci + 1];
      if (hasSubstitution(v)) {
        return { decision: 'ask', reason: `git ${sub}: путь -C содержит подстановку — подтвердите.` };
      }
      repoDir = effCwd ? path.resolve(effCwd, v) : path.isAbsolute(v) ? v : null;
    } else {
      repoDir = effCwd;
    }
    if (repoDir === null) {
      return { decision: 'ask', reason: `git ${sub}: не удалось вычислить целевой репозиторий (cd с подстановкой) — подтвердите.` };
    }
    const real = realResolve(repoDir);
    // Рабочие копии бывают вложенными (repos/backend и repos/backend/api),
    // поэтому решает САМАЯ ГЛУБОКАЯ подходящая — как в checkWrite. Обход по
    // порядку взял бы внешнюю и разрешил мутацию в чужой части группы.
    let hit = null;
    for (const id of unitIds(cfg)) {
      const root = repoRootFor(cfg, id);
      if (!root) continue;
      const rootReal = realResolve(root);
      if (isInside(real, rootReal) && (!hit || rootReal.length > hit.root.length)) {
        hit = { id, root: rootReal };
      }
    }
    if (hit && !scope.writeRepos.includes(hit.id)) {
      return {
        decision: 'ask',
        reason:
          `git ${sub} в репозитории «${hit.id}» вне рабочей области этапа ` +
          `${scope.stage || '?'} — подтвердите (или scope.mjs clear, если этап не идёт).`,
      };
    }
  }
  return null;
}

function main() {
  const stdin = readStdin();
  let payload = {};
  try {
    payload = JSON.parse(stdin || '{}');
  } catch {
    payload = {};
  }
  const payloadCwd = payload.cwd || process.cwd();
  const cfg = readConfigForHook(payloadCwd);
  if (!cfg.found) return; // нигде нет conveyor-workspace — allow silently

  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command) return;

  // Нечитаемый settings.json разбираем ДО использования конфигурации. Раньше
  // сюда доходил объект без `links`, дальше падал TypeError, внешний catch
  // отвечал «внутренняя ошибка», и ЛЮБАЯ команда — вплоть до `echo hi` —
  // получала deny без объяснения причины. Отказ оставляем (правила прав
  // строятся на конфигурации), но называем причину и что делать.
  if (cfg.error) {
    return decide(
      'deny',
      `conveyor: ${cfg.error}. Правила прав строятся на этом файле, поэтому команды заблокированы. ` +
        'Почините settings.json (JSON без комментариев и висячих запятых) или запустите /conveyor:setup.',
    );
  }

  const mains = mainBranches(cfg);
  let effCwd = payloadCwd; // null = неизвестен (cd с подстановкой)

  for (const sub of subCommands(command)) {
    const tok = tokenize(sub);
    if (!tok.length) continue;

    // Трекинг cd/pushd: относительные цели резолвятся от эффективного cwd.
    if (tok[0] === 'cd' || tok[0] === 'pushd') {
      const arg = tok[1];
      if (!arg || arg === '-') effCwd = null; // home / prev — не вычисляем
      else if (hasSubstitution(arg)) effCwd = null;
      else if (path.isAbsolute(arg)) effCwd = arg;
      else effCwd = effCwd ? path.resolve(effCwd, arg) : null;
      continue;
    }

    for (const t of collectWriteTargets(sub, tok)) {
      if (t.startsWith('/dev/')) continue;
      if (WIN_DEVICE.test(path.basename(t))) {
        return decide(
          'deny',
          `conveyor: «${t}» — устройство cmd.exe; в этой оболочке такой редирект СОЗДАЁТ файл. ` +
            'Отбрасывайте вывод в /dev/null; существование файла проверяйте инструментами ' +
            'платформы или node -e "process.exit(require(\'fs\').existsSync(\'<путь>\')?0:1)".',
        );
      }
      if (hasSubstitution(t)) {
        return decide('ask', `conveyor: цель записи «${t}» содержит подстановку — проверить рабочую область невозможно, подтвердите.`);
      }
      let abs;
      if (path.isAbsolute(t)) abs = t;
      else if (effCwd) abs = path.resolve(effCwd, t);
      else {
        return decide('ask', 'conveyor: не удалось вычислить рабочий каталог (cd с подстановкой) — подтвердите команду.');
      }
      const v = checkWrite(abs, cfg);
      if (!v.allowed) {
        return decide('deny', `conveyor: запись запрещена — ${abs}: ${v.reason}`);
      }
    }

    const g = classifyGit(tok, mains, cfg, effCwd);
    if (g) return decide(g.decision, `conveyor: ${g.reason}`);
  }
  // No rule matched -> allow (stay silent).
}

try {
  main();
} catch (e) {
  decide('deny', `conveyor guard-bash: внутренняя ошибка — ${e && e.message}. Команда заблокирована.`);
}
