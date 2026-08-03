#!/usr/bin/env node
// migrate-workspace.mjs — перевод рабочего репозитория с conveyor 1.x на 2.0.
//
// Что делает:
//   1. settings.json: ссылки ${VAR} -> пути repos/<dir>, mainBranch из .env
//      подставляется значением, ключ repoCache удаляется;
//   2. meta.json каждой задачи: schemaVersion=2, stages.feature сворачивается
//      в stages.specification.analysisDone, analysisShaAtFeature ->
//      analysisBaseSha, stages['requirements-auto-test'] ->
//      stages['autotest-plan'], добавляется intentId:null;
//   3. requirements-auto-test.md -> autotest-plan.md;
//   4. .gitignore дополняется строками repos/ и .env.
// feature.md НЕ удаляется: это результат работы аналитика, он остаётся в
// папке задачи как легаси-артефакт.
//
// Использование:
//   node migrate-workspace.mjs [workspaceRoot]            # сухой прогон
//   node migrate-workspace.mjs [workspaceRoot] --apply    # записать
// Переданный явно путь обязан существовать; подъём вверх к ближайшему
// settings.json остаётся только для запуска без аргумента.
//
// Вывод (stdout, JSON, всегда):
//   { ok, applied, workspaceRoot, changes: [...], warnings: [...], writeErrors: [...] }
// writeErrors — операции записи, которые не удались (файл только для чтения,
// открыт редактором, OneDrive, антивирус): остальные задачи при этом
// мигрированы. ok:false и ненулевой код возврата — либо миграцию не начать,
// либо часть записей отказала.

import fs from 'node:fs';
import path from 'node:path';
import { findWorkspaceRoot, parseEnvFile, readJsonFile, REPO_KEYS, REPO_DIRS } from './lib/config.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const argPath = argv.find((a) => !a.startsWith('--'));

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

