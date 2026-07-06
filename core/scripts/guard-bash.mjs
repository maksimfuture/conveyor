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
  REPO_KEYS,
} from './lib/config.mjs';

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
function subCommands(command) {
  return command
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

function mainBranches(cfg) {
  const set = new Set();
  for (const key of REPO_KEYS) {
    const b = cfg.links[key] && cfg.links[key].mainBranch;
    if (b) set.add(b);
  }
  return set;
}

// git-подкоманды, мутирующие рабочее дерево/историю рабочей копии.
const MUTATING_GIT = new Set([
  'checkout', 'switch', 'restore', 'stash', 'merge', 'rebase', 'cherry-pick',
  'reset', 'clean', 'commit', 'am', 'apply', 'revert', 'rm', 'mv', 'worktree',
]);

// Определяем подкоманду git, пропуская глобальные флаги и -C <path>.
function gitSubcommand(rest) {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '-C' || t === '-c') {
      i++;
      continue;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

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
      const br = rest[delIdx + 1];
      if (br && mains.has(br)) {
        return { decision: 'deny', reason: `удаление основной ветки ${br} запрещено.` };
      }
    }
    for (const t of rest) {
      if (mains.has(t)) {
        return { decision: 'deny', reason: `push в основную ветку ${t} запрещён; работайте в ветке задачи.` };
      }
      if (t.includes(':')) {
        const dst = t.split(':').pop();
        if (mains.has(dst)) {
          return { decision: 'deny', reason: `push в основную ветку ${dst} запрещён.` };
        }
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
    for (const key of REPO_KEYS) {
      const root = repoRootFor(cfg, key);
      if (root && isInside(real, realResolve(root))) {
        if (!scope.writeRepos.includes(key)) {
          return {
            decision: 'ask',
            reason:
              `git ${sub} в репозитории «${key}» вне рабочей области этапа ` +
              `${scope.stage || '?'} — подтвердите (или scope.mjs clear, если этап не идёт).`,
          };
        }
        break;
      }
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
