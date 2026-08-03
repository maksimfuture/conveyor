#!/usr/bin/env node
// check.mjs — self-test for the conveyor plugin. Validates JSON manifests,
// that every skill/agent/stage/prompt exists, and runs the config + guard
// scripts against a throwaway workspace to prove they behave per spec.
//
// Usage: node scripts/check.mjs   (exit 0 = all green)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  scopeFilePath,
  REPO_KEYS,
  REPO_DIRS,
  STAGE_NAMES,
  requiredRepoKeys,
  stageWriteRepoKeys,
} from '../core/scripts/lib/config.mjs';

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

// То же, но с кодом возврата и stderr: ненулевой код — часть контракта скрипта,
// и регрессия «печатает ok:false, но выходит с кодом 0» по одному stdout не
// видна. Как и runScript, не бросает — прогон идёт дальше.
function runScriptFull(rel, args, input, cwd) {
  const r = spawnSync('node', [path.join(root, rel), ...args], {
    input: input || '',
    encoding: 'utf8',
    cwd: cwd || undefined,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

// 0) Каждый скрипт ядра обязан ЗАГРУЖАТЬСЯ. Висячий импорт (экспорт удалили,
// а `import { x }` остался) в ESM — отказ линковки модуля, а не ленивая
// ошибка: скрипт падает до первой строки main, и по stdout это не видно.
// Запускаем каждый без аргументов во временном каталоге (штатный ответ вроде
// «неизвестная подкоманда» нас не интересует) и смотрим stderr.
console.log('Загрузка скриптов ядра:');
{
  const loadTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-load-'));
  try {
    for (const f of fs.readdirSync(path.join(root, 'core/scripts')).filter((n) => n.endsWith('.mjs'))) {
      const r = runScriptFull(`core/scripts/${f}`, [], '', loadTmp);
      const re = /^.*(SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|does not provide an export).*$/m;
      const broken = re.exec(r.stderr);
      if (!broken) ok(`core/scripts/${f} загружается`);
      else bad(`core/scripts/${f}: модуль не загружается — ${broken[0].trim()}`);
    }
  } finally {
    fs.rmSync(loadTmp, { recursive: true, force: true });
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
  // Сверяем целиком, а не по ожидаемым ключам: лишний или переименованный
  // пятый ключ иначе пройдёт молча. Состав и порядок обязаны совпадать с
  // REPO_KEYS — по нему guard-* и resolve-config обходят репозитории.
  if (JSON.stringify(REPO_DIRS) === JSON.stringify(wantDirs) && Object.keys(REPO_DIRS).join(',') === REPO_KEYS.join(','))
    ok('config: REPO_DIRS — каталоги repos/*, состав и порядок как у REPO_KEYS');
  else
    bad(
      'config: REPO_DIRS не совпадает с ожидаемым: ' +
        JSON.stringify(REPO_DIRS) +
        ' при REPO_KEYS: ' +
        REPO_KEYS.join(', '),
    );

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
  // Порядок смысловой — это порядок конвейера, и в таком виде список этапов
  // печатается моделью в ошибке scope.mjs. Поэтому сверка целиком, а не по
  // составу.
  if (STAGE_NAMES.join(',') === wantStages.join(','))
    ok('config: STAGE_NAMES — состав и порядок конвейера');
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

  // stageWriteRepoKeys решает, КУДА МОЖНО ПИСАТЬ, поэтому её `default: []`
  // опаснее: потерянная ветка не открывает лишнего, а молча отбирает у этапа
  // право писать в свой репозиторий — и набор при этом зелёный. Таблица
  // исчерпывающая и по этапам, и по типам задачи (тип решает на implement-plan).
  const wantWrite = {
    setup: { FE: '', BE: '' },
    intent: { FE: '', BE: '' },
    'create-specification': { FE: 'systemsAnalysis', BE: 'systemsAnalysis' },
    'create-plan': { FE: '', BE: '' },
    'implement-plan': { FE: 'frontend', BE: 'backend' },
    'create-autotest-plan': { FE: '', BE: '' },
    'implement-auto-test': { FE: 'autoTest', BE: 'autoTest' },
    'task-status': { FE: '', BE: '' },
  };
  const writeDiff = [];
  for (const s of STAGE_NAMES) {
    for (const t of ['FE', 'BE']) {
      const got = stageWriteRepoKeys(s, t).join(',');
      if (got !== (wantWrite[s] || {})[t]) writeDiff.push(`${s}/${t}→[${got}]`);
    }
  }
  if (!writeDiff.length) ok('config: stageWriteRepoKeys — права записи каждого этапа для FE и BE');
  else bad('config: stageWriteRepoKeys расходится на этапах: ' + writeDiff.join(', '));
}

// 2) Every skill has a matching stage; every agent has a matching prompt
console.log('Соответствие скиллов/агентов ядру:');
const skills = fs.readdirSync(path.join(root, 'adapters/claude-code/skills'));
for (const s of skills) {
  if (!exists(`adapters/claude-code/skills/${s}/SKILL.md`)) bad(`skill ${s}: нет SKILL.md`);
  else if (!exists(`core/stages/${s}.md`)) bad(`skill ${s}: нет core/stages/${s}.md`);
  else ok(`skill ${s} → core/stages/${s}.md`);
}
for (const a of ['business-analyst', 'system-analyst', 'frontend-developer', 'backend-developer', 'qa-autotest-engineer', 'reviewer']) {
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

// 2c) Вызовы git-ops в текстах этапов и скиллов — по фактическому dispatch.
// Стейдж — предписание модели, а не код: удалённая подкоманда (analysis-head)
// или исчезнувший флаг (--kind) здесь ничего не ломают, они всплывают посреди
// этапа ответом «неизвестная подкоманда» — и этап встаёт у пользователя.
console.log('Вызовы git-ops в стейджах и скиллах:');
{
  const gitOpsSrc = fs.readFileSync(path.join(root, 'core/scripts/git-ops.mjs'), 'utf8');
  const subs = [...gitOpsSrc.matchAll(/case '([a-z][a-z-]*)':/g)].map((m) => m[1]);
  const mdFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) mdFiles.push(p);
    }
  };
  walk(path.join(root, 'core'));
  walk(path.join(root, 'adapters'));
  const stale = [];
  for (const file of mdFiles) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      // Упоминанием считаем только «git-ops[.mjs] <подкоманда>»: «git — через
      // git-ops.mjs» и «git-ops) и передаёт текстом» подкоманду не называют.
      for (const m of line.matchAll(/git-ops(?:\.mjs)?\s+([a-z][a-z-]*)/g)) {
        if (!subs.includes(m[1])) stale.push(`${rel}: git-ops ${m[1]}`);
        if (line.includes('--kind')) stale.push(`${rel}: --kind`);
      }
    }
  }
  if (subs.length && !stale.length) ok('git-ops: подкоманды и флаги в текстах совпадают с dispatch (' + subs.join(', ') + ')');
  else bad('git-ops: устаревшие вызовы в текстах: ' + (stale.join('; ') || 'не разобран dispatch git-ops.mjs'));
}