// Путь передают руками (чек-лист велит указывать копию репозитория), и опечатка
// в нём под --apply означала бы правки в СОВСЕМ ДРУГОМ репозитории: от
// несуществующего каталога вверх не поднимаемся, а останавливаемся.
let workspaceRoot;
if (argPath === undefined) {
  workspaceRoot = findWorkspaceRoot(process.cwd());
  if (!workspaceRoot) fail('не найден settings.json');
} else {
  const abs = path.resolve(argPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(`каталог не найден: ${abs}`);
  // Названный каталог обязан САМ быть корнем: подъём вверх отсюда увёл бы
  // миграцию в соседний репозиторий (копия без settings.json, копия внутри
  // настоящего workspace) — под --apply это правки не там, где имел в виду
  // человек.
  if (!fs.existsSync(path.join(abs, 'settings.json'))) {
    fail(`в каталоге нет settings.json: ${abs} — укажите корень рабочего репозитория conveyor`);
  }
  workspaceRoot = abs;
}

const changes = [];
const warnings = [];
const writeErrors = [];

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Сухой прогон — режим по умолчанию: скрипт трогает чужой рабочий репозиторий
// с реальными задачами, поэтому запись включает только явный --apply.
// Отказавшая запись (файл только для чтения) не обрывает миграцию: сбой идёт
// в writeErrors, остальные задачи обрабатываются, stdout остаётся JSON.
function attempt(what, fn) {
  if (!apply) return true;
  try {
    fn();
    return true;
  } catch (e) {
    writeErrors.push(`${what}: ${e.message}`);
    return false;
  }
}

// ---- 1. settings.json -----------------------------------------------------
const settingsPath = path.join(workspaceRoot, 'settings.json');
let settings;
try {
  settings = readJsonFile(settingsPath);
} catch (e) {
  fail(`settings.json: ${e.message}`);
}

const env = parseEnvFile(path.join(workspaceRoot, '.env'));
const varOf = (v) => (typeof v === 'string' ? (v.match(/^\$\{([A-Za-z0-9_]+)\}$/) || [])[1] : undefined);

// settings.json версии 1.x правили руками, и форма в нём может быть любой.
// Непонятную запись НЕ приводим к объекту молча (это стёрло бы то, что там
// написано), а называем в warnings — как уже сделано для битого meta.json.
const settingsChanges = [];
if (!isObject(settings)) {
  warnings.push('settings.json: ожидался объект — настройки не мигрированы');
} else {
  if (!('repos' in settings)) settings.repos = {};
  if (!isObject(settings.repos)) {
    warnings.push('settings.repos задан не объектом — ссылки на репозитории не мигрированы, задайте их вручную');
  } else {
    for (const key of REPO_KEYS) {
      if (key in settings.repos && !isObject(settings.repos[key])) {
        warnings.push(
          `settings.repos.${key} задан не объектом (${JSON.stringify(settings.repos[key])}) — ` +
            `приведите к виду {"link": "${REPO_DIRS[key]}", "mainBranch": "main"} вручную`,
        );
        continue;
      }
      const repo = settings.repos[key] || (settings.repos[key] = {});
      const linkVar = varOf(repo.link);
      const oldValue = linkVar ? (env[linkVar] || '') : (repo.link || '');
      if (repo.link !== REPO_DIRS[key]) {
        repo.link = REPO_DIRS[key];
        settingsChanges.push(`settings.repos.${key}.link -> ${REPO_DIRS[key]}`);
        if (oldValue) warnings.push(`${key}: раньше ссылка вела на «${oldValue}» — склонируйте репозиторий в ${REPO_DIRS[key]}`);
      }
      const branchVar = varOf(repo.mainBranch);
      const branch = (branchVar ? env[branchVar] : repo.mainBranch) || 'main';
      if (repo.mainBranch !== branch) {
        repo.mainBranch = branch;
        settingsChanges.push(`settings.repos.${key}.mainBranch -> ${branch}`);
      }
    }
  }
  if ('repoCache' in settings) {
    delete settings.repoCache;
    settingsChanges.push('settings.repoCache удалён');
  }
  if (
    settingsChanges.length &&
    attempt('запись settings.json', () => fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n'))
  ) {
    changes.push(...settingsChanges);
  }
}

// ---- 2-3. задачи ----------------------------------------------------------

// Канонический порядок этапов в meta.json (core/stages/task-status.md). Этапы
// пересобираем в нём при записи: переименованный autotest-plan, дописанный
// в конец, оказался бы ПОСЛЕ implement-auto-test — и «следующий этап»
// в /task-status считался бы по нему.
const META_STAGE_ORDER = ['specification', 'plan', 'implement-plan', 'autotest-plan', 'implement-auto-test'];

function orderedStages(stages) {
  const out = {};
  for (const name of META_STAGE_ORDER) if (name in stages) out[name] = stages[name];
  // Незнакомые этапы (правки руками) сохраняем в конце: миграция ничего не теряет.
  for (const name of Object.keys(stages)) if (!(name in out)) out[name] = stages[name];
  return out;
}

// Форма meta.json: сам объект, stages — объект объектов. Всё прочее не трогаем
// и называем в warnings — одна нестандартная задача не должна оставить
// остальные не мигрированными.
function metaShapeProblem(meta) {
  if (!isObject(meta)) return 'meta.json не объект';
  if ('stages' in meta) {
    if (!isObject(meta.stages)) return 'meta.stages не объект';
    if (Object.values(meta.stages).some((s) => !isObject(s))) return 'этапы в meta.stages заданы не объектами';
  }
  return null;
}

const tasksDir = path.join(workspaceRoot, 'tasks');
for (const type of ['FE', 'BE']) {
  const dir = path.join(tasksDir, type);
  if (!fs.existsSync(dir)) continue;
  for (const taskId of fs.readdirSync(dir)) {
    const taskDir = path.join(dir, taskId);
    const metaPath = path.join(taskDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      let meta = null;
      try {
        meta = readJsonFile(metaPath);
      } catch {
        // Одна битая задача не должна оставить остальные не мигрированными.
        warnings.push(`${taskId}: meta.json не разбирается — пропущен`);
      }
      const problem = meta === null ? null : metaShapeProblem(meta);
      if (problem) {
        warnings.push(`${taskId}: ${problem} — пропущен`);
        meta = null;
      }
      if (meta && meta.schemaVersion !== 2) {
        meta.stages = meta.stages || {};
        meta.stages.specification = meta.stages.specification || { done: false };
        // Пройденный этап feature = правки анализа уже внесены: новая
        // двухфазная спецификация начнёт сразу с фазы B. Запускать её для
        // такой задачи надо по TASK-ID: intentId у неё null и intent'а не
        // существует (см. core/stages/create-specification.md,
        // «Идемпотентность»).
        const featureDone = !!(meta.stages.feature && meta.stages.feature.done);
        meta.stages.specification.analysisDone = featureDone;
        meta.stages.specification.specDone = !!meta.stages.specification.done;
        delete meta.stages.feature;
        if (meta.analysisShaAtFeature) {
          meta.analysisBaseSha = meta.analysisShaAtFeature;
          delete meta.analysisShaAtFeature;
        }
        if (meta.stages['requirements-auto-test']) {
          meta.stages['autotest-plan'] = meta.stages['requirements-auto-test'];
          delete meta.stages['requirements-auto-test'];
        }
        if (!('intentId' in meta)) meta.intentId = null;
        meta.stages = orderedStages(meta.stages);
        meta.schemaVersion = 2;
        if (
          attempt(`запись ${type}/${taskId}/meta.json`, () =>
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n'),
          )
        ) {
          changes.push(`${type}/${taskId}/meta.json -> schemaVersion 2`);
        }
      }
    }
    // Переименование, а не чтение-запись-удаление: артефакт задачи не должен
    // потеряться, если запись оборвётся.
    const oldArtifact = path.join(taskDir, 'requirements-auto-test.md');
    const newArtifact = path.join(taskDir, 'autotest-plan.md');
    if (fs.existsSync(oldArtifact) && !fs.existsSync(newArtifact)) {
      if (attempt(`переименование ${type}/${taskId}/requirements-auto-test.md`, () => fs.renameSync(oldArtifact, newArtifact)))
        changes.push(`${type}/${taskId}: requirements-auto-test.md -> autotest-plan.md`);
    }
  }
}

// ---- 4. .gitignore --------------------------------------------------------
const giPath = path.join(workspaceRoot, '.gitignore');
const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
const lines = gi.split(/\r?\n/);
const need = ['repos/', '.env'];
const add = need.filter((n) => !lines.some((l) => l.trim() === n));
if (add.length) {
  const text = (gi.endsWith('\n') || gi === '' ? gi : gi + '\n') + add.join('\n') + '\n';
  if (attempt('запись .gitignore', () => fs.writeFileSync(giPath, text)))
    changes.push(`.gitignore += ${add.join(', ')}`);
}

// ---- каталоги -------------------------------------------------------------
for (const d of ['intents', 'repos']) {
  const p = path.join(workspaceRoot, d);
  if (!fs.existsSync(p)) {
    if (attempt(`создание каталога ${d}/`, () => fs.mkdirSync(p, { recursive: true })))
      changes.push(`создан каталог ${d}/`);
  }
}

// Каталог кэша клонов версии 1.x только упоминаем: удалять чужие файлы
// миграция не берётся.
if (fs.existsSync(path.join(workspaceRoot, '.cache', 'repos'))) {
  warnings.push('остался каталог .cache/repos/ от версии 1.x — можно удалить вручную');
}

process.stdout.write(
  JSON.stringify(
    { ok: writeErrors.length === 0, applied: apply, workspaceRoot, changes, warnings, writeErrors },
    null,
    2,
  ) + '\n',
);
if (writeErrors.length) process.exit(1);
