#!/usr/bin/env node
// plan-repos.mjs — какие репозитории объявил план (CLI над lib/plan-repos.mjs).
//
// Использует /implement-plan, чтобы поставить рабочую область по плану, а не
// «на глаз»: писать разрешено ТОЛЬКО в репозитории, которые план назвал.
//
// Usage:
//   node plan-repos.mjs --file <plan.md> [--workspace <корень>] [--type FE|BE]
//
// --workspace включает сверку идентификаторов с фактическими рабочими копиями
// (settings.json). Без него — чистый разбор текста. --type добавляет к ней
// сверку с кодовой базой задачи ЭТОГО типа: репозиторий, который существует,
// но принадлежит чужой кодовой базе, — самая опасная ошибка плана, потому что
// область записи ставится ИМЕННО ПО ПЛАНУ.
//
// Output (stdout, JSON):
//   { ok, repos, fromTable, fromSteps, stepsWithoutRepo, mismatch,
//     unknown, foreign, known, problems }
// ok=false — план не годится как источник области записи: этап обязан
// остановиться и вернуть человека на /create-plan.

import fs from 'node:fs';
import { parsePlanRepos } from './lib/plan-repos.mjs';
import { readConfig, unitIds, codebaseUnits } from './lib/config.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next === undefined || next.startsWith('--') ? true : next;
      if (typeof out[a.slice(2)] === 'string') i++;
    }
  }
  return out;
}

function done(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.file !== 'string') done({ ok: false, problems: ['требуется --file <путь к plan.md>'] });
if (!fs.existsSync(args.file)) done({ ok: false, problems: [`файл не найден: ${args.file}`] });

// Необязательный флаг, потерявший значение, — не «как будто его нет»: этап
// решит, что сверка выполнена, а её не было.
for (const [flag, hint] of [
  ['workspace', 'путь к корню рабочего репозитория'],
  ['type', 'FE или BE'],
])
  if (args[flag] === true) done({ ok: false, problems: [`--${flag} требует значение (${hint})`] });

const parsed = parsePlanRepos(fs.readFileSync(args.file, 'utf8'));
const problems = [...parsed.problems];
let unknown = [];
let foreign = [];
let known = null;

if (typeof args.workspace === 'string') {
  const cfg = readConfig(args.workspace);
  if (!cfg.found) {
    problems.push('не найден рабочий репозиторий conveyor (settings.json)');
  } else if (cfg.error) {
    problems.push(cfg.error);
  } else {
    known = unitIds(cfg);
    unknown = parsed.repos.filter((r) => !known.includes(r));
    if (unknown.length) {
      problems.push(
        `в плане названы репозитории, которых нет в settings.json: ${unknown.join(', ')}. ` +
          `Допустимые: ${known.join(', ')}`,
      );
    }
    // Репозиторий ЧУЖОЙ кодовой базы существует, поэтому ни проверка выше, ни
    // guard о нём не скажут — а область записи встанет по нему. Так забытая в
    // плане FE-задачи строка-образец открыла бы запись в бэкенд.
    if (typeof args.type === 'string') {
      const mine = codebaseUnits(cfg, args.type.trim().toUpperCase());
      foreign = parsed.repos.filter((r) => known.includes(r) && !mine.includes(r));
      if (foreign.length) {
        problems.push(
          `план ${args.type}-задачи называет репозитории чужой кодовой базы: ${foreign.join(', ')}. ` +
            `Кодовая база этой задачи: ${mine.join(', ')}`,
        );
      }
    }
  }
}

done({
  ok: problems.length === 0,
  repos: parsed.repos,
  fromTable: parsed.fromTable,
  fromSteps: parsed.fromSteps,
  stepsWithoutRepo: parsed.stepsWithoutRepo,
  mismatch: parsed.mismatch,
  unknown,
  foreign,
  known,
  problems,
});
