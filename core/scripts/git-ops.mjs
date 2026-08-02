#!/usr/bin/env node
// git-ops.mjs — git helper used by the stage scripts so skills never embed git
// logic (spec 3, 4.3). All output is JSON on stdout: { ok, ... } or
// { ok:false, error }. Exit code mirrors ok. Cross-platform: shells out to the
// `git` on PATH, no bash-isms.
//
// Subcommands:
//   locate       --link <path> --workspace <root> [--name <key>]
//   clean-check  --path <p>
//   update       --path <p> --main <branch> --kind local|cache --mode read|write
//   log          --path <p> [--main <branch>] [-n <count>]
//   branch       --path <p> --branch <name> --from <mainBranch>
//   diff         --path <p> --base <ref> --head <ref>
//   analysis-head --path <p> --branch <analysisBranch> --main <mainBranch> --taskid <id>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isGitUrl, linkInsideWorkspace } from './lib/config.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else if (a === '-n') {
      out.n = argv[++i];
    } else {
      out._.push(a);
    }
  }
  return out;
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.stdout || e.message || '').toString().trim() };
  }
}

function done(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

function fail(error) {
  done({ ok: false, error });
}

function isClean(repoPath) {
  const r = tryGit(repoPath, ['status', '--porcelain']);
  if (!r.ok) throw new Error(r.out);
  return r.out === '';
}

function currentBranch(repoPath) {
  const r = tryGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out : null;
}

function revParse(repoPath, ref) {
  const r = tryGit(repoPath, ['rev-parse', ref]);
  return r.ok ? r.out : null;
}

// ---- subcommands ---------------------------------------------------------

function cmdLocate(a) {
  const link = a.link;
  const workspace = a.workspace;
  const name = a.name || 'repo';
  if (!link) return fail('locate: --link required');
  // Ссылка — путь ОТ корня рабочего репозитория (settings.json: repos.<key>.link),
  // а не от каталога, из которого запущен скрипт: этапы вызывают git-ops из
  // произвольного cwd, и резолв от него дал бы «не найдено» на верном пути.
  if (!workspace) return fail('locate: --workspace required');

  // Плагин НЕ клонирует: ссылка — путь к уже существующей рабочей копии.
  if (isGitUrl(link)) {
    return fail(
      `ссылка ${name} задана git-URL, а нужен путь к рабочей копии. ` +
        'Склонируйте репозиторий сами и укажите путь в settings.json (repos.<key>.link).',
    );
  }
  const dest = path.resolve(workspace, link);
  // Критерий границы проекта — общий с ядром (linkInsideWorkspace): здесь он
  // применяется к тому же link, что и в readConfig. Без этого locate отвечал
  // ok:true на копию снаружи, этап рапортовал «найдена», а конфигурация
  // разваливалась много позже — на guard-writes, чужим текстом.
  if (!linkInsideWorkspace(link, workspace)) {
    return fail(
      `рабочая копия ${name} лежит вне рабочего репозитория: ${dest}. ` +
        `Путь в settings.json (repos.<key>.link) резолвится от корня рабочего репозитория (${workspace}) ` +
        'и обязан остаться внутри рабочего репозитория (например repos/backend): ' +
        'иначе GigaCode такую конфигурацию не разрешит.',
    );
  }
  if (!fs.existsSync(dest)) {
    return fail(`рабочая копия ${name} не найдена: ${dest}. Склонируйте репозиторий в этот каталог.`);
  }
  if (!fs.existsSync(path.join(dest, '.git'))) return fail(`не git-репозиторий: ${dest}`);
  return done({ ok: true, path: dest, kind: 'local' });
}

function cmdCleanCheck(a) {
  if (!a.path) return fail('clean-check: --path required');
  try {
    const clean = isClean(a.path);
    const status = clean ? '' : git(a.path, ['status', '--short']);
    return done({ ok: true, clean, status, branch: currentBranch(a.path) });
  } catch (e) {
    return fail(e.message);
  }
}

function cmdUpdate(a) {
  const repoPath = a.path;
  const main = a.main;
  const kind = a.kind || 'local';
  const mode = a.mode || 'read';
  if (!repoPath || !main) return fail('update: --path and --main required');

  const fetch = tryGit(repoPath, ['fetch', 'origin']);
  // fetch failure is non-fatal (offline / no origin) — record and continue.
  const warnings = [];
  if (!fetch.ok) warnings.push(`git fetch не удался: ${fetch.out}`);

  let clean;
  try {
    clean = isClean(repoPath);
  } catch (e) {
    return fail(e.message);
  }

  if (mode === 'write' && !clean) {
    return done({
      ok: false,
      error: 'рабочая копия не чистая — этап записи остановлен.',
      status: git(repoPath, ['status', '--short']),
      warnings,
    });
  }

  if (kind === 'cache') {
    // Cache clone belongs to the plugin: switch to main and fast-forward.
    const co = tryGit(repoPath, ['checkout', main]);
    if (!co.ok) warnings.push(`checkout ${main}: ${co.out}`);
    const pull = tryGit(repoPath, ['pull', '--ff-only', 'origin', main]);
    if (!pull.ok) warnings.push(`pull ${main}: ${pull.out}`);
  } else {
    // Local path: never switch the user's checked-out branch.
    const cur = currentBranch(repoPath);
    if (cur === main) {
      if (clean) {
        const pull = tryGit(repoPath, ['pull', '--ff-only']);
        if (!pull.ok) warnings.push(`pull: ${pull.out}`);
      } else {
        warnings.push('working tree грязный: обновление пропущено, база — origin/' + main);
      }
    } else {
      // Update main without checking it out.
      const upd = tryGit(repoPath, ['fetch', 'origin', `${main}:${main}`]);
      if (!upd.ok) warnings.push(`обновление ${main} без переключения не удалось: ${upd.out}`);
    }
  }

  const mainSha = revParse(repoPath, main) || revParse(repoPath, `origin/${main}`);
  return done({ ok: true, mainSha, clean, warnings });
}

function cmdLog(a) {
  if (!a.path) return fail('log: --path required');
  const n = a.n || '20';
  const range = a.main ? `origin/${a.main}..HEAD` : `-n${n}`;
  const logRes = tryGit(a.path, ['log', `-n${n}`, '--pretty=%h %an %ad %s', '--date=short']);
  const filesRes = tryGit(a.path, ['log', `-n${n}`, '--name-only', '--pretty=format:%h %s']);
  return done({
    ok: true,
    recent: logRes.ok ? logRes.out : '',
    changedFiles: filesRes.ok ? filesRes.out : '',
    note: range, // informational
  });
}

function cmdBranch(a) {
  const repoPath = a.path;
  const branch = a.branch;
  const from = a.from;
  if (!repoPath || !branch || !from) return fail('branch: --path --branch --from required');

  const exists = tryGit(repoPath, ['rev-parse', '--verify', branch]).ok;
  if (exists) {
    const co = tryGit(repoPath, ['checkout', branch]);
    if (!co.ok) return fail(`checkout существующей ветки не удался: ${co.out}`);
    return done({ ok: true, branch, created: false, head: revParse(repoPath, 'HEAD') });
  }
  const co = tryGit(repoPath, ['checkout', '-b', branch, from]);
  if (!co.ok) {
    // maybe `from` needs origin/ prefix
    const co2 = tryGit(repoPath, ['checkout', '-b', branch, `origin/${from}`]);
    if (!co2.ok) return fail(`создание ветки не удалось: ${co.out}`);
  }
  return done({ ok: true, branch, created: true, head: revParse(repoPath, 'HEAD') });
}

function cmdDiff(a) {
  const repoPath = a.path;
  const base = a.base;
  const head = a.head;
  if (!repoPath || !base || !head) return fail('diff: --path --base --head required');
  const mb = tryGit(repoPath, ['merge-base', base, head]);
  const mergeBase = mb.ok ? mb.out : base;
  const diff = tryGit(repoPath, ['diff', `${base}...${head}`]);
  if (!diff.ok) return fail(`diff не удался: ${diff.out}`);
  return done({
    ok: true,
    mergeBase,
    baseSha: mergeBase,
    headSha: revParse(repoPath, head),
    diff: diff.out,
  });
}

function cmdAnalysisHead(a) {
  const repoPath = a.path;
  const branch = a.branch;
  const main = a.main;
  const taskid = a.taskid || '';
  if (!repoPath || !branch || !main) return fail('analysis-head: --path --branch --main required');

  tryGit(repoPath, ['fetch', 'origin']);

  // 1) origin/<branch>
  if (revParse(repoPath, `origin/${branch}`)) {
    return done({ ok: true, headRef: `origin/${branch}`, source: 'origin', sha: revParse(repoPath, `origin/${branch}`) });
  }
  // 2) local <branch>
  if (revParse(repoPath, branch)) {
    return done({ ok: true, headRef: branch, source: 'local', sha: revParse(repoPath, branch) });
  }
  // 3) merged: find the merge commit of the branch in main, take ^2
  const log = tryGit(repoPath, [
    'log',
    '--merges',
    '--grep',
    taskid || branch,
    '--pretty=%H',
    `origin/${main}`,
  ]);
  if (log.ok && log.out) {
    const merge = log.out.split('\n')[0];
    const second = revParse(repoPath, `${merge}^2`);
    if (second) {
      return done({ ok: true, headRef: `${merge}^2`, source: 'merged', sha: second });
    }
  }
  return done({
    ok: false,
    error:
      'не удалось определить головной ref ветки анализа (squash/rebase?). ' +
      'Укажите диапазон вручную (--since).',
  });
}

// ---- dispatch ------------------------------------------------------------

const [, , sub, ...rest] = process.argv;
const args = parseArgs(rest);

try {
  switch (sub) {
    case 'locate':
      cmdLocate(args);
      break;
    case 'clean-check':
      cmdCleanCheck(args);
      break;
    case 'update':
      cmdUpdate(args);
      break;
    case 'log':
      cmdLog(args);
      break;
    case 'branch':
      cmdBranch(args);
      break;
    case 'diff':
      cmdDiff(args);
      break;
    case 'analysis-head':
      cmdAnalysisHead(args);
      break;
    default:
      fail(`неизвестная подкоманда: ${sub || '(нет)'}. См. шапку git-ops.mjs.`);
  }
} catch (e) {
  fail(String(e && e.message ? e.message : e));
}
