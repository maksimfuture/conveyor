#!/usr/bin/env node
// check.mjs — self-test for the conveyor plugin. Validates JSON manifests,
// that every skill/agent/stage/prompt exists, and runs the config + guard
// scripts against a throwaway workspace to prove they behave per spec.
//
// Usage: node scripts/check.mjs   (exit 0 = all green)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const bad = (m) => {
  console.error(`  FAIL ${m}`);
  failures++;
};

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

function runScript(rel, args, input) {
  return execFileSync('node', [path.join(root, rel), ...args], {
    input: input || '',
    encoding: 'utf8',
  });
}

// 1) JSON manifests parse
console.log('JSON манифесты:');
for (const rel of [
  'adapters/claude-code/.claude-plugin/plugin.json',
  'adapters/claude-code/hooks/hooks.json',
  'adapters/gigacode/gigacode-extension.json',
  'core/templates/settings.example.json',
  'package.json',
]) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    ok(rel);
  } catch (e) {
    bad(`${rel}: ${e.message}`);
  }
}

// 2) Every skill has a matching stage; every agent has a matching prompt
console.log('Соответствие скиллов/агентов ядру:');
const skills = fs.readdirSync(path.join(root, 'adapters/claude-code/skills'));
for (const s of skills) {
  if (!exists(`adapters/claude-code/skills/${s}/SKILL.md`)) bad(`skill ${s}: нет SKILL.md`);
  else if (!exists(`core/stages/${s}.md`)) bad(`skill ${s}: нет core/stages/${s}.md`);
  else ok(`skill ${s} → core/stages/${s}.md`);
}
for (const a of ['system-analyst', 'frontend-developer', 'backend-developer', 'qa-autotest-engineer', 'reviewer']) {
  if (!exists(`adapters/claude-code/agents/${a}.md`)) bad(`agent ${a}: нет файла`);
  else if (!exists(`core/prompts/${a}.md`)) bad(`agent ${a}: нет core/prompts/${a}.md`);
  else ok(`agent ${a} → core/prompts/${a}.md`);
}

// 2a) GigaCode adapter: every skill has a matching /conveyor command
console.log('GigaCode-адаптер:');
if (!exists('adapters/gigacode/QWEN.md')) bad('нет adapters/gigacode/QWEN.md');
else ok('adapters/gigacode/QWEN.md');
for (const s of skills) {
  const rel = `adapters/gigacode/commands/conveyor/${s}.md`;
  if (!exists(rel)) bad(`gigacode: нет команды ${s}`);
  else {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8');
    if (txt.startsWith('---') && /description:/.test(txt) && txt.includes(`core/stages/${s}.md`))
      ok(`gigacode команда ${s} → core/stages/${s}.md`);
    else bad(`gigacode команда ${s}: нет frontmatter description или ссылки на стейдж`);
  }
}

// 2b) Review loop wired into the three producing stages
console.log('Цикл ревью:');
if (!exists('core/stages/_review-loop.md')) bad('нет core/stages/_review-loop.md');
else ok('core/stages/_review-loop.md');
for (const st of ['create-feature', 'implement-plan', 'implement-auto-test']) {
  const txt = fs.readFileSync(path.join(root, `core/stages/${st}.md`), 'utf8');
  if (txt.includes('_review-loop.md')) ok(`stage ${st} ссылается на цикл ревью`);
  else bad(`stage ${st}: нет ссылки на _review-loop.md`);
}

// 3) Scripts run against a temp workspace
console.log('Поведение скриптов (временный workspace):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-check-'));
try {
  fs.writeFileSync(
    path.join(tmp, 'settings.json'),
    fs.readFileSync(path.join(root, 'core/templates/settings.example.json')),
  );
  fs.writeFileSync(
    path.join(tmp, '.env'),
    'SYSTEMS_ANALYSIS_REPO=' + tmp + '\nFRONTEND_REPO=\nBACKEND_REPO=\nAUTOTEST_REPO=\nCONVEYOR_REPO_CACHE=\n',
  );

  // resolve-config: found true, FRONTEND_REPO missing, CONVEYOR_REPO_CACHE not missing
  const rc = JSON.parse(runScript('core/scripts/resolve-config.mjs', [tmp]));
  if (rc.found && rc.missingVars.includes('FRONTEND_REPO')) ok('resolve-config: found + missingVars');
  else bad('resolve-config: неожиданный результат: ' + JSON.stringify(rc.missingVars));
  if (!rc.missingVars.includes('CONVEYOR_REPO_CACHE')) ok('resolve-config: пустой repoCache не в missing');
  else bad('resolve-config: repoCache ошибочно в missing');
  if (!rc.missingVars.includes('CONVEYOR_REVIEW_ROUNDS')) ok('resolve-config: пустой reviewRounds не в missing');
  else bad('resolve-config: CONVEYOR_REVIEW_ROUNDS ошибочно в missing');
  if (rc.config && rc.config.reviewRounds === 2) ok('resolve-config: reviewRounds по умолчанию = 2');
  else bad('resolve-config: reviewRounds не 2 по умолчанию: ' + (rc.config && rc.config.reviewRounds));
  if (!rc.missingVars.includes('SYSTEMS_ANALYSIS_MAIN_BRANCH')) ok('resolve-config: пустой mainBranch не в missing');
  else bad('resolve-config: *_MAIN_BRANCH ошибочно в missing');
  if (rc.links && rc.links.systemsAnalysis && rc.links.systemsAnalysis.mainBranch === 'main') ok('resolve-config: mainBranch по умолчанию = main');
  else bad('resolve-config: mainBranch не main по умолчанию: ' + (rc.links && rc.links.systemsAnalysis && rc.links.systemsAnalysis.mainBranch));

  // guard-writes: deny outside allowed roots
  const outside = process.platform === 'win32' ? 'C:/Windows/x.txt' : '/etc/x.txt';
  const gwOut = JSON.parse(
    runScript('core/scripts/guard-writes.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { file_path: outside } })),
  );
  if (gwOut.hookSpecificOutput.permissionDecision === 'deny') ok('guard-writes: deny вне корней');
  else bad('guard-writes: не заблокировал запись вне корней');

  // guard-writes: allow inside workspace (empty output = allow)
  const gwIn = runScript('core/scripts/guard-writes.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { file_path: path.join(tmp, 'tasks/FE/x.md') } })).trim();
  if (gwIn === '') ok('guard-writes: allow внутри workspace');
  else bad('guard-writes: неожиданный вывод для разрешённого пути: ' + gwIn);

  // guard-bash: deny push --force
  const gb = JSON.parse(
    runScript('core/scripts/guard-bash.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { command: 'git push --force origin main' } })),
  );
  if (gb.hookSpecificOutput.permissionDecision === 'deny') ok('guard-bash: deny push --force');
  else bad('guard-bash: не заблокировал push --force');

  // guard-bash: deny push to main branch
  const gb2 = JSON.parse(
    runScript('core/scripts/guard-bash.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { command: 'git push origin main' } })),
  );
  if (gb2.hookSpecificOutput.permissionDecision === 'deny') ok('guard-bash: deny push в main');
  else bad('guard-bash: не заблокировал push в main');

  // guard-bash: ask on plain reset --hard
  const gb3 = JSON.parse(
    runScript('core/scripts/guard-bash.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { command: 'git reset --hard' } })),
  );
  if (gb3.hookSpecificOutput.permissionDecision === 'ask') ok('guard-bash: ask на reset --hard');
  else bad('guard-bash: reset --hard не перевёл в ask');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`Проверка не пройдена: ${failures} ошибок.`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