// 2d) Каталог интента создаётся ЗАПИСЬЮ intent.md: mkdir по тому же пути
// guard проекта отклоняет (в папке артефактов разрешены только *.md и
// meta.json — проверка запрета ниже, на временном workspace). Отдельный шаг
// «создай папку» в стейдже упирается в собственный запрет проекта, и узнаёт
// об этом пользователь посреди этапа. Поэтому шага быть не должно, а пометка
// про mkdir — должна: без неё модель придумает команду сама.
console.log('Стейдж intent — каталог интента:');
{
  const intentMd = fs.readFileSync(path.join(root, 'core/stages/intent.md'), 'utf8');
  const orders = intentMd.split('\n').filter((l) => /^\s*\d+\.\s*Созда/i.test(l) && /папк/i.test(l));
  if (!orders.length && intentMd.includes('mkdir'))
    ok('stage intent: каталог создаётся записью intent.md, отдельного шага с mkdir нет');
  else
    bad(
      'stage intent: ' +
        (orders.length ? `предписан шаг создания каталога: ${orders.join(' | ')}` : 'нет пометки, что mkdir каталога запрещён'),
    );
}

// 2e) Скилл велит выполнить _common.md и intent.md ЦЕЛИКОМ, но два раздела
// общих правил для intent'а невыполнимы и противоречат стейджу: «Определение
// задачи» уводит к TASK-ID из tasks/ и полям из meta.json (у intent'а свой
// INTENT-N и никакого meta.json), «Завершение этапа» требует
// validate-task-folder по папке задачи и отметки stages.<этап>.done в
// meta.json (папки задачи нет вовсе). Список исключений сами эти разделы не
// перечисляют, поэтому оговорка обязана стоять в стейдже — иначе слабая
// модель пойдёт по общему правилу.
console.log('Стейдж intent — неприменимые разделы _common.md:');
{
  const intentFlat = fs.readFileSync(path.join(root, 'core/stages/intent.md'), 'utf8').replace(/\s+/g, ' ');
  const commonMd = fs.readFileSync(path.join(root, 'core/stages/_common.md'), 'utf8');
  const sections = ['Определение задачи', 'Завершение этапа'];
  const renamed = sections.filter((s) => !commonMd.includes(`## ${s}`));
  // Имя раздела и «не применяются» — в одном предложении: упоминание раздела
  // само по себе оговоркой не является.
  const unmarked = sections.filter((s) => !new RegExp(`${s}[^.]{0,200}не примен`).test(intentFlat));
  if (!renamed.length && !unmarked.length)
    ok('stage intent: разделы _common.md «' + sections.join('», «') + '» помечены как неприменимые');
  else
    bad(
      'stage intent: ' +
        (renamed.length ? `в _common.md нет разделов: ${renamed.join(', ')}` : `оговорка не найдена: ${unmarked.join(', ')}`),
    );
}

// 2f) Валидатор возвращает не только ok: непустой `placeholders` — это
// оставшийся в артефакте каркас шаблона, причём ok при этом true. intent —
// единственный производящий этап без цикла ревью, и шаг валидации,
// реагирующий только на ok:false, принимает нетронутый шаблон за готовый
// артефакт. Поэтому шаг обязан назвать поле и предписать реакцию.
console.log('Стейдж intent — остатки каркаса шаблона:');
{
  const intentMd = fs.readFileSync(path.join(root, 'core/stages/intent.md'), 'utf8');
  // Шаг валидации целиком: от его номера до следующего пункта алгоритма.
  const step = (intentMd.split(/\n(?=\d+\. )/).find((s) => s.includes('validate-artifact.mjs')) || '').replace(/\s+/g, ' ');
  const named = /placeholders/.test(step);
  const reaction = /placeholders[^.]{0,200}(верн|возврат|покаж)/i.test(step);
  if (named && reaction) ok('stage intent: шаг валидации реагирует на непустой placeholders');
  else
    bad(
      'stage intent: ' +
        (named ? 'placeholders назван, но реакция на него не предписана' : 'шаг валидации не упоминает placeholders'),
    );
}

