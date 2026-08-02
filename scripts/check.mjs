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
import { scopeFilePath, REPO_DIRS, STAGE_NAMES, requiredRepoKeys } from '../core/scripts/lib/config.mjs';

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

// Ненулевой код возврата — штатный ответ скрипта (ok:false), а не сбой прогона:
// отдаём stdout, чтобы проверка отчиталась FAIL-строкой, а набор шёл дальше.
function runScript(rel, args, input, cwd) {
  try {
    return execFileSync('node', [path.join(root, rel), ...args], {
      input: input || '',
      encoding: 'utf8',
      cwd: cwd || undefined,
    });
  } catch (e) {
    return String(e.stdout || '');
  }
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

// 1b) settings-шаблон содержит все ожидаемые ключи (включая fast)
{
  const st = JSON.parse(fs.readFileSync(path.join(root, 'core/templates/settings.example.json'), 'utf8'));
  const need = ['taskPrefix', 'repos', 'repoCache', 'reviewRounds', 'fast', 'language'];
  const miss = need.filter((k) => !(k in st));
  if (!miss.length) ok('settings.example.json: все ключи на месте (' + need.join(', ') + ')');
  else bad('settings.example.json: нет ключей: ' + miss.join(', '));
}

// 1c) Константы ядра: каталоги репозиториев и имена этапов
{
  const wantDirs = {
    systemsAnalysis: 'repos/system-analysis',
    frontend: 'repos/frontend',
    backend: 'repos/backend',
    autoTest: 'repos/autotests',
  };
  const dirsOk = Object.entries(wantDirs).every(([k, v]) => REPO_DIRS[k] === v);
  if (dirsOk) ok('config: REPO_DIRS — дефолтные каталоги repos/*');
  else bad('config: REPO_DIRS не совпадает с ожидаемым: ' + JSON.stringify(REPO_DIRS));

  const wantStages = [
    'setup',
    'intent',
    'create-specification',
    'create-plan',
    'implement-plan',
    'create-autotest-plan',
    'implement-auto-test',
    'task-status',
  ];
  if (wantStages.every((s) => STAGE_NAMES.includes(s)) && STAGE_NAMES.length === wantStages.length)
    ok('config: STAGE_NAMES — новый список этапов');
  else bad('config: STAGE_NAMES: ' + STAGE_NAMES.join(', '));

  // requiredRepoKeys проверяем на КАЖДОМ этапе из STAGE_NAMES: `default: []`
  // молча проглатывает опечатку в имени этапа, и потребители (validate-config)
  // теряют этап без единого сбоя.
  const wantRepos = {
    setup: '',
    intent: 'systemsAnalysis',
    'create-specification': 'systemsAnalysis',
    'create-plan': 'backend',
    'implement-plan': 'backend',
    'create-autotest-plan': 'autoTest',
    'implement-auto-test': 'autoTest',
    'task-status': '',
  };
  const reposDiff = STAGE_NAMES.filter((s) => requiredRepoKeys(s, 'BE').join(',') !== wantRepos[s]);
  if (!reposDiff.length) ok('config: requiredRepoKeys — репозиторий для каждого этапа');
  else
    bad(
      'config: requiredRepoKeys расходится на этапах: ' +
        reposDiff.map((s) => `${s}→[${requiredRepoKeys(s, 'BE').join(',')}]`).join(', '),
    );
  if (requiredRepoKeys('create-plan', 'FE').join(',') === 'frontend') ok('config: requiredRepoKeys — FE-задача берёт frontend');
  else bad('config: requiredRepoKeys(create-plan, FE): ' + requiredRepoKeys('create-plan', 'FE').join(','));
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
  // Two «репозитория» для проверки рабочей области: SA и backend.
  const repoSA = path.join(tmp, 'repo-sa');
  const repoBE = path.join(tmp, 'repo-be');
  fs.mkdirSync(repoSA, { recursive: true });
  fs.mkdirSync(repoBE, { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.env'),
    'SYSTEMS_ANALYSIS_REPO=' + repoSA + '\nFRONTEND_REPO=\nBACKEND_REPO=' + repoBE + '\nAUTOTEST_REPO=\nCONVEYOR_REPO_CACHE=\n',
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

  // ---- рабочая область этапа (scope) ----
  const writeTo = (p) =>
    runScript('core/scripts/guard-writes.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { file_path: p } })).trim();

  // Без scope: запись в оба репозитория разрешена
  if (writeTo(path.join(repoSA, 'doc.md')) === '' && writeTo(path.join(repoBE, 'src.js')) === '')
    ok('scope: без scope запись в оба репо разрешена');
  else bad('scope: без scope запись в репо ошибочно заблокирована');

  // scope: create-specification (фаза A) → писать можно только в SA
  const setOut = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--task', 'TASK-1'], '', tmp),
  );
  if (setOut.ok && setOut.scope.writeRepos.join(',') === 'systemsAnalysis')
    ok('scope: create-specification (фаза A) → writeRepos=[systemsAnalysis]');
  else bad('scope: set вернул неожиданное: ' + JSON.stringify(setOut));

  if (writeTo(path.join(repoSA, 'doc.md')) === '') ok('scope: запись в SA (в области) разрешена');
  else bad('scope: запись в SA ошибочно заблокирована');
  const denyBE = writeTo(path.join(repoBE, 'src.js'));
  if (denyBE && JSON.parse(denyBE).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: запись в backend (вне области) ЗАБЛОКИРОВАНА');
  else bad('scope: запись в backend вне области не заблокирована');
  if (writeTo(path.join(tmp, 'tasks/FE/TASK-1/feature.md')) === '') ok('scope: артефакты задачи всегда разрешены');
  else bad('scope: артефакты задачи заблокированы при активном scope');
  if (writeTo(path.join(tmp, 'tasks/FE/TASK-1/meta.json')) === '') ok('scope: meta.json в папке задачи разрешён');
  else bad('scope: meta.json в папке задачи заблокирован');
  // исходник в папке задачи — deny (код пишется в рабочую копию кодовой базы)
  const denyTsx = writeTo(path.join(tmp, 'tasks/FE/TASK-1/GreetingModal.tsx'));
  if (denyTsx && JSON.parse(denyTsx).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: исходник (.tsx) в папке задачи ЗАБЛОКИРОВАН');
  else bad('scope: исходник в папке задачи прошёл');
  const denyNested = writeTo(path.join(tmp, 'tasks/FE/TASK-1/src/util.js'));
  if (denyNested && JSON.parse(denyNested).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: исходник во вложенной папке задачи заблокирован');
  else bad('scope: вложенный исходник в папке задачи прошёл');
  if (!fs.existsSync(path.join(tmp, '.cache'))) ok('scope: .cache в workspace НЕ создаётся (файл области в temp)');
  else bad('scope: .cache появился в workspace при локальных ссылках');
  // пробный файл в корне workspace при активном этапе — deny
  const probeDeny = writeTo(path.join(tmp, 'test-write.txt'));
  if (probeDeny && JSON.parse(probeDeny).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: пробный файл в корне workspace заблокирован');
  else bad('scope: test-write.txt в корне workspace прошёл');

  // scope: implement-plan BE → наоборот
  runScript('core/scripts/scope.mjs', ['set', '--stage', 'implement-plan', '--type', 'BE'], '', tmp);
  const denySA = writeTo(path.join(repoSA, 'doc.md'));
  if (denySA && JSON.parse(denySA).hookSpecificOutput.permissionDecision === 'deny' && writeTo(path.join(repoBE, 'src.js')) === '')
    ok('scope: implement-plan(BE) — backend разрешён, SA заблокирован');
  else bad('scope: implement-plan(BE) скоупинг не сработал');

  // read-only этап: create-plan → никакие репо не пишутся
  runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-plan', '--type', 'BE'], '', tmp);
  const denyBoth = writeTo(path.join(repoBE, 'src.js'));
  if (denyBoth && JSON.parse(denyBoth).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: create-plan — запись в репо запрещена (только артефакты)');
  else bad('scope: create-plan не заблокировал запись в репо');

  // --write none: фаза B спецификации снимает право записи в анализ
  const noneOut = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--write', 'none'], '', tmp),
  );
  if (noneOut.ok && noneOut.scope.writeRepos.length === 0) ok('scope: --write none → writeRepos=[]');
  else bad('scope: --write none не сработал: ' + JSON.stringify(noneOut));
  const denySAphaseB = writeTo(path.join(repoSA, 'doc.adoc'));
  if (denySAphaseB && JSON.parse(denySAphaseB).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: в фазе B запись в анализ заблокирована');
  else bad('scope: фаза B не заблокировала запись в анализ');
  // --write без значения — ошибка, а не «права по умолчанию»: потерянное
  // значение не должно тихо вернуть фазе B право писать в анализ.
  const bareWrite = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--write'], '', tmp),
  );
  const denySAstill = writeTo(path.join(repoSA, 'doc2.adoc'));
  if (
    bareWrite.ok === false &&
    denySAstill &&
    JSON.parse(denySAstill).hookSpecificOutput.permissionDecision === 'deny'
  )
    ok('scope: --write без значения — ошибка, область не перезаписана');
  else bad('scope: --write без значения не отклонён: ' + JSON.stringify(bareWrite));
  // То же правило для остальных флагов со значением. `--type --task TASK-9`
  // (незакавыченная пустая подстановка) не должно дать тип null и область
  // по умолчанию: BE-задача получила бы запись во frontend вместо backend.
  const bareType = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'implement-plan', '--type', '--task', 'TASK-9'], '', tmp),
  );
  const scopeAfterBareType = JSON.parse(runScript('core/scripts/scope.mjs', ['show'], '', tmp));
  if (bareType.ok === false && scopeAfterBareType.scope.stage === 'create-specification')
    ok('scope: --type без значения — ошибка, область не перезаписана');
  else bad('scope: --type без значения не отклонён: ' + JSON.stringify(bareType));
  // --task без значения раньше писал в область taskId:true
  const bareTask = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--task'], '', tmp),
  );
  if (bareTask.ok === false) ok('scope: --task без значения — ошибка, а не taskId:true');
  else bad('scope: --task без значения принят: ' + JSON.stringify(bareTask));
  // пустой список — такое же потерянное значение, а не синоним none
  const emptyWrite = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--write', ''], '', tmp),
  );
  const commaWrite = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'BE', '--write', ','], '', tmp),
  );
  if (emptyWrite.ok === false && commaWrite.ok === false)
    ok('scope: пустой --write — ошибка, а не необъявленный синоним none');
  else bad('scope: пустой --write принят как none: ' + JSON.stringify([emptyWrite, commaWrite]));
  // план автотестов читает автотесты, но не пишет никуда
  const apOut = JSON.parse(
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-autotest-plan', '--type', 'FE'], '', tmp),
  );
  if (apOut.ok && apOut.scope.writeRepos.length === 0) ok('scope: create-autotest-plan → writeRepos=[]');
  else bad('scope: create-autotest-plan: ' + JSON.stringify(apOut));

  // clear → снова всё разрешено
  runScript('core/scripts/scope.mjs', ['clear'], '', tmp);
  if (writeTo(path.join(repoBE, 'src.js')) === '') ok('scope: clear снимает ограничения');
  else bad('scope: clear не снял ограничения');
  if (writeTo(path.join(tmp, 'tasks/FE/TASK-1/manual.tsx')) === '')
    ok('scope: без scope whitelist папки задачи не применяется');
  else bad('scope: whitelist папки задачи ошибочно активен без scope');
  if (!fs.existsSync(scopeFilePath(tmp))) ok('scope: clear удаляет файл области из temp');
  else bad('scope: clear не удалил файл области');

  // ---- защита от обходов (findings верификации) ----
  const runBash = (cmd) =>
    runScript('core/scripts/guard-bash.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { command: cmd } })).trim();
  const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow');

  runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'FE'], '', tmp);

  // cd-трекинг: относительный редирект после cd в чужой репозиторий
  if (decisionOf(runBash('cd repo-be && echo hack > src.js')) === 'deny') ok('guard-bash: cd-трекинг ловит редирект в чужой репо');
  else bad('guard-bash: cd + редирект в чужой репо не заблокирован');

  // tee в чужой репозиторий
  if (decisionOf(runBash(`tee ${repoBE.replace(/\\/g, '/')}/x.txt`)) === 'deny') ok('guard-bash: tee вне области заблокирован');
  else bad('guard-bash: tee вне области прошёл');

  // подстановка в цели — ask
  if (decisionOf(runBash('echo x > $HOME/evil.txt')) === 'ask') ok('guard-bash: цель с подстановкой → ask');
  else bad('guard-bash: цель с подстановкой не ask');

  // cmd-идиома Windows: `> nul` создаёт файл — deny
  if (decisionOf(runBash('dir /b .env > nul')) === 'deny') ok('guard-bash: редирект в nul (cmd-идиома) заблокирован');
  else bad('guard-bash: > nul прошёл — создастся файл nul');

  // git-мутация в чужом репозитории — ask
  if (decisionOf(runBash(`git -C ${repoBE.replace(/\\/g, '/')} checkout main`)) === 'ask') ok('guard-bash: git checkout вне области → ask');
  else bad('guard-bash: git-мутация вне области не ask');

  // rm в чужом репозитории — deny
  if (decisionOf(runBash(`rm -rf ${repoBE.replace(/\\/g, '/')}/src`)) === 'deny') ok('guard-bash: rm вне области заблокирован');
  else bad('guard-bash: rm вне области прошёл');

  // прямое редактирование scope-файла — deny
  const scopeDeny = writeTo(scopeFilePath(tmp));
  if (scopeDeny && JSON.parse(scopeDeny).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: прямое редактирование файла области запрещено');
  else bad('scope: файл области можно перезаписать напрямую');

  // повреждённый scope → fail-closed для репозиториев
  fs.writeFileSync(scopeFilePath(tmp), '{broken');
  const corruptDeny = writeTo(path.join(repoBE, 'src.js'));
  if (corruptDeny && JSON.parse(corruptDeny).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: повреждённый файл области — fail-closed для репо');
  else bad('scope: повреждённый файл области открыл запись');

  // устаревший scope (старше TTL) игнорируется
  fs.writeFileSync(
    scopeFilePath(tmp),
    JSON.stringify({ stage: 'create-plan', writeRepos: [], setAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString() }),
  );
  if (writeTo(path.join(repoBE, 'src.js')) === '') ok('scope: устаревшая область (TTL) игнорируется');
  else bad('scope: устаревшая область всё ещё блокирует');
  runScript('core/scripts/scope.mjs', ['clear'], '', tmp);

  // scope.mjs валидация аргументов
  const badStage = runScript('core/scripts/scope.mjs', ['set', '--stage', 'implment'], '', tmp);
  if (badStage.includes('неизвестный этап')) ok('scope: неизвестный этап отклоняется');
  else bad('scope: опечатка в этапе не отлавливается');

  // Отказ от неизвестного флага должен быть заметен и вызывающему скрипту, и
  // модели: ненулевой код возврата И названный флаг в тексте. runScript код
  // глотает, поэтому здесь берём его отдельно.
  const runScope = (argv) => {
    try {
      const stdout = execFileSync('node', [path.join(root, 'core/scripts/scope.mjs'), ...argv], {
        encoding: 'utf8',
        cwd: tmp,
      });
      return { code: 0, out: JSON.parse(stdout) };
    } catch (e) {
      return { code: e.status, out: JSON.parse(String(e.stdout || '{}')) };
    }
  };

  // Опечатка в имени флага СО значением раньше проходила молча: `--tpye BE`
  // терял тип и выдавал BE-задаче запись во frontend вместо backend.
  const typoFlag = runScope(['set', '--stage', 'implement-plan', '--tpye', 'BE', '--task', 'TASK-1']);
  if (typoFlag.code !== 0 && typoFlag.out.ok === false && typoFlag.out.error.includes('--tpye'))
    ok('scope: опечатка в имени флага (--tpye) отклоняется с названием флага');
  else bad('scope: опечатка в имени флага принята: ' + JSON.stringify(typoFlag));

  // Выдуманный флаг тоже игнорировался молча: фаза B спецификации сохраняла
  // запись в анализ, хотя вызывающий думал, что её снял.
  const inventedFlag = runScope(['set', '--stage', 'create-specification', '--type', 'BE', '--no-write', 'true']);
  if (inventedFlag.code !== 0 && inventedFlag.out.ok === false && inventedFlag.out.error.includes('--no-write'))
    ok('scope: выдуманный флаг (--no-write) отклоняется');
  else bad('scope: выдуманный флаг принят: ' + JSON.stringify(inventedFlag));

  // clear флагов не принимает вовсе — и говорит про неизвестный флаг, а не
  // про потерянное значение (иначе вызывающий начнёт подбирать значение).
  const clearFlag = runScope(['clear', '--force']);
  if (
    clearFlag.code !== 0 &&
    clearFlag.out.ok === false &&
    clearFlag.out.error.includes('--force') &&
    !clearFlag.out.error.includes('требует значение')
  )
    ok('scope: clear --force — неизвестный флаг, а не «требует значение»');
  else bad('scope: clear --force принят или ошибка не про флаг: ' + JSON.stringify(clearFlag));

  // Пропуск --type даёт тот же отказ, что и опечатка в его имени: на
  // implement-plan область считается по типу, и BE-задача без --type получила
  // бы запись во frontend вместо backend. У set тип обязателен.
  const noType = runScope(['set', '--stage', 'implement-plan', '--task', 'TASK-1']);
  const scopeAfterNoType = JSON.parse(runScript('core/scripts/scope.mjs', ['show'], '', tmp));
  if (noType.code !== 0 && noType.out.ok === false && noType.out.error.includes('--type') && scopeAfterNoType.state === 'none')
    ok('scope: set без --type отклоняется, область не установлена');
  else bad('scope: set без --type принят: ' + JSON.stringify(noType));

  // Легальные вызовы строгостью не задеты
  const legalSet = runScope(['set', '--stage', 'implement-plan', '--type', 'BE', '--task', 'TASK-3']);
  const legalNone = runScope(['set', '--stage', 'create-specification', '--type', 'BE', '--write', 'none']);
  const legalShow = runScope(['show']);
  const legalClear = runScope(['clear']);
  if (
    legalSet.code === 0 &&
    legalSet.out.scope.writeRepos.join(',') === 'backend' &&
    legalSet.out.scope.taskId === 'TASK-3' &&
    legalNone.code === 0 &&
    legalNone.out.scope.writeRepos.length === 0 &&
    legalShow.code === 0 &&
    legalShow.out.scope.stage === 'create-specification' &&
    legalClear.code === 0 &&
    legalClear.out.cleared === true
  )
    ok('scope: легальные set/--write none/show/clear работают по-прежнему');
  else
    bad('scope: легальный вызов сломан: ' + JSON.stringify([legalSet, legalNone, legalShow, legalClear]));

  // фолбэк workspace через CLAUDE_PROJECT_DIR (cd наружу не отключает guard)
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-outside-'));
  try {
    runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'FE'], '', tmp);
    const denyOut = execFileSync(
      'node',
      [path.join(root, 'core/scripts/guard-writes.mjs')],
      {
        input: JSON.stringify({ cwd: outsideDir, tool_input: { file_path: path.join(repoBE, 'x.js') } }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: tmp },
      },
    ).trim();
    if (denyOut && JSON.parse(denyOut).hookSpecificOutput.permissionDecision === 'deny')
      ok('guard-writes: CLAUDE_PROJECT_DIR-фолбэк — cd наружу не отключает защиту');
    else bad('guard-writes: фолбэк workspace не сработал (cd наружу отключает защиту)');
    runScript('core/scripts/scope.mjs', ['clear'], '', tmp);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  // ---- быстрый режим (CONVEYOR_FAST) ----
  const rcFast = JSON.parse(
    execFileSync('node', [path.join(root, 'core/scripts/resolve-config.mjs'), tmp], {
      encoding: 'utf8',
      env: { ...process.env, CONVEYOR_FAST: 'true' },
    }),
  );
  if (rcFast.fastMode === true && rcFast.config.reviewRounds === 0)
    ok('fast: CONVEYOR_FAST=true → fastMode + reviewRounds=0');
  else bad('fast: флаг не включает быстрый режим: ' + JSON.stringify({ f: rcFast.fastMode, r: rcFast.config.reviewRounds }));
  const rcSlow = JSON.parse(runScript('core/scripts/resolve-config.mjs', [tmp]));
  if (rcSlow.fastMode === false && rcSlow.config.reviewRounds === 2)
    ok('fast: по умолчанию выключен (reviewRounds=2)');
  else bad('fast: дефолт не false');
  if (!rcSlow.missingVars.includes('CONVEYOR_FAST')) ok('fast: пустой CONVEYOR_FAST не в missing');
  else bad('fast: CONVEYOR_FAST ошибочно в missing');

  // validate-artifact: неполный артефакт (нет разделов) → ok:false
  const artPath = path.join(tmp, 'plan-test.md');
  fs.writeFileSync(artPath, '# План\n## Краткое резюме подхода\nчто-то\n');
  const vaObj = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', artPath, '--type', 'plan']));
  if (vaObj.ok === false && vaObj.missingSections.length) ok('validate-artifact: неполный план не проходит');
  else bad('validate-artifact: неполный план прошёл валидацию');
  // полный по разделам (шаблон содержит пример чекбокса и REQ-ID) → ok:true
  fs.copyFileSync(path.join(root, 'core/templates/plan.md'), artPath);
  const va2 = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', artPath, '--type', 'plan']));
  if (va2.ok === true && va2.placeholders.length) ok('validate-artifact: все разделы на месте + плейсхолдеры как предупреждение');
  else bad('validate-artifact: полный по разделам план не прошёл: ' + JSON.stringify(va2));

  // validate-task-folder: исходник в папке задачи → ok:false + имя файла
  const vtDir = path.join(tmp, 'tasks/FE/TASK-7');
  fs.mkdirSync(path.join(vtDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(vtDir, 'feature.md'), '# f\n');
  fs.writeFileSync(path.join(vtDir, 'meta.json'), '{}');
  fs.writeFileSync(path.join(vtDir, 'GreetingModal.tsx'), 'export {}\n');
  fs.writeFileSync(path.join(vtDir, 'src/util.js'), 'export {}\n');
  const vtObj = JSON.parse(runScript('core/scripts/validate-task-folder.mjs', ['--task', vtDir]));
  if (
    vtObj.ok === false &&
    vtObj.unexpectedFiles.includes('GreetingModal.tsx') &&
    vtObj.unexpectedFiles.includes('src/util.js')
  )
    ok('validate-task-folder: исходники в папке задачи найдены');
  else bad('validate-task-folder: исходники не найдены: ' + JSON.stringify(vtObj));
  fs.unlinkSync(path.join(vtDir, 'GreetingModal.tsx'));
  fs.rmSync(path.join(vtDir, 'src'), { recursive: true, force: true });
  const vt2 = JSON.parse(runScript('core/scripts/validate-task-folder.mjs', ['--task', vtDir]));
  if (vt2.ok === true && vt2.checkedFiles === 2) ok('validate-task-folder: чистая папка задачи проходит');
  else bad('validate-task-folder: чистая папка не прошла: ' + JSON.stringify(vt2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`Проверка не пройдена: ${failures} ошибок.`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
