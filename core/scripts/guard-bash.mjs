#!/usr/bin/env node
// guard-bash.mjs — PreToolUse hook for Bash (spec 8.1).
//
// Rules depend ONLY on the command text (never on repo state — running git
// status from a hook would be slow and flaky):
//   deny  — git push --force / --force-with-lease
//   deny  — push to a main branch (any repos.*.mainBranch)
//   deny  — deleting a main branch (branch -d/-D or push --delete)
//   deny  — file writes outside allowed roots (>, >>, sed -i, cp/mv, git apply)
//   ask   — git reset --hard, git clean -f, any other git push
//   allow — everything else
//
// Fail policy: no settings.json in cwd -> allow silently. Once config is
// loaded, unparyseable-but-risky commands fall through to allow only when no
// rule matched; internal errors deny (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import { readConfig, REPO_KEYS, isPathAllowed } from './lib/config.mjs';

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

function mainBranches(cfg) {
  const set = new Set();
  for (const key of REPO_KEYS) {
    const b = cfg.links[key] && cfg.links[key].mainBranch;
    if (b) set.add(b);
  }
  return set;
}

// Redirection / write targets that point outside allowed roots.
function badWriteTarget(cmd, cfg, cwd) {
  const targets = [];

  // > file  and  >> file
  const redir = /(?:^|\s)>>?\s*("[^"]+"|'[^']+'|[^\s|;&]+)/g;
  let m;
  while ((m = redir.exec(cmd))) targets.push(m[1].replace(/^['"]|['"]$/g, ''));

  const tok = tokenize(cmd);
  // sed -i <file...>
  if (tok[0] === 'sed' && tok.includes('-i')) {
    for (const t of tok.slice(1)) if (!t.startsWith('-') && !t.includes('/dev/')) targets.push(t);
  }
  // cp / mv destination (last non-flag arg)
  if (tok[0] === 'cp' || tok[0] === 'mv') {
    const args = tok.slice(1).filter((t) => !t.startsWith('-'));
    if (args.length >= 2) targets.push(args[args.length - 1]);
  }
  // git apply writes into the working tree of whatever -C points to; flag it
  // only when an explicit outside path is given.
  if (tok[0] === 'git' && tok.includes('apply')) {
    const ci = tok.indexOf('-C');
    if (ci !== -1 && tok[ci + 1]) targets.push(tok[ci + 1]);
  }

  for (const t of targets) {
    if (t.startsWith('/dev/') || t === '/dev/null') continue;
    const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t);
    if (!isPathAllowed(abs, cfg)) return abs;
  }
  return null;
}

function classifyGit(tok, mains) {
  if (tok[0] !== 'git') return null;
  const rest = tok.slice(1);
  const has = (f) => rest.includes(f);

  if (rest[0] === 'push') {
    if (has('--force') || has('-f') || has('--force-with-lease')) {
      return { decision: 'deny', reason: 'push --force запрещён политикой conveyor.' };
    }
    // push --delete <branch> / push origin :branch
    const delIdx = rest.indexOf('--delete');
    if (delIdx !== -1) {
      const br = rest[delIdx + 1];
      if (br && mains.has(br)) {
        return { decision: 'deny', reason: `удаление основной ветки ${br} запрещено.` };
      }
    }
    // push into a main branch
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

  if (rest[0] === 'branch' && (has('-d') || has('-D'))) {
    for (const t of rest.slice(1)) {
      if (mains.has(t)) return { decision: 'deny', reason: `удаление основной ветки ${t} запрещено.` };
    }
  }

  if (rest[0] === 'reset' && has('--hard')) {
    return { decision: 'ask', reason: 'git reset --hard может потерять изменения — подтвердите.' };
  }
  if (rest[0] === 'clean' && (has('-f') || has('-fd') || has('-df') || has('-xf'))) {
    return { decision: 'ask', reason: 'git clean -f удаляет неотслеживаемые файлы — подтвердите.' };
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
  const cwd = payload.cwd || process.cwd();
  const cfg = readConfig(cwd);
  if (!cfg.found) return; // allow silently

  const command = (payload.tool_input && payload.tool_input.command) || '';
  if (!command) return; // nothing to inspect

  const mains = mainBranches(cfg);

  for (const sub of subCommands(command)) {
    const bad = badWriteTarget(sub, cfg, cwd);
    if (bad) {
      return decide('deny', `conveyor: запись вне разрешённых корней — ${bad}.`);
    }
    const g = classifyGit(tokenize(sub), mains);
    if (g && g.decision === 'deny') return decide('deny', `conveyor: ${g.reason}`);
    if (g && g.decision === 'ask') return decide('ask', `conveyor: ${g.reason}`);
  }
  // No rule matched -> allow (stay silent).
}

try {
  main();
} catch (e) {
  decide('deny', `conveyor guard-bash: внутренняя ошибка — ${e && e.message}. Команда заблокирована.`);
}
