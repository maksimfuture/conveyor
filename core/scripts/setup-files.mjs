#!/usr/bin/env node
// setup-files.mjs — файловые шаги /setup без `node -e`.
// Раньше этап копировал шаблоны и сверял ключи встроенным кодом (node -e), но
// корпоративная политика GigaCode запрещает inline-интерпретацию — этап
// вставал на первом же шаге. Скрипт делает то же самое и сам знает, где лежат
// шаблоны (по своему расположению), поэтому корень плагина ему не передаётся.
//
// Usage (из корня рабочего репозитория):
//   node setup-files.mjs init        — settings.example.json → settings.json,
//                                      env.example → .env.example
//   node setup-files.mjs check-keys  — ключи settings.json против шаблона
// Output (stdout, JSON):
//   init:       { ok, created: [...], skipped: [...] }
//   check-keys: { ok, missing: [...] }   (код 1, если missing не пуст)
//
// Готовые файлы init НЕ перезаписывает: settings.json — это ссылки и
// taskPrefix всей команды, .env.example закоммичен вместе с ним.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from './lib/config.mjs';

const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const cwd = process.cwd();

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

// Через readJsonFile: settings.json, сохранённый Windows-редактором с BOM,
// остальной плагин читает, и check-keys не должен объявлять его битым.
// Разбор и форма — разные причины: `null` или массив разбираются, но
// настройками не являются, и «не разбирается как JSON» увело бы чинить не то.
function readKeys(file, label) {
  let data;
  try {
    data = readJsonFile(file);
  } catch (e) {
    out({ ok: false, error: `${label} не разбирается как JSON: ${e.message}` }, 1);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    out({ ok: false, error: `${label} — не объект настроек (в файле ${data === null ? 'null' : Array.isArray(data) ? 'массив' : typeof data})` }, 1);
  return Object.keys(data);
}

const cmd = process.argv[2];

if (cmd === 'init') {
  const created = [];
  const skipped = [];
  // Ошибка копирования (нет прав, занят файл) отдаётся тем же JSON, а не
  // стектрейсом: этап читает ответ скрипта. Уже созданное остаётся и
  // называется — повторный init его пропустит и докопирует остальное.
  try {
    for (const [tpl, name] of [
      ['settings.example.json', 'settings.json'],
      ['env.example', '.env.example'],
    ]) {
      const dest = path.join(cwd, name);
      if (fs.existsSync(dest)) skipped.push(name);
      else {
        fs.copyFileSync(path.join(templates, tpl), dest);
        created.push(name);
      }
    }
  } catch (e) {
    out({ ok: false, created, skipped, error: `не удалось скопировать шаблон: ${e.message}` }, 1);
  }
  out({ ok: true, created, skipped });
} else if (cmd === 'check-keys') {
  const settings = path.join(cwd, 'settings.json');
  if (!fs.existsSync(settings)) out({ ok: false, error: 'нет settings.json в текущем каталоге' }, 1);
  const have = readKeys(settings, 'settings.json');
  const missing = readKeys(path.join(templates, 'settings.example.json'), 'шаблон settings.example.json').filter(
    (k) => !have.includes(k),
  );
  out({ ok: !missing.length, missing }, missing.length ? 1 : 0);
} else {
  out({ ok: false, error: 'команда: init | check-keys' }, 1);
}
