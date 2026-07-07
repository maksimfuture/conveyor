#!/usr/bin/env node
// validate-task-folder.mjs — пост-проверка папки задачи (шаг «Завершение
// этапа»): в tasks/<FE|BE>/<TASK-ID>/ живут ТОЛЬКО артефакты конвейера
// (*.md, meta.json). Исходники (tsx/js/less/…) — признак того, что агент
// перепутал папку задачи с рабочей копией кодовой базы.
//
// Использование:
//   node validate-task-folder.mjs --task <абсолютный путь к папке задачи>
// Вывод (stdout, JSON):
//   { ok: true,  taskDir, checkedFiles: N }
//   { ok: false, taskDir, unexpectedFiles: ["GreetingModal.tsx", ...] }
// Код выхода: 0 при ok, 1 при нарушениях (как validate-artifact.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { isTaskArtifactFile } from './lib/config.mjs';

function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const ti = args.indexOf('--task');
const taskDir = ti !== -1 ? args[ti + 1] : null;
if (!taskDir) fail('нужен аргумент --task <путь к папке задачи>');
const root = path.resolve(taskDir);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
  fail(`папка задачи не найдена: ${root}`);

const unexpected = [];
let checked = 0;
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs);
      continue;
    }
    checked++;
    const rel = path.relative(root, abs);
    if (!isTaskArtifactFile(rel)) unexpected.push(rel.replace(/\\/g, '/'));
  }
})(root);

if (unexpected.length) {
  process.stdout.write(
    JSON.stringify({ ok: false, taskDir: root, unexpectedFiles: unexpected }, null, 2) + '\n',
  );
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ ok: true, taskDir: root, checkedFiles: checked }) + '\n',
);
