#!/usr/bin/env node
// build.mjs — assembles the installable distributions from the monorepo.
// Each distribution gets a nested copy of core/ so that the platform's
// plugin/extension root resolves core/ after install (spec 3).
//
//   dist/claude-code/   = adapters/claude-code/* + core/   (Claude Code plugin)
//   dist/gigacode/      = adapters/gigacode/*    + core/   (GigaCode extension)
//
// The adapters/ split keeps platform-specific bits isolated; core/ is shared.
//
// Usage: node scripts/build.mjs [--out <каталог>]
//
// `--out` собирает в указанный каталог вместо dist/. Нужен scripts/check.mjs:
// он сверяет СОСТАВ дистрибутива и обязан собирать свежий во временном
// каталоге — иначе проверка смотрела бы на dist/ от прошлого прогона (каталог
// в .gitignore) и зависела от того, кто и когда запускал сборку.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFlag = process.argv.indexOf('--out');
if (outFlag !== -1 && !process.argv[outFlag + 1]) {
  console.error('build: --out требует путь к каталогу.');
  process.exit(1);
}
// Каталог сборки затирается целиком (rmrf ниже), поэтому путь резолвим сразу и
// от текущего каталога вызова — так видно, что именно будет затёрто.
const dist = outFlag !== -1 ? path.resolve(process.argv[outFlag + 1]) : path.join(root, 'dist');
const core = path.join(root, 'core');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// Portable recursive copy (fs.cpSync needs Node >= 16.7; runtime targets 14+).
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildTarget(name, adapterDir) {
  const out = path.join(dist, name);
  rmrf(out);
  fs.mkdirSync(out, { recursive: true });
  // adapter files at the distribution root
  copyDir(adapterDir, out);
  // nested core/
  copyDir(core, path.join(out, 'core'));
  return out;
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

// --- basic integrity checks before building --------------------------------
const required = [
  'core/scripts/resolve-config.mjs',
  'core/scripts/validate-config.mjs',
  'core/scripts/guard-writes.mjs',
  'core/scripts/guard-bash.mjs',
  'core/scripts/git-ops.mjs',
  'core/scripts/lib/config.mjs',
  'adapters/claude-code/.claude-plugin/plugin.json',
  'adapters/claude-code/hooks/hooks.json',
];
const missing = required.filter((r) => !fs.existsSync(path.join(root, r)));
if (missing.length) {
  console.error('build: отсутствуют обязательные файлы:\n  ' + missing.join('\n  '));
  process.exit(1);
}

rmrf(dist);

// Build each adapter that is present; skip (with a note) any that was removed.
const targets = [
  { name: 'claude-code', dir: path.join(root, 'adapters', 'claude-code') },
  { name: 'gigacode', dir: path.join(root, 'adapters', 'gigacode') },
];

console.log('conveyor build:');
let built = 0;
for (const t of targets) {
  if (!fs.existsSync(t.dir)) {
    console.log(`  ~ пропущен ${t.name}: нет adapters/${t.name}`);
    continue;
  }
  const out = buildTarget(t.name, t.dir);
  // Каталог вне репозитория (--out) печатаем абсолютным: `..\..\..\Temp\x`
  // человеку ничего не говорит.
  const shown = path.relative(root, out);
  console.log(`  + ${shown.startsWith('..') ? out : shown}  (${countFiles(out)} файлов)`);
  built++;
}
if (!built) {
  console.error('build: не найдено ни одного адаптера в adapters/.');
  process.exit(1);
}
console.log('\nУстановка Claude Code: скопируйте dist/claude-code как плагин');
console.log('(.claude-plugin/plugin.json, skills/, agents/, hooks/, core/).');
console.log('Установка GigaCode: gigacode extensions install dist/gigacode');
console.log('(манифест gigacode-extension.json; ручной cp не регистрирует расширение).');
