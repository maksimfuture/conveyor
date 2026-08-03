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
//
// Вывод (stdout, JSON): { ok, applied, workspaceRoot, changes: [...], warnings: [...] }

import fs from 'node:fs';
import path from 'node:path';
import { findWorkspaceRoot, parseEnvFile, REPO_KEYS, REPO_DIRS } from './lib/config.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const startDir = argv.find((a) => !a.startsWith('--')) || process.cwd();

const workspaceRoot = findWorkspaceRoot(startDir);
if (!workspaceRoot) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'не найден settings.json' }) + '\n');
  process.exit(1);
}

const changes = [];
const warnings = [];
// Сухой прогон — режим по умолчанию: скрипт трогает чужой рабочий репозиторий
// с реальными задачами, поэтому запись включает только явный --apply.
const write = (file, text) => {
  if (apply) fs.writeFileSync(file, text);
};

// ---- 1. settings.json -----------------------------------------------------
const settingsPath = path.join(workspaceRoot, 'settings.json');
let settings;
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: `settings.json: ${e.message}` }) + '\n');
  process.exit(1);
}

const env = parseEnvFile(path.join(workspaceRoot, '.env'));
const varOf = (v) => (typeof v === 'string' ? (v.match(/^\$\{([A-Za-z0-9_]+)\}$/) || [])[1] : undefined);

let settingsChanged = false;
settings.repos = settings.repos || {};
for (const key of REPO_KEYS) {
  const repo = settings.repos[key] || (settings.repos[key] = {});
  const linkVar = varOf(repo.link);
  const oldValue = linkVar ? (env[linkVar] || '') : (repo.link || '');
  if (repo.link !== REPO_DIRS[key]) {
    repo.link = REPO_DIRS[key];
    settingsChanged = true;
    changes.push(`settings.repos.${key}.link -> ${REPO_DIRS[key]}`);
    if (oldValue) warnings.push(`${key}: раньше ссылка вела на «${oldValue}» — склонируйте репозиторий в ${REPO_DIRS[key]}`);
  }
  const branchVar = varOf(repo.mainBranch);
  const branch = (branchVar ? env[branchVar] : repo.mainBranch) || 'main';
  if (repo.mainBranch !== branch) {
    repo.mainBranch = branch;
    settingsChanged = true;
    changes.push(`settings.repos.${key}.mainBranch -> ${branch}`);
  }
}
if ('repoCache' in settings) {
  delete settings.repoCache;
  settingsChanged = true;
  changes.push('settings.repoCache удалён');
}
if (settingsChanged) write(settingsPath, JSON.stringify(settings, null, 2) + '\n');

// ---- 2-3. задачи ----------------------------------------------------------
const tasksDir = path.join(workspaceRoot, 'tasks');
for (const type of ['FE', 'BE']) {
  const dir = path.join(tasksDir, type);
  if (!fs.existsSync(dir)) continue;
  for (const taskId of fs.readdirSync(dir)) {
    const taskDir = path.join(dir, taskId);
    const metaPath = path.join(taskDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {
        // Одна битая задача не должна оставить остальные не мигрированными.
        warnings.push(`${taskId}: meta.json не разбирается — пропущен`);
        meta = null;
      }
      if (meta && meta.schemaVersion !== 2) {
        meta.stages = meta.stages || {};
        meta.stages.specification = meta.stages.specification || { done: false };
        // Пройденный этап feature = правки анализа уже внесены: новая
        // двухфазная спецификация начнёт сразу с фазы B.
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
        meta.schemaVersion = 2;
        write(metaPath, JSON.stringify(meta, null, 2) + '\n');
        changes.push(`${type}/${taskId}/meta.json -> schemaVersion 2`);
      }
    }
    // Переименование, а не чтение-запись-удаление: артефакт задачи не должен
    // потеряться, если запись оборвётся.
    const oldArtifact = path.join(taskDir, 'requirements-auto-test.md');
    const newArtifact = path.join(taskDir, 'autotest-plan.md');
    if (fs.existsSync(oldArtifact) && !fs.existsSync(newArtifact)) {
      if (apply) fs.renameSync(oldArtifact, newArtifact);
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
  write(giPath, (gi.endsWith('\n') || gi === '' ? gi : gi + '\n') + add.join('\n') + '\n');
  changes.push(`.gitignore += ${add.join(', ')}`);
}

// ---- каталоги -------------------------------------------------------------
for (const d of ['intents', 'repos']) {
  const p = path.join(workspaceRoot, d);
  if (!fs.existsSync(p)) {
    if (apply) fs.mkdirSync(p, { recursive: true });
    changes.push(`создан каталог ${d}/`);
  }
}

// Каталог кэша клонов версии 1.x только упоминаем: удалять чужие файлы
// миграция не берётся.
if (fs.existsSync(path.join(workspaceRoot, '.cache', 'repos'))) {
  warnings.push('остался каталог .cache/repos/ от версии 1.x — можно удалить вручную');
}

process.stdout.write(
  JSON.stringify({ ok: true, applied: apply, workspaceRoot, changes, warnings }, null, 2) + '\n',
);