// 3) Scripts run against a temp workspace
console.log('Поведение скриптов (временный workspace):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-check-'));
try {
  // Рабочие копии лежат внутри workspace: repos/<dir>
  const repoSA = path.join(tmp, 'repos', 'system-analysis');
  const repoBE = path.join(tmp, 'repos', 'backend');
  fs.mkdirSync(path.join(repoSA, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repoBE, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'settings.json'),
    JSON.stringify(
      {
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: { link: 'repos/system-analysis', mainBranch: 'main' },
          frontend: { link: '', mainBranch: 'main' },
          backend: { link: 'repos/backend', mainBranch: 'master' },
          autoTest: { link: '', mainBranch: 'main' },
        },
        reviewRounds: '${CONVEYOR_REVIEW_ROUNDS}',
        fast: '${CONVEYOR_FAST}',
        language: 'ru',
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(tmp, '.env'), 'CONVEYOR_REVIEW_ROUNDS=\nCONVEYOR_FAST=\n');

  const rc = JSON.parse(runScript('core/scripts/resolve-config.mjs', [tmp]));
  if (rc.found && rc.links.systemsAnalysis.path === path.resolve(repoSA))
    ok('resolve-config: link резолвится в абсолютный путь от workspaceRoot');
  else bad('resolve-config: путь не разрезолвился: ' + JSON.stringify(rc.links && rc.links.systemsAnalysis));
  if (rc.missingLinks && rc.missingLinks.includes('frontend') && rc.missingLinks.includes('autoTest'))
    ok('resolve-config: пустые ссылки попадают в missingLinks');
  else bad('resolve-config: missingLinks: ' + JSON.stringify(rc.missingLinks));
  if (rc.missingLinks && !rc.missingLinks.includes('systemsAnalysis'))
    ok('resolve-config: заполненная ссылка не в missingLinks');
  else bad('resolve-config: заполненная ссылка ошибочно в missingLinks');
  if (rc.links.backend.mainBranch === 'master' && rc.links.autoTest.mainBranch === 'main')
    ok('resolve-config: mainBranch читается из settings.json');
  else bad('resolve-config: mainBranch: ' + JSON.stringify([rc.links.backend.mainBranch, rc.links.autoTest.mainBranch]));
  if (rc.links.systemsAnalysis.inside === true) ok('resolve-config: inside=true для пути внутри workspace');
  else bad('resolve-config: inside не выставлен');
  if (rc.repoCacheEnabled === undefined) ok('resolve-config: repoCacheEnabled удалён');
  else bad('resolve-config: repoCacheEnabled ещё возвращается');
  if (rc.config && rc.config.reviewRounds === 2) ok('resolve-config: reviewRounds по умолчанию = 2');
  else bad('resolve-config: reviewRounds не 2: ' + (rc.config && rc.config.reviewRounds));

  // Контракт resolve-config в core/stages/_common.md модель читает на КАЖДОМ
  // этапе. Поле, которого скрипт больше не отдаёт, — тихий fail-open:
  // предписанный по нему останов не срабатывает НИКОГДА (undefined вместо
  // списка). Поэтому сверяем названия полей в тексте с реальным ответом
  // скрипта, а не со списком по памяти.
  {
    const commonMd = fs.readFileSync(path.join(root, 'core/stages/_common.md'), 'utf8');
    const section = commonMd.split(/^## /m).find((s) => s.startsWith('Первый шаг')) || '';
    // Берём только одиночные идентификаторы в обратных кавычках: `found:false`
    // или `repos.<ключ>.link` — это не имена полей верхнего уровня.
    const mentioned = [...new Set((section.match(/`[A-Za-z][A-Za-z0-9]*`/g) || []).map((s) => s.slice(1, -1)))];
    const ghosts = mentioned.filter((f) => !Object.keys(rc).includes(f));
    if (section && mentioned.includes('missingLinks') && mentioned.includes('urlLinks') && !ghosts.length)
      ok('_common.md: контракт resolve-config назван полями, которые скрипт действительно отдаёт');
    else
      bad(
        '_common.md: контракт resolve-config разошёлся со скриптом — ' +
          (section ? `нет в ответе: ${ghosts.join(', ') || '(нет)'}; названо: ${mentioned.join(', ')}` : 'секция «Первый шаг» не найдена'),
      );
  }

  // validate-config — SessionStart-хук с fail-open: любая его ошибка глотается,
  // и вместо подсказок пользователь получает тишину при коде 0. Поэтому
  // проверяем именно ВЫВОД, а не факт запуска.
  const vcCtxOf = (input) => {
    const out = runScript('core/scripts/validate-config.mjs', [], input).trim();
    try {
      return JSON.parse(out).hookSpecificOutput.additionalContext || '';
    } catch {
      return '';
    }
  };

  // Ссылки-исключения — на отдельном мини-workspace: основная фикстура держит
  // проверки scope/guard, а четырёх ключей на все случаи не хватает. git-URL
  // плагин не принимает (он не клонирует): если такая ссылка станет resolved,
  // repoRootFor выдаст путь ВНУТРИ workspace и тихо расширит права записи.
  const tmpLinks = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-links-'));
  try {
    // Ссылка наружу уводит ВЫШЕ системного temp (до корня диска): сосед
    // временного workspace лежал бы в temp, а туда запись разрешена сама по
    // себе — и дыра в правах на такой цели не видна. Каталог не создаём:
    // проверяется решение о записи, а не наличие файлов.
    const outsideRepo = path.join(path.parse(tmpLinks).root, 'conveyor-outside-frontend');
    const outsideValue = path.relative(tmpLinks, outsideRepo).split(path.sep).join('/');
    fs.writeFileSync(
      path.join(tmpLinks, 'settings.json'),
      JSON.stringify({
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: { link: 'git@git.example.com:group/system-analysis.git', mainBranch: 'main' },
          frontend: { link: outsideValue, mainBranch: 'main' },
          backend: { link: '', mainBranch: 'main' },
          autoTest: { link: '  repos/autotests  ', mainBranch: '  develop  ' },
        },
      }),
    );
    const rcL = JSON.parse(runScript('core/scripts/resolve-config.mjs', [tmpLinks]));
    const urlLink = (rcL.links && rcL.links.systemsAnalysis) || {};
    if (
      (rcL.urlLinks || []).join(',') === 'systemsAnalysis' &&
      urlLink.isGitUrl === true &&
      urlLink.inside === false &&
      urlLink.path === null
    )
      ok('resolve-config: git-URL → urlLinks, inside=false, path=null (в путь не превращается)');
    else bad('resolve-config: git-URL обработан как путь: ' + JSON.stringify({ urlLinks: rcL.urlLinks, urlLink }));
    if (!(rcL.missingLinks || []).includes('systemsAnalysis'))
      ok('resolve-config: git-URL — не пропущенная ссылка (missingLinks про пустые)');
    else bad('resolve-config: git-URL попал в missingLinks: ' + JSON.stringify(rcL.missingLinks));
    // У значения не должно быть двух написаний: stage-файлы отсылают модель к
    // config.repos.<ключ>.link, ядро считает по links.<ключ>.value —
    // нормализация обязана быть одна на оба поля (как у mainBranch).
    const padded = (rcL.config && rcL.config.repos && rcL.config.repos.autoTest) || {};
    if (
      rcL.links.autoTest.value === 'repos/autotests' &&
      padded.link === rcL.links.autoTest.value &&
      padded.mainBranch === rcL.links.autoTest.mainBranch
    )
      ok('resolve-config: пробелы вокруг link/mainBranch срезаны в обоих полях (config.repos и links)');
    else
      bad(
        'resolve-config: у ссылки два написания: ' +
          JSON.stringify({ config: padded, link: rcL.links.autoTest }),
      );
    // Ссылка «../…» выводит из проекта ровно так же, как чужой диск: путь
    // остаётся для диагностики, но пригодной ссылка не считается.
    const outsideLink = (rcL.links && rcL.links.frontend) || {};
    if (outsideLink.inside === false && outsideLink.path === outsideRepo)
      ok('resolve-config: ссылка наружу — path для диагностики, inside=false');
    else bad('resolve-config: путь вне workspace: ' + JSON.stringify(outsideLink));
    // Проверяем не флаг, а его последствие: корень «наружу» не должен
    // становиться записываемым — иначе запись уходит за пределы проекта.
    const outsideWrite = runScript(
      'core/scripts/guard-writes.mjs',
      [],
      JSON.stringify({
        cwd: tmpLinks,
        tool_input: { file_path: path.join(outsideRepo, 'x.js') },
      }),
    ).trim();
    if (outsideWrite && JSON.parse(outsideWrite).hookSpecificOutput.permissionDecision === 'deny')
      ok('guard-writes: ссылка наружу не даёт права записи вне workspace');
    else bad('guard-writes: запись по ссылке наружу разрешена: ' + JSON.stringify(outsideWrite));

    // Хук обязан назвать ОБА вида непригодной ссылки: молчаливая ссылка наружу
    // доводит пользователя до deny guard-writes («путь вне разрешённых
    // корней») — сообщения не про конфигурацию и не про тот скрипт.
    const vcLinksBad = vcCtxOf(JSON.stringify({ cwd: tmpLinks }));
    if (vcLinksBad.includes('frontend') && /вне рабочего репозитория/.test(vcLinksBad))
      ok('validate-config: ссылка наружу названа ключом (третья категория)');
    else bad('validate-config: ссылка наружу не названа: ' + JSON.stringify(vcLinksBad));
    if (vcLinksBad.includes('systemsAnalysis') && vcLinksBad.includes('git-URL'))
      ok('validate-config: ссылка-git-URL названа ключом и по сути');
    else bad('validate-config: git-URL не назван: ' + JSON.stringify(vcLinksBad));
  } finally {
    fs.rmSync(tmpLinks, { recursive: true, force: true });
  }

  // BOM (U+FEFF) в начале файла — штатный результат стандартных средств Windows
  // (PowerShell `Set-Content -Encoding utf8`, «UTF-8 with BOM» в редакторе).
  // Голый JSON.parse на таком файле падает, и не работает ВЕСЬ плагин, а не
  // одна команда: settings.json читает ядро, meta.json — хук сессии.
  const tmpBom = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-bom-'));
  try {
    const withBom = (obj) => '\uFEFF' + JSON.stringify(obj, null, 2);
    fs.writeFileSync(
      path.join(tmpBom, 'settings.json'),
      withBom({
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: { link: 'repos/system-analysis', mainBranch: 'main' },
          frontend: { link: '', mainBranch: 'main' },
          backend: { link: '', mainBranch: 'main' },
          autoTest: { link: '', mainBranch: 'main' },
        },
      }),
    );
    const rcBom = JSON.parse(runScript('core/scripts/resolve-config.mjs', [tmpBom]));
    if (rcBom.found === true && !rcBom.error && rcBom.config && rcBom.config.taskPrefix === 'TASK')
      ok('readConfig: settings.json с BOM читается');
    else bad('readConfig: settings.json с BOM не читается: ' + JSON.stringify(rcBom.error || rcBom.config));

    const bomTask = path.join(tmpBom, 'tasks', 'BE', 'TASK-9');
    fs.mkdirSync(bomTask, { recursive: true });
    fs.writeFileSync(
      path.join(bomTask, 'meta.json'),
      withBom({ taskId: 'TASK-9', type: 'BE', stages: { specification: { done: true }, plan: { done: false } } }),
    );
    const vcBom = vcCtxOf(JSON.stringify({ cwd: tmpBom }));
    if (vcBom.includes('TASK-9')) ok('validate-config: meta.json с BOM разбирается');
    else bad('validate-config: meta.json с BOM не разобран: ' + JSON.stringify(vcBom));
  } finally {
    fs.rmSync(tmpBom, { recursive: true, force: true });
  }

  // git-ops locate: --link — путь ОТ корня рабочего репозитория (settings.json),
  // поэтому резолвится от --workspace. Скрипт запускается из чужого каталога:
  // молчаливый резолв от cwd даёт «не найдено» там, где путь верный.
  const locOk = JSON.parse(
    runScript(
      'core/scripts/git-ops.mjs',
      ['locate', '--link', 'repos/system-analysis', '--workspace', tmp, '--name', 'systemsAnalysis'],
      '',
      os.tmpdir(),
    ),
  );
  if (locOk.ok === true && locOk.path === path.resolve(repoSA))
    ok('git-ops locate: относительный link резолвится от --workspace, а не от cwd');
  else bad('git-ops locate: link не разрезолвился от workspace: ' + JSON.stringify(locOk));
  // Без --workspace резолвить не от чего — отказ, а не тихий резолв от cwd
  // (здесь cwd специально совпадает с workspace, чтобы такой резолв «сработал»).
  const locNoWs = JSON.parse(
    runScript('core/scripts/git-ops.mjs', ['locate', '--link', 'repos/system-analysis'], '', tmp),
  );
  if (locNoWs.ok === false && String(locNoWs.error).includes('--workspace'))
    ok('git-ops locate: без --workspace — ошибка, а не резолв от cwd');
  else bad('git-ops locate: без --workspace принят: ' + JSON.stringify(locNoWs));
  // В ошибке об отсутствующей копии база резолва должна быть НАЗВАНА: иначе
  // «repos/nope» не отличить от опечатки в --workspace.
  const locMissing = JSON.parse(
    runScript('core/scripts/git-ops.mjs', ['locate', '--link', 'repos/nope', '--workspace', tmp, '--name', 'autoTest'], '', tmp),
  );
  if (locMissing.ok === false && String(locMissing.error).includes(path.join(tmp, 'repos', 'nope')))
    ok('git-ops locate: в ошибке об отсутствующей копии назван абсолютный путь');
  else bad('git-ops locate: путь резолва не назван: ' + JSON.stringify(locMissing));

  // Граница проекта — тот же критерий, что у ядра. Фикстура живая: рабочая
  // копия СУЩЕСТВУЕТ и является git-репозиторием, только лежит вне рабочего
  // репозитория. Без общего критерия locate рапортует ok:true, /setup считает
  // репозиторий найденным, а конфигурация разваливается много позже — на
  // guard-writes, чужим текстом про «путь вне разрешённых корней».
  const outsideCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-loc-out-'));
  try {
    fs.mkdirSync(path.join(outsideCopy, '.git'), { recursive: true });
    const outsideCopyValue = path.relative(tmp, outsideCopy).split(path.sep).join('/');
    const locOutside = runScriptFull(
      'core/scripts/git-ops.mjs',
      ['locate', '--link', outsideCopyValue, '--workspace', tmp, '--name', 'backend'],
      '',
      tmp,
    );
    const locOutsideObj = JSON.parse(locOutside.stdout || '{}');
    if (
      locOutside.status !== 0 &&
      locOutsideObj.ok === false &&
      String(locOutsideObj.error).includes(outsideCopy) &&
      /внутри рабочего репозитория/.test(String(locOutsideObj.error))
    )
      ok('git-ops locate: копия вне рабочего репозитория отклонена (код ≠ 0, путь назван)');
    else
      bad(
        'git-ops locate: копия вне рабочего репозитория принята: ' +
          JSON.stringify({ status: locOutside.status, out: locOutsideObj }),
      );
  } finally {
    fs.rmSync(outsideCopy, { recursive: true, force: true });
  }

  // git-ops update: рабочая копия принадлежит разработчику, и его ветку этап
  // не переключает НИ ПРИ КАКИХ условиях. Фикстура — настоящий git-репозиторий:
  // проверяется наблюдаемое состояние (на какой ветке осталась копия), а не
  // текст скрипта. Legacy-флаг `--kind cache` включал здесь checkout main —
  // передаём его специально: устаревший вызов из стейджа не должен воскресить
  // переключение.
  const liveRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-live-'));
  try {
    const g = (a) => spawnSync('git', a, { cwd: liveRepo, encoding: 'utf8' });
    g(['init', '--quiet']);
    fs.writeFileSync(path.join(liveRepo, 'README.md'), '# fixture\n');
    g(['add', '-A']);
    g(['-c', 'user.email=check@conveyor.local', '-c', 'user.name=check', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'init']);
    g(['branch', '-m', 'main']);
    g(['checkout', '--quiet', '-b', 'TASK-1-feature']);
    const branchNow = () => g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    if (branchNow() !== 'TASK-1-feature') {
      bad('git-ops update: фикстура git-репозитория не собралась (есть ли git в PATH?)');
    } else {
      const upd = JSON.parse(
        runScript('core/scripts/git-ops.mjs', ['update', '--path', liveRepo, '--main', 'main', '--mode', 'read', '--kind', 'cache']),
      );
      if (upd.ok === true && branchNow() === 'TASK-1-feature')
        ok('git-ops update: ветка рабочей копии не переключается (в том числе с legacy --kind cache)');
      else bad('git-ops update: копия оказалась на ветке ' + branchNow() + ': ' + JSON.stringify(upd));
    }
  } finally {
    fs.rmSync(liveRepo, { recursive: true, force: true, maxRetries: 3 });
  }

  // analysis-head удалена: этап спецификации сам вносит правки и знает свой
  // дифф, реконструировать головной ref больше не по чему. Регрессия здесь —
  // вернувшаяся подкоманда, поэтому ждём именно отказ dispatch.
  const ah = runScriptFull(
    'core/scripts/git-ops.mjs',
    ['analysis-head', '--path', repoSA, '--branch', 'TASK-1-analysis', '--main', 'main'],
    '',
    tmp,
  );
  const ahObj = JSON.parse(ah.stdout || '{}');
  if (ah.status !== 0 && ahObj.ok === false && /неизвестная подкоманда/.test(String(ahObj.error)))
    ok('git-ops: подкоманда analysis-head удалена');
  else bad('git-ops: analysis-head отвечает как подкоманда: ' + JSON.stringify({ status: ah.status, out: ahObj }));

  const vcLinks = vcCtxOf(JSON.stringify({ cwd: tmp }));
  if (vcLinks.includes('frontend') && vcLinks.includes('autoTest'))
    ok('validate-config: предупреждает о незаданных ссылках репозиториев');
  else bad('validate-config: нет предупреждения о незаданных ссылках: ' + JSON.stringify(vcLinks));
  if (vcLinks.includes('implement-plan') && vcLinks.includes('implement-auto-test'))
    ok('validate-config: называет заблокированные этапы');
  else bad('validate-config: нет списка заблокированных этапов: ' + JSON.stringify(vcLinks));

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

  // guard-writes: repos.*.link в settings.json — путь ВНУТРИ корня проекта.
  // git-URL плагин не клонирует, а путь наружу (абсолютный, «../», «..») не
  // даёт рабочей копии — всё это отвергается прямо при записи (иначе /setup
  // напишет конфигурацию, с которой ни один этап не соберёт рабочую копию).
  const writeLink = (val) =>
    runScript(
      'core/scripts/guard-writes.mjs',
      [],
      JSON.stringify({
        cwd: tmp,
        tool_input: {
          file_path: path.join(tmp, 'settings.json'),
          content: JSON.stringify({ repos: { backend: { link: val } } }),
        },
      }),
    ).trim();
  const relLink = writeLink('repos/backend');
  if (relLink === '') ok('guard-writes: относительный link в settings.json разрешён');
  else bad('guard-writes: канонический link отклонён: ' + relLink);
  const linkDenied = (val) => {
    const out = writeLink(val);
    return out !== '' && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';
  };
  // Относительный выход наружу («../repo», «..») по последствиям равен
  // абсолютному пути чужого каталога, поэтому проверяются они вместе.
  const badLinks = [
    'git@git.example.com:group/backend.git',
    process.platform === 'win32' ? 'C:/repos/backend' : '/repos/backend',
    '../outside-backend',
    '..',
  ];
  const passedLinks = badLinks.filter((v) => !linkDenied(v));
  if (!passedLinks.length) ok('guard-writes: git-URL и любой путь наружу в link ЗАБЛОКИРОВАНЫ');
  else bad('guard-writes: непригодный link прошёл: ' + passedLinks.join(' | '));

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

  // Хук досказывает сессию до конца: предупреждение об активной области идёт
  // ПОСЛЕ блока ссылок, и сбой наверху main() уносит его вместе с собой.
  const vcScope = vcCtxOf(JSON.stringify({ cwd: tmp }));
  if (vcScope.includes('create-specification') && vcScope.includes('systemsAnalysis'))
    ok('validate-config: сообщает об активной рабочей области этапа');
  else bad('validate-config: активная область не названа: ' + JSON.stringify(vcScope));

  if (writeTo(path.join(repoSA, 'doc.md')) === '') ok('scope: запись в SA (в области) разрешена');
  else bad('scope: запись в SA ошибочно заблокирована');
  const denyBE = writeTo(path.join(repoBE, 'src.js'));
  if (denyBE && JSON.parse(denyBE).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: запись в backend (вне области) ЗАБЛОКИРОВАНА');
  else bad('scope: запись в backend вне области не заблокирована');
  if (writeTo(path.join(tmp, 'tasks/FE/TASK-1/feature.md')) === '') ok('scope: артефакты задачи всегда разрешены');
  else bad('scope: артефакты задачи заблокированы при активном scope');
  // intents/ — артефакты БА, писать можно при активном этапе
  if (writeTo(path.join(tmp, 'intents/INTENT-1/intent.md')) === '')
    ok('scope: intents/ разрешён при активном этапе');
  else bad('scope: intents/ заблокирован');
  // repos/<незаконфигуренный> при активном этапе — deny (это чужая рабочая копия)
  const denyUnknownRepo = writeTo(path.join(tmp, 'repos/unknown/x.js'));
  if (denyUnknownRepo && JSON.parse(denyUnknownRepo).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: запись в незаконфигуренный repos/* заблокирована');
  else bad('scope: незаконфигуренный repos/* прошёл');
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
  // то же правило в intents/: интент — документ, исходникам в нём не место
  const denyIntentTsx = writeTo(path.join(tmp, 'intents/INTENT-1/hack.tsx'));
  if (denyIntentTsx && JSON.parse(denyIntentTsx).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: исходник (.tsx) в папке интента ЗАБЛОКИРОВАН');
  else bad('scope: исходник в папке интента прошёл');
  const denyIntentNested = writeTo(path.join(tmp, 'intents/INTENT-1/src/util.js'));
  if (denyIntentNested && JSON.parse(denyIntentNested).hookSpecificOutput.permissionDecision === 'deny')
    ok('scope: исходник во вложенной папке интента заблокирован');
  else bad('scope: вложенный исходник в папке интента прошёл');
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
  if (writeTo(path.join(tmp, 'intents/INTENT-1/manual.tsx')) === '')
    ok('scope: без scope whitelist папки интента не применяется');
  else bad('scope: whitelist папки интента ошибочно активен без scope');
  if (!fs.existsSync(scopeFilePath(tmp))) ok('scope: clear удаляет файл области из temp');
  else bad('scope: clear не удалил файл области');

  // ---- защита от обходов (findings верификации) ----
  const runBash = (cmd) =>
    runScript('core/scripts/guard-bash.mjs', [], JSON.stringify({ cwd: tmp, tool_input: { command: cmd } })).trim();
  const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow');

  runScript('core/scripts/scope.mjs', ['set', '--stage', 'create-specification', '--type', 'FE'], '', tmp);

  // cd-трекинг: относительный редирект после cd в чужой репозиторий
  if (decisionOf(runBash('cd repos/backend && echo hack > src.js')) === 'deny') ok('guard-bash: cd-трекинг ловит редирект в чужой репо');
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

  // scope.mjs валидация аргументов. Отказ должен быть заметен и вызывающему
  // скрипту, и модели: ненулевой код возврата И причина в тексте.
  const badStage = runScriptFull('core/scripts/scope.mjs', ['set', '--stage', 'implment'], '', tmp);
  if (badStage.status === 1 && badStage.stdout.includes('неизвестный этап'))
    ok('scope: неизвестный этап отклоняется с кодом 1');
  else bad(`scope: опечатка в этапе не отлавливается: код ${badStage.status}, вывод: ${(badStage.stdout || badStage.stderr).trim()}`);

  // Парная проверка: без неё регрессия «всегда единица» выглядит как успех —
  // код 1 у отказа перестал бы что-либо означать.
  const okStage = runScriptFull('core/scripts/scope.mjs', ['set', '--stage', 'create-plan', '--type', 'BE'], '', tmp);
  if (okStage.status === 0) ok('scope: корректный set возвращает код 0');
  else bad(`scope: корректный set вернул код ${okStage.status}: ${(okStage.stdout || okStage.stderr).trim()}`);
  runScript('core/scripts/scope.mjs', ['clear'], '', tmp); // проверки ниже ждут «области нет»

  // Отказ от неизвестного флага проверяется так же по двум признакам: код
  // возврата и названный флаг в тексте. Здесь ещё и разобранный JSON.
  const runScope = (argv) => {
    const r = runScriptFull('core/scripts/scope.mjs', argv, '', tmp);
    return { code: r.status, out: JSON.parse(r.stdout || '{}') };
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

  // У intent типа задачи НЕТ вовсе (FE/BE решает системный аналитик позже),
  // поэтому обязательный --type сделал бы этап невыполнимым, а придуманный
  // «FE» — записал бы в область неправду. Тип у такого этапа запрещён: иначе
  // скопированная из соседнего этапа строка молча проходит.
  const intentWithType = runScope(['set', '--stage', 'intent', '--type', 'FE', '--task', 'INTENT-7']);
  const scopeAfterIntentType = JSON.parse(runScript('core/scripts/scope.mjs', ['show'], '', tmp));
  if (
    intentWithType.code !== 0 &&
    intentWithType.out.ok === false &&
    intentWithType.out.error.includes('--type') &&
    intentWithType.out.error.includes('intent') &&
    scopeAfterIntentType.state === 'none'
  )
    ok('scope: --type у этапа без типа (intent) отклоняется, область не установлена');
  else bad('scope: --type у intent принят: ' + JSON.stringify(intentWithType));

  const intentSet = runScope(['set', '--stage', 'intent', '--task', 'INTENT-7']);
  if (
    intentSet.code === 0 &&
    intentSet.out.scope.taskType === null &&
    intentSet.out.scope.taskId === 'INTENT-7' &&
    intentSet.out.scope.writeRepos.length === 0
  )
    ok('scope: set --stage intent без --type принят, запись в репозитории запрещена');
  else bad('scope: intent без --type не принят: ' + JSON.stringify(intentSet));

  // Каталог интента появляется при записи артефакта: сам каталог — не *.md и
  // не meta.json, поэтому mkdir по нему guard запрещает (обе формы, с -p и
  // без). Это опора текста стейджа: он предписывает Write, а не mkdir.
  const mkdirIntent = ['mkdir intents/INTENT-7', 'mkdir -p intents/INTENT-7'].map((c) => decisionOf(runBash(c)));
  if (mkdirIntent.every((d) => d === 'deny') && writeTo(path.join(tmp, 'intents/INTENT-7/intent.md')) === '')
    ok('guard-bash: mkdir каталога интента запрещён, запись intent.md разрешена');
  else bad('guard-bash: mkdir каталога интента: ' + mkdirIntent.join(', '));

  runScript('core/scripts/scope.mjs', ['clear'], '', tmp);

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

  // Токен без двух дефисов парсер складывал в args._, который никто не читает,
  // — потерянный дефис отказывал так же тихо, как неизвестный флаг: фаза B
  // спецификации сохраняла запись в анализ, хотя вызывающий её снимал.
  const lostDash = runScope(['set', '--stage', 'create-specification', '--type', 'BE', '-write', 'none']);
  if (lostDash.code !== 0 && lostDash.out.ok === false && lostDash.out.error.includes('-write'))
    ok('scope: потерянный дефис (-write) отклоняется с названием аргумента');
  else bad('scope: потерянный дефис принят: ' + JSON.stringify(lostDash));

  // Пробел в списке --write отрезал хвост так же молча: запись разрешалась
  // только frontend, а backend выбрасывался.
  const spacedList = runScope(['set', '--stage', 'implement-plan', '--type', 'BE', '--write', 'frontend,', 'backend']);
  if (spacedList.code !== 0 && spacedList.out.ok === false && spacedList.out.error.includes('backend'))
    ok('scope: хвост списка --write через пробел отклоняется');
  else bad('scope: хвост списка --write молча выброшен: ' + JSON.stringify(spacedList));
  runScript('core/scripts/scope.mjs', ['clear'], '', tmp);

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

  // validate-artifact: intent — шаблон этапа БА обязан проходить свою же проверку
  const intentPath = path.join(tmp, 'intent-test.md');
  const intentTpl = fs.readFileSync(path.join(root, 'core/templates/intent.md'), 'utf8');
  const intentSections = [
    '## Проблема и контекст',
    '## Бизнес-ценность',
    '## Границы',
    '## Критерии приёмки',
    '## Источники в анализе',
    '## Открытые вопросы',
  ];
  fs.writeFileSync(intentPath, intentTpl);
  const vaIntent = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'intent']));
  if (vaIntent.ok === true && vaIntent.placeholders.length)
    ok('validate-artifact: шаблон intent проходит валидацию, плейсхолдеры — предупреждение');
  else bad('validate-artifact: шаблон intent не прошёл: ' + JSON.stringify(vaIntent));

  // КАЖДЫЙ плейсхолдер шаблона обязан быть виден детектору: intent —
  // единственный этап без цикла ревью, и подсказка, которую детектор не матчит
  // (нет буквы после «<» или длиннее лимита), уезжает в артефакт молча.
  // Собираем токены шаблона наивно — всё в угловых скобках, кроме
  // html-комментариев, — и требуем, чтобы каждый попал в placeholders.
  const intentTokens = (intentTpl.match(/<[^<>\n]+>/g) || []).filter((t) => !t.startsWith('<!'));
  const intentUnseen = intentTokens.filter((t) => !vaIntent.placeholders.includes(t));
  if (intentTokens.length && !intentUnseen.length)
    ok(`validate-artifact: все ${intentTokens.length} плейсхолдеров шаблона intent видны детектору`);
  else bad('validate-artifact: детектор не видит плейсхолдеры шаблона intent: ' + JSON.stringify(intentUnseen));

  // Каркас из правильных заголовков с пустыми телами — не заполненный intent:
  // структурное правило требует хотя бы один критерий приёмки чекбоксом.
  fs.writeFileSync(intentPath, intentSections.map((h) => h + '\n').join('\n'));
  const vaIntentSkel = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'intent']));
  if (vaIntentSkel.ok === false && !vaIntentSkel.missingSections.length && vaIntentSkel.problems.length)
    ok('validate-artifact: intent из одних заголовков не проходит (нет критериев приёмки)');
  else bad('validate-artifact: каркас intent прошёл валидацию: ' + JSON.stringify(vaIntentSkel));

  // Обратная сторона: неполный intent обязан назвать ИМЕННО недостающие
  // разделы — иначе выпадение раздела из REQUIRED.intent не поймается.
  fs.writeFileSync(intentPath, '# Пусто\n## Проблема и контекст\nх\n## Открытые вопросы\nх\n');
  const vaIntentBad = runScriptFull('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'intent']);
  const vaIntentBadOut = JSON.parse(vaIntentBad.stdout);
  const intentMissWant = intentSections.filter((h) => h !== '## Проблема и контекст' && h !== '## Открытые вопросы');
  if (
    vaIntentBadOut.ok === false &&
    vaIntentBad.status === 1 &&
    JSON.stringify(vaIntentBadOut.missingSections) === JSON.stringify(intentMissWant)
  )
    ok('validate-artifact: неполный intent называет недостающие разделы (код возврата 1)');
  else bad('validate-artifact: состав missingSections у intent: ' + JSON.stringify(vaIntentBadOut));

  // Типы удалённых этапов больше не принимаются, тип плана автотестов принимается.
  for (const gone of ['feature', 'requirements-auto-test']) {
    const vaGone = runScript('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', gone]);
    if (/неизвестный тип/.test(vaGone)) ok(`validate-artifact: тип ${gone} удалён`);
    else bad(`validate-artifact: тип ${gone} ещё есть: ${vaGone}`);
  }
  const vaAtp = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'autotest-plan']));
  if (vaAtp.missingSections && vaAtp.missingSections.includes('## Тест-кейсы'))
    ok('validate-artifact: тип autotest-plan известен');
  else bad('validate-artifact: тип autotest-plan не заведён: ' + JSON.stringify(vaAtp));

  // Спецификация получила два новых обязательных раздела (шаблон правит Task 15).
  const specPath = path.join(tmp, 'spec-test.md');
  fs.writeFileSync(specPath, '# Спецификация\n## Цель\nх\n## Открытые вопросы\nх\n');
  const vaSpec = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', specPath, '--type', 'specification']));
  if (
    vaSpec.missingSections.includes('## Границы задачи') &&
    vaSpec.missingSections.includes('## Внесённые изменения анализа')
  )
    ok('validate-artifact: спецификация требует «Границы задачи» и «Внесённые изменения анализа»');
  else bad('validate-artifact: новые разделы спецификации не обязательны: ' + JSON.stringify(vaSpec.missingSections));

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

  // ---- миграция рабочего репозитория 1.x -> 2.0 ----
  {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-old-'));
    try {
      fs.writeFileSync(
        path.join(old, 'settings.json'),
        JSON.stringify({
          taskPrefix: 'TASK',
          repos: {
            systemsAnalysis: { link: '${SYSTEMS_ANALYSIS_REPO}', mainBranch: '${SYSTEMS_ANALYSIS_MAIN_BRANCH}' },
            frontend: { link: '${FRONTEND_REPO}', mainBranch: '${FRONTEND_MAIN_BRANCH}' },
            backend: { link: '${BACKEND_REPO}', mainBranch: '${BACKEND_MAIN_BRANCH}' },
            autoTest: { link: '${AUTOTEST_REPO}', mainBranch: '${AUTOTEST_MAIN_BRANCH}' },
          },
          repoCache: '${CONVEYOR_REPO_CACHE}',
          reviewRounds: '${CONVEYOR_REVIEW_ROUNDS}',
          fast: '${CONVEYOR_FAST}',
          language: 'ru',
        }, null, 2),
      );
      fs.writeFileSync(path.join(old, '.env'), 'SYSTEMS_ANALYSIS_REPO=C:/work/sa\nBACKEND_MAIN_BRANCH=master\n');
      const taskDir = path.join(old, 'tasks', 'BE', 'TASK-3');
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, 'meta.json'),
        JSON.stringify({
          taskId: 'TASK-3',
          type: 'BE',
          analysisBranch: 'TASK-3-analysis',
          analysisShaAtFeature: 'abc123',
          stages: {
            feature: { done: true },
            specification: { done: true, baseSha: 'abc123', headSha: 'def456' },
            plan: { done: false },
            'implement-plan': { done: false },
            'requirements-auto-test': { done: false },
            'implement-auto-test': { done: false },
          },
        }, null, 2),
      );
      fs.writeFileSync(path.join(taskDir, 'feature.md'), '# Фича\n');
      fs.writeFileSync(path.join(taskDir, 'requirements-auto-test.md'), '# Требования\n');

      // Задача с meta.json только для чтения (на Windows это же даёт файл,
      // открытый редактором, OneDrive или антивирус). Идёт ПЕРВОЙ по имени:
      // сбой записи на ней не должен оставить остальные задачи не
      // мигрированными и не должен превратить stdout в сырой стек.
      const roDir = path.join(old, 'tasks', 'BE', 'TASK-1');
      fs.mkdirSync(roDir, { recursive: true });
      const roMeta = path.join(roDir, 'meta.json');
      fs.writeFileSync(roMeta, JSON.stringify({ taskId: 'TASK-1', type: 'BE', stages: { feature: { done: true } } }, null, 2));
      fs.chmodSync(roMeta, 0o444);

      // meta.json с BOM: тот же дефект чтения, что и у settings.json.
      const bomDir = path.join(old, 'tasks', 'BE', 'TASK-5');
      fs.mkdirSync(bomDir, { recursive: true });
      fs.writeFileSync(
        path.join(bomDir, 'meta.json'),
        '\uFEFF' + JSON.stringify({ taskId: 'TASK-5', type: 'BE', stages: { feature: { done: false } } }, null, 2),
      );

      // сухой прогон ничего не меняет
      const dry = JSON.parse(runScript('core/scripts/migrate-workspace.mjs', [old]));
      const stillOld = JSON.parse(fs.readFileSync(path.join(old, 'settings.json'), 'utf8'));
      if (dry.ok && dry.applied === false && 'repoCache' in stillOld) ok('migrate: сухой прогон ничего не меняет');
      else bad('migrate: сухой прогон изменил файлы');

      // Вызывающая сторона парсит stdout как JSON: сбой записи обязан остаться
      // внутри контракта вывода, а не уйти сырым стеком в stderr.
      const applyRun = runScriptFull('core/scripts/migrate-workspace.mjs', [old, '--apply']);
      let res;
      try {
        res = JSON.parse(applyRun.stdout);
        ok('migrate: при сбое записи stdout остаётся валидным JSON');
      } catch (e) {
        res = { changes: [], warnings: [], writeErrors: [] };
        bad('migrate: stdout не JSON: ' + JSON.stringify(applyRun.stdout.slice(0, 120)));
      }
      const st = JSON.parse(fs.readFileSync(path.join(old, 'settings.json'), 'utf8'));
      if (!('repoCache' in st) && st.repos.systemsAnalysis.link === 'repos/system-analysis')
        ok('migrate: settings.json переведён на пути repos/*');
      else bad('migrate: settings.json не мигрирован: ' + JSON.stringify(st.repos));
      if (st.repos.backend.mainBranch === 'master') ok('migrate: mainBranch перенесён из .env');
      else bad('migrate: mainBranch не перенесён: ' + st.repos.backend.mainBranch);

      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8'));
      if (meta.schemaVersion === 2) ok('migrate: schemaVersion добавлен');
      else bad('migrate: нет schemaVersion');
      if (meta.stages.specification.analysisDone === true && meta.analysisBaseSha === 'abc123')
        ok('migrate: этап feature свёрнут в specification.analysisDone');
      else bad('migrate: feature не свёрнут: ' + JSON.stringify(meta.stages.specification));
      if (meta.stages['autotest-plan'] && !meta.stages['requirements-auto-test'])
        ok('migrate: этап requirements-auto-test переименован');
      else bad('migrate: этап не переименован: ' + Object.keys(meta.stages).join(','));
      if (fs.existsSync(path.join(taskDir, 'autotest-plan.md')) && !fs.existsSync(path.join(taskDir, 'requirements-auto-test.md')))
        ok('migrate: артефакт переименован в autotest-plan.md');
      else bad('migrate: артефакт не переименован');
      if (fs.existsSync(path.join(taskDir, 'feature.md'))) ok('migrate: feature.md сохранён как легаси-артефакт');
      else bad('migrate: feature.md удалён — так нельзя');
      if (fs.readFileSync(path.join(old, '.gitignore'), 'utf8').includes('repos/'))
        ok('migrate: .gitignore дополнен');
      else bad('migrate: .gitignore не дополнен');
      if (res.changes.length >= 4) ok('migrate: отчёт о изменениях сформирован');
      else bad('migrate: пустой отчёт: ' + JSON.stringify(res.changes));

      // Порядок этапов в meta.json — канонический: иначе «следующий этап»
      // в /task-status считается по autotest-plan ПОСЛЕ implement-auto-test.
      const stageOrder = Object.keys(meta.stages).join(',');
      if (stageOrder === 'specification,plan,implement-plan,autotest-plan,implement-auto-test')
        ok('migrate: этапы в meta.json пересобраны в каноническом порядке');
      else bad('migrate: порядок этапов: ' + stageOrder);

      // Задача с BOM в meta.json мигрирована, а не отброшена как «не
      // разбирается».
      const bomMeta = JSON.parse(fs.readFileSync(path.join(bomDir, 'meta.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (bomMeta.schemaVersion === 2) ok('migrate: meta.json с BOM мигрирован');
      else bad('migrate: meta.json с BOM не мигрирован: ' + JSON.stringify(res.warnings));

      // Сбой записи назван отдельно от обычных предупреждений, код возврата
      // ненулевой, остальные задачи при этом мигрированы (проверено выше).
      const writeErrors = res.writeErrors || [];
      if (writeErrors.some((w) => w.includes('TASK-1')) && applyRun.status !== 0)
        ok('migrate: сбой записи назван в writeErrors, код возврата ненулевой');
      else
        bad(
          'migrate: сбой записи не назван: ' +
            JSON.stringify({ writeErrors, status: applyRun.status }),
        );

      // Явно переданный каталог обязан САМ быть корнем workspace. Существующий
      // подкаталог (копия без settings.json, копия внутри настоящего
      // workspace) не должен уводить миграцию вверх — под --apply это правки
      // в репозитории, который человек не называл.
      const deeper = path.join(old, 'sub', 'deeper');
      fs.mkdirSync(deeper, { recursive: true });
      const deeperRun = runScriptFull('core/scripts/migrate-workspace.mjs', [deeper]);
      let deeperObj = {};
      try {
        deeperObj = JSON.parse(deeperRun.stdout);
      } catch {
        /* проверка ниже сообщит */
      }
      if (
        deeperObj.ok === false &&
        deeperRun.status !== 0 &&
        String(deeperObj.error || '').includes('settings.json')
      )
        ok('migrate: существующий подкаталог без settings.json отвергается, без подъёма вверх');
      else
        bad(
          'migrate: подъём вверх от явного пути: ' +
            JSON.stringify({ stdout: deeperRun.stdout.slice(0, 160), status: deeperRun.status }),
        );

      // Явно переданный путь с опечаткой: молчаливый подъём вверх взял бы
      // корень СОВСЕМ ДРУГОГО workspace — под --apply это правки не в том
      // репозитории.
      const missRun = runScriptFull('core/scripts/migrate-workspace.mjs', [path.join(old, 'tasks', 'BE', 'TASK-999')]);
      let missObj = {};
      try {
        missObj = JSON.parse(missRun.stdout);
      } catch {
        /* проверка ниже сообщит */
      }
      if (missObj.ok === false && missRun.status !== 0 && String(missObj.error || '').includes('TASK-999'))
        ok('migrate: несуществующий путь — остановка с ошибкой, без подъёма вверх');
      else
        bad(
          'migrate: несуществующий путь принят: ' +
            JSON.stringify({ out: missRun.stdout.slice(0, 160), status: missRun.status }),
        );
    } finally {
      // Атрибут «только чтение» снимаем, иначе каталог не удалить.
      try {
        fs.chmodSync(path.join(old, 'tasks', 'BE', 'TASK-1', 'meta.json'), 0o666);
      } catch {
        /* файла может не быть */
      }
      fs.rmSync(old, { recursive: true, force: true });
    }

    // settings.json версии 1.x правили руками: форма может быть любой.
    // Непонятную запись скрипт обязан положить в warnings, а не упасть стеком.
    const bent = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-bent-'));
    try {
      fs.writeFileSync(path.join(bent, 'settings.json'), '{"repos":{"backend":"C:/work/be"}}');
      const bentRun = runScriptFull('core/scripts/migrate-workspace.mjs', [bent]);
      let bentObj = {};
      try {
        bentObj = JSON.parse(bentRun.stdout);
      } catch {
        /* проверка ниже сообщит */
      }
      if ((bentObj.warnings || []).some((w) => w.includes('backend')))
        ok('migrate: repos.<ключ> строкой вместо объекта — предупреждение, а не падение');
      else
        bad(
          'migrate: нестандартный settings.json уронил скрипт: ' +
            JSON.stringify({ out: bentRun.stdout.slice(0, 160), err: bentRun.stderr.slice(0, 160) }),
        );
    } finally {
      fs.rmSync(bent, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`Проверка не пройдена: ${failures} ошибок.`);
  process.exit(1);
}
console.log('Все проверки пройдены.');
