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
  ARTIFACT_DIRS,
  REPO_KEYS,
  REPO_DIRS,
  STAGE_NAMES,
  STAGES_WITHOUT_TASK_TYPE,
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

// 1b) settings-шаблон содержит ожидаемые ключи и НЕ содержит удалённых
{
  const st = JSON.parse(fs.readFileSync(path.join(root, 'core/templates/settings.example.json'), 'utf8'));
  const need = ['taskPrefix', 'repos', 'reviewRounds', 'fast', 'language'];
  const miss = need.filter((k) => !(k in st));
  if (!miss.length) ok('settings.example.json: все ключи на месте (' + need.join(', ') + ')');
  else bad('settings.example.json: нет ключей: ' + miss.join(', '));
  if (!('repoCache' in st)) ok('settings.example.json: repoCache удалён');
  else bad('settings.example.json: repoCache ещё есть');
  // `repos` разбираем только убедившись, что это объект: голый
  // Object.values(undefined) бросает TypeError на верхнем уровне модуля и
  // уносит ВЕСЬ прогон — вместо списка проблем человек видит стек, а двести
  // оставшихся проверок не выполняются.
  if (!st.repos || typeof st.repos !== 'object' || Array.isArray(st.repos)) {
    bad('settings.example.json: repos не объект: ' + JSON.stringify(st.repos));
  } else {
    // Критерий один: ссылка обязана быть РОВНО дефолтом из REPO_DIRS. Префикс
    // «repos/» пропускал опечатку (repos/frontend-typo), а такой шаблон даёт
    // свежему рабочему репозиторию каталог, куда никто ничего не склонирует.
    const linkDiff = REPO_KEYS.filter((k) => !st.repos[k] || st.repos[k].link !== REPO_DIRS[k]);
    const extraKeys = Object.keys(st.repos).filter((k) => !REPO_KEYS.includes(k));
    if (!linkDiff.length && !extraKeys.length) ok('settings.example.json: ссылки — дефолты REPO_DIRS по всем ключам');
    else
      bad(
        'settings.example.json: ссылки разошлись с REPO_DIRS: ' +
          [
            linkDiff.map((k) => `${k}→${JSON.stringify(st.repos[k] && st.repos[k].link)} (ждали ${REPO_DIRS[k]})`).join(', ') ||
              null,
            extraKeys.length ? `лишние ключи: ${extraKeys.join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('; '),
      );
  }
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
for (const st of ['create-specification', 'implement-plan', 'implement-auto-test']) {
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

// «Определение задачи» в _common.md ложно для create-specification: аргументом
// может быть INTENT-ID, при пустом аргументе предлагаются intent'ы, а тип и
// номер спрашиваются у аналитика — задача там ЗАВОДИТСЯ, а не читается.
// intent.md защищён собственным блоком исключений, у create-specification.md
// такого блока нет, а _common.md модель читает РАНЬШЕ стейджа — поэтому
// оговорка обязана стоять в самом разделе.
console.log('Раздел «Определение задачи» — область применения:');
{
  const commonMd = fs.readFileSync(path.join(root, 'core/stages/_common.md'), 'utf8');
  const section = (commonMd.split(/^## /m).find((s) => s.startsWith('Определение задачи')) || '').replace(/\s+/g, ' ');
  const namesExceptions = /create-specification/.test(section) && /intent/.test(section);
  const marksThem = /(исключени|не примен|задачи ещё нет|задачу ЗАВОДИТ)/i.test(section);
  if (section && namesExceptions && marksThem)
    ok('_common.md: «Определение задачи» называет intent и create-specification исключениями');
  else
    bad(
      '_common.md: «Определение задачи» — ' +
        (!section
          ? 'раздел не найден'
          : !namesExceptions
            ? 'в разделе не названы этапы-исключения (intent, create-specification)'
            : 'этапы названы, но не помечены как исключения'),
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

// 2g) Стейдж create-specification — единственный этап, который ПИШЕТ в чужой
// репозиторий, и самый дорогой в конвейере. Проверяем не «текст красивый», а
// пять свойств, потерю которых пользователь замечает уже после испорченной
// ветки анализа или сожжённого прогона.
console.log('Стейдж create-specification — две фазы:');
{
  const csMd = fs.readFileSync(path.join(root, 'core/stages/create-specification.md'), 'utf8');
  const flat = (s) => s.replace(/\s+/g, ' ');
  const section = (name) => csMd.split(/^## /m).find((s) => s.startsWith(name)) || '';
  const phaseA = section('Фаза A');
  const phaseB = section('Фаза B');

  // Право записи в анализ отбирается на границе фаз: scope.mjs поддерживает
  // `--write none` именно ради фазы B. Забытый флаг оставляет агенту сборки
  // спецификации запись в чужой репозиторий — правки пойдут мимо ревью и
  // мимо коммита, а спецификация будет собрана по диффу, который им уже не
  // соответствует.
  const setsScope = (s) => /scope\.mjs\S*\s+set\b/.test(flat(s));
  if (setsScope(phaseA) && !phaseA.includes('--write none') && setsScope(phaseB) && phaseB.includes('--write none'))
    ok('stage create-specification: фаза A ставит область записи, фаза B — --write none');
  else
    bad(
      'stage create-specification: смена области между фазами — ' +
        (!phaseA || !phaseB
          ? 'нет разделов «Фаза A»/«Фаза B»'
          : `фаза A: set=${setsScope(phaseA)}, --write none=${phaseA.includes('--write none')}; ` +
            `фаза B: set=${setsScope(phaseB)}, --write none=${phaseB.includes('--write none')}`),
    );

  // Подэтапы analysisDone/specDone — ради них делалась миграция задач 1.x.
  // Без предписания «при analysisDone:true работа фазы A не переигрывается»
  // обрыв на фазе B приводит к повторному прогону правок ЧУЖОГО репозитория
  // поверх уже закоммиченных. (Что при этом всё же выполняется — проверяет
  // отдельная проверка ниже: «пропусти фазу A целиком» уносило с собой
  // обязательные resolve-config и locate.)
  const idem = flat(section('Идемпотентность'));
  const flags = /analysisDone/.test(idem) && /specDone/.test(idem);
  // \w в JS — только латиница: для «фазы B» нужен \S.
  const skipsA = /пропуск|пропусти/i.test(idem) && /не переигрыва/i.test(idem) && /фаз\S* B/i.test(idem);
  if (flags && skipsA) ok('stage create-specification: повторный запуск при analysisDone:true начинается с фазы B');
  else
    bad(
      'stage create-specification: идемпотентность — ' +
        (flags
          ? 'подэтапы названы, но пропуск работы фазы A при analysisDone:true не предписан'
          : 'раздел не называет analysisDone/specDone'),
    );

  // Ревью идёт ДО коммита (_review-loop.md, «Что ревьюит reviewer»): reviewer
  // смотрит НЕзакоммиченные правки. Коммит, предписанный раньше цикла, молча
  // отдаёт в ветку анализа неотревьюенное.
  const reviewAt = phaseA.indexOf('_review-loop.md');
  const commitAt = phaseA.search(/^\s*\d+\.\s*Закоммить/m);
  if (reviewAt > -1 && /systems-analysis/.test(phaseA) && commitAt > reviewAt)
    ok('stage create-specification: цикл ревью (домен systems-analysis) в фазе A, коммит — после него');
  else
    bad(
      'stage create-specification: ревью в фазе A — ' +
        (reviewAt < 0
          ? 'нет ссылки на _review-loop.md'
          : !/systems-analysis/.test(phaseA)
            ? 'не назван домен systems-analysis'
            : 'шаг коммита не найден или стоит до ревью'),
    );

  // Валидатор при остатках каркаса шаблона отдаёт ok:true и непустой
  // placeholders. На этом этапе цикл ревью смотрит правки анализа, а не текст
  // спецификации, поэтому placeholders — единственный сигнал «секцию не
  // заполнили» (та же логика, что в 2f для intent).
  const step = (csMd.split(/\n(?=\d+\. )/).find((s) => s.includes('validate-artifact.mjs')) || '').replace(/\s+/g, ' ');
  const named = /placeholders/.test(step);
  const reaction = /placeholders[^.]{0,200}(верн|возврат|покаж)/i.test(step);
  if (named && reaction) ok('stage create-specification: шаг валидации реагирует на непустой placeholders');
  else
    bad(
      'stage create-specification: ' +
        (named ? 'placeholders назван, но реакция на него не предписана' : 'шаг валидации не упоминает placeholders'),
    );

  // Свойство «не переигрывать правки чужого репозитория» держится не на
  // флагах, а на том, что повторный запуск ВООБЩЕ распознан: единственный
  // признак — обратный индекс `tasks/*/*/meta.json → intentId`, и пройти его
  // надо ДО вопроса про тип/номер и ДО заведения задачи (иначе на повторе
  // появится ВТОРАЯ задача на тот же intent). Ветка «сразу фаза B» обязана
  // перечислить, что всё равно выполняется: resolve-config (workspaceRoot,
  // links, mainBranch) и `git-ops locate` — без него у шага диффа фазы B
  // неоткуда взять `--path <repo>`.
  const args = section('Разбор аргументов');
  const detectAt = phaseA.search(/tasks\/\*\/\*\/meta\.json/);
  const createAt = phaseA.search(/со скелетом/);
  const detectsFirst = detectAt > -1 && createAt > -1 && detectAt < createAt;
  const argsDefer = /повторн/i.test(args);
  const keepsMandatory = /resolve-config/.test(idem) && /locate/.test(idem);
  if (detectsFirst && argsDefer && keepsMandatory)
    ok('stage create-specification: повторный запуск распознаётся по intentId до вопросов и до заведения задачи');
  else
    bad(
      'stage create-specification: распознавание повторного запуска — ' +
        [
          detectsFirst ? null : 'обратный индекс tasks/*/*/meta.json не пройден до шага со скелетом meta.json',
          argsDefer ? null : '«Разбор аргументов» не отсылает к повторному запуску перед вопросом о типе/номере',
          keepsMandatory ? null : 'ветка «сразу фаза B» не называет resolve-config и locate как обязательные',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Обратного индекса по intentId мало: migrate-workspace.mjs проставляет
  // задачам 1.x `intentId: null` и папки `intents/` для них не существует —
  // такую задачу индекс не находит НИКОГДА, а запуск с чужим INTENT-ID завёл
  // бы ВТОРУЮ задачу и переиграл правки чужого репозитория. Ровно этим
  // задачам task-status.md обещает продолжение с фазы B, поэтому этап обязан
  // принимать аргументом и TASK-ID, а ветка по TASK-ID — вести сразу в фазу B.
  const argLine = (csMd.match(/^\*\*Аргументы:\*\*.*$/m) || [''])[0];
  const bothIds = /INTENT-ID\s*\|\s*TASK-ID/.test(argLine);
  const tellsApart = /intents\//.test(args) && /tasks\//.test(args) && /TASK-ID/.test(args);
  const taskIdBranch = section('Идемпотентность')
    .split(/\n(?=- )/)
    .map(flat)
    .filter((b) => b.startsWith('- '))
    .find((b) => /TASK-ID/.test(b));
  const branchToB = !!taskIdBranch && /(фаз\S* B|шаг 13)/i.test(taskIdBranch);
  const branchMigrated = !!taskIdBranch && /(null|мигрир)/i.test(taskIdBranch);
  if (bothIds && tellsApart && branchToB && branchMigrated)
    ok('stage create-specification: задача с пустым intentId продолжается запуском по TASK-ID');
  else
    bad(
      'stage create-specification: запуск по TASK-ID — ' +
        [
          bothIds ? null : 'строка «Аргументы» не принимает TASK-ID наравне с INTENT-ID',
          tellsApart ? null : '«Разбор аргументов» не говорит, как отличить TASK-ID от INTENT-ID (intents/ vs tasks/)',
          taskIdBranch ? null : 'в «Идемпотентности» нет ветки по TASK-ID',
          !taskIdBranch || branchToB ? null : 'ветка по TASK-ID не ведёт в фазу B',
          !taskIdBranch || branchMigrated ? null : 'ветка по TASK-ID не названа путём для задач с intentId: null',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Папка задачи (на паре FE-BE их две) появляется ЗАПИСЬЮ meta.json: сам
  // каталог — не *.md и не meta.json, поэтому mkdir по нему guard отклоняет
  // (проверка запрета — ниже, на временном workspace), а подсказка отказа
  // здесь ещё и уводит в сторону («исходники пиши в рабочую копию»). Значит
  // шага «создай папку» быть не должно, а пометка про mkdir — должна.
  const orders = phaseA.split('\n').filter((l) => /^\s*\d+\.\s*Созда/i.test(l) && /папк/i.test(l));
  const mkdirNote = /mkdir[^.]{0,200}(guard|запрещ)/i.test(flat(phaseA));
  if (!orders.length && mkdirNote)
    ok('stage create-specification: папки задач появляются записью meta.json, отдельного шага с mkdir нет');
  else
    bad(
      'stage create-specification: ' +
        (orders.length
          ? `предписан шаг создания папки: ${orders.join(' | ')}`
          : 'нет пометки, что mkdir папки задачи guard запрещает'),
    );

  // Документы анализа — .adoc/.yml/.xml. Переформатирование раздувает дифф на
  // весь файл, а по этому диффу работают и ревью фазы A, и сборка
  // спецификации в фазе B: запрет обязан быть в тексте этапа, как и проверка
  // синтаксиса машиночитаемых файлов после правок.
  const machine = /\.adoc/.test(csMd) && /\.ya?ml/.test(csMd) && /\.xml/.test(csMd);
  const noReformat = /переформатиров\S*[^.]{0,120}(ЗАПРЕЩ|запрещ|нельз)/i.test(flat(csMd));
  if (machine && noReformat) ok('stage create-specification: форматы анализа проверяются, переформатирование запрещено');
  else
    bad(
      'stage create-specification: правки документов — ' +
        (machine ? 'нет запрета на переформатирование' : 'не названы форматы .adoc/.yml/.xml'),
    );

  // На паре FE-BE этап производит ДВЕ задачи и ДВЕ спецификации, и оговорка
  // про пару обязана стоять в КАЖДОМ шаге, который называет одну задачу.
  // В фазе A она есть (шаги 3 и 12), в фазе B её недоставало: шаг области
  // (`--type FE-BE`, `--task` FE-задачи) и шаг завершения
  // (validate-task-folder, specDone/done, baseSha/headSha — в ОБЕ задачи).
  // Без неё слабая модель закрывает только FE-задачу, а /task-status потом
  // вечно предлагает повторить этап для BE.
  const stepWith = (section, marker) =>
    flat(section.split(/\n(?=\d+\. )/).find((s) => s.includes(marker)) || '');
  const scopeStepB = stepWith(phaseB, 'scope.mjs');
  const finishStepB = stepWith(phaseB, 'validate-task-folder');
  const pairNoted = (s) => /(для пары|пары FE-BE|обеих|обе задачи)/i.test(s);
  if (scopeStepB && finishStepB && pairNoted(scopeStepB) && pairNoted(finishStepB))
    ok('stage create-specification: в фазе B пара FE-BE оговорена и в шаге области, и в шаге завершения');
  else
    bad(
      'stage create-specification: пара FE-BE в фазе B — ' +
        [
          scopeStepB ? null : 'не найден шаг со scope.mjs',
          finishStepB ? null : 'не найден шаг с validate-task-folder',
          !scopeStepB || pairNoted(scopeStepB) ? null : 'шаг области не говорит, что для пары передаётся FE-BE и TASK-ID FE-задачи',
          !finishStepB || pairNoted(finishStepB) ? null : 'шаг завершения не говорит, что закрываются ОБЕ задачи пары',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Самое вероятное состояние после обрыва посреди фазы A — НЕЗАКОММИЧЕННЫЕ
  // правки анализа в рабочей копии: повторный запуск приходит на шаг с
  // `git-ops update --mode write`, а тот на грязной копии этап останавливает.
  // Ответ «остановка с показом git status» тут неполон: правки могут быть
  // СВОИМИ, от прерванного прогона (признак — ветка анализа по этому
  // INTENT-ID уже создана), и пользователь остаётся без выхода. Текст обязан
  // описывать развилку — доревьюить и закоммитить либо откатить — и то, что
  // выбирает пользователь: молча коммитить или откатывать чужую работу
  // нельзя.
  const dirtyBullet = flat(section('Ошибки').split(/\n(?=- )/).find((b) => /грязн/i.test(b)) || '');
  const ownEdits = /ветк/i.test(dirtyBullet) && /(сво|прерван|прошл)/i.test(dirtyBullet);
  const bothWays = /коммит/i.test(dirtyBullet) && /откат/i.test(dirtyBullet);
  const userDecides = /(спрос|выбор|решает пользовател|предлож)/i.test(dirtyBullet) && /нельзя/i.test(dirtyBullet);
  if (dirtyBullet && ownEdits && bothWays && userDecides)
    ok('stage create-specification: грязная копия после обрыва — развилка «закоммитить / откатить» по решению пользователя');
  else
    bad(
      'stage create-specification: грязная рабочая копия — ' +
        [
          dirtyBullet ? null : 'в «Ошибках» нет пункта про грязную копию',
          !dirtyBullet || ownEdits ? null : 'не сказано, что правки могут быть своими от прерванного прогона (признак — ветка анализа)',
          !dirtyBullet || bothWays ? null : 'не предложены оба выхода: доревьюить и закоммитить либо откатить',
          !dirtyBullet || userDecides ? null : 'не сказано, что выбирает пользователь и что молча трогать чужую работу нельзя',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2h) Скилл и команда — то, что модель читает ПЕРЕД стейджем. Пересказ старого
// контракта (feature.md как предусловие, `--since`, analysisShaAtFeature)
// уводит её на удалённый маршрут ещё до чтения самого стейджа.
console.log('Скилл и команда create-specification — без старого контракта:');
{
  const stale = [];
  for (const rel of [
    'adapters/claude-code/skills/create-specification/SKILL.md',
    'adapters/gigacode/commands/conveyor/create-specification.md',
  ]) {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const token of ['feature.md', 'create-feature', '--since', 'analysisShaAtFeature'])
      if (txt.includes(token)) stale.push(`${rel}: ${token}`);
  }
  if (!stale.length) ok('create-specification: скилл и команда описывают двухфазный этап');
  else bad('create-specification: остатки старого этапа — ' + stale.join('; '));

  // Продолжение по TASK-ID — единственный вход для задач с пустым intentId, и
  // модель читает про аргументы скилл/команду, а не стейдж: нотация «принимаем
  // и то, и другое» обязана быть во всех трёх файлах. Туда же /task-status:
  // он советует «повторить create-specification», и совет без TASK-ID для
  // мигрированной задачи невыполним — вызывать её нечем.
  const noTaskId = [
    'core/stages/create-specification.md',
    'adapters/claude-code/skills/create-specification/SKILL.md',
    'adapters/gigacode/commands/conveyor/create-specification.md',
  ].filter((rel) => !/INTENT-ID\s*\|\s*TASK-ID/.test(fs.readFileSync(path.join(root, rel), 'utf8')));
  const tsAdvice = (
    fs
      .readFileSync(path.join(root, 'core/stages/task-status.md'), 'utf8')
      .split(/\n\n/)
      .find((p) => /specDone/.test(p)) || ''
  ).replace(/\s+/g, ' ');
  const tsNamesTaskId = /create-specification\s*<?TASK-ID/.test(tsAdvice);
  if (!noTaskId.length && tsNamesTaskId)
    ok('create-specification: приём TASK-ID заявлен в стейдже, скилле и команде; /task-status зовёт этап с TASK-ID');
  else
    bad(
      'create-specification: продолжение по TASK-ID — ' +
        [
          noTaskId.length ? `нет нотации «INTENT-ID | TASK-ID» в: ${noTaskId.join(', ')}` : null,
          tsNamesTaskId ? null : 'task-status.md советует повторить этап, но не называет TASK-ID в вызове',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2i) Команды из скилла модель набирает БУКВАЛЬНО и раньше всего: скилл она
// читает до стейджа. Сокращённая форма вызова — не «покороче», а невыполнимый
// вызов: на `git-ops diff --base … --head …` без `--path` скрипт отвечает
// «diff: --path --base --head required», и этап встаёт на ровном месте —
// причём этот этап единственный пишет в чужой репозиторий. Обязательные флаги
// git-ops берём из самого git-ops.mjs (строки `fail('<sub>: … required')`),
// чтобы проверка не разошлась со скриптом.
console.log('Скилл create-specification — вызовы скриптов в выполнимой форме:');
{
  const skillRel = 'adapters/claude-code/skills/create-specification/SKILL.md';
  // Код-спан в markdown переносится по строкам, поэтому пробелы схлопываем
  // ДО нарезки на спаны — иначе половина команды теряется вместе с переносом.
  const flat = fs.readFileSync(path.join(root, skillRel), 'utf8').replace(/\s+/g, ' ');
  const spans = (flat.match(/`[^`]+`/g) || []).map((s) => s.slice(1, -1).trim());

  const need = new Map();
  const addNeed = (name, re, flags) => {
    const prev = need.get(name);
    need.set(name, { re, flags: [...new Set([...(prev ? prev.flags : []), ...flags])] });
  };
  const gitOpsSrc = fs.readFileSync(path.join(root, 'core/scripts/git-ops.mjs'), 'utf8');
  for (const m of gitOpsSrc.matchAll(/fail\('([a-z][a-z-]*): ([^']*required)'/g))
    addNeed(
      `git-ops ${m[1]}`,
      new RegExp(`git-ops(?:\\.mjs)?"?\\s+${m[1]}\\b`),
      [...m[2].matchAll(/--[a-z-]+/g)].map((f) => f[0]),
    );
  // Остальные скрипты этапа проверяют аргументы по одному (ответом приходит
  // первый недостающий), поэтому их обязательный набор перечислен здесь — см.
  // шапки scope.mjs, validate-artifact.mjs, validate-task-folder.mjs.
  addNeed('scope.mjs set', /scope\.mjs"?\s+set\b/, ['--stage', '--type', '--task']);
  addNeed('validate-artifact', /validate-artifact(?:\.mjs)?\b/, ['--file', '--type']);
  addNeed('validate-task-folder', /validate-task-folder(?:\.mjs)?\b/, ['--task']);

  const short = [];
  for (const span of spans)
    for (const [name, { re, flags }] of need) {
      if (!re.test(span)) continue;
      const miss = flags.filter((f) => !new RegExp(`${f}\\b`).test(span));
      if (miss.length) short.push(`${name}: нет ${miss.join(' ')} → «${span}»`);
    }
  if (need.size && !short.length)
    ok('скилл create-specification: у каждого вызова скрипта все обязательные флаги');
  else
    bad(
      'скилл create-specification: невыполнимые вызовы — ' +
        (short.join('; ') || 'требования git-ops.mjs не разобраны'),
    );
}

// 2j) Домен systems-analysis ревьюит правки анализа в фазе A
// /create-specification, и требования, по которым эти правки внесены, лежат в
// intent.md: feature.md на этом маршруте больше не производится. reviewer —
// субагент, он видит ТОЛЬКО то, что дал скилл, и подменить источник истины
// сам не может: названный не тот файл он либо пойдёт искать, либо будет
// ревьюить правки, не сверяя их с требованиями вообще.
console.log('Промпт reviewer — источник истины домена systems-analysis:');
{
  const rv = fs.readFileSync(path.join(root, 'core/prompts/reviewer.md'), 'utf8');
  const sot = (rv.split(/\n(?=- )/).find((b) => /source-of-truth/.test(b)) || '').replace(/\s+/g, ' ');
  const analysisPart = (sot.match(/для анализа[^;)]*/) || [''])[0];
  if (analysisPart.includes('intent.md') && !analysisPart.includes('feature.md'))
    ok('reviewer.md: для анализа источник истины — intent.md');
  else
    bad(
      'reviewer.md: source-of-truth для анализа — ' +
        (sot ? `«${analysisPart || sot}»` : 'пункт про source-of-truth не найден'),
    );
}

// 2k) Промпт system-analyst и карточка субагента — всё, что агент этапа
// видит о своём маршруте: стейдж он не читает никогда. Пока они пересказывают
// удалённый /create-feature, агент идёт по несуществующему этапу и собирает
// артефакт по шаблону, которого в плагине нет. Проверяем не стиль, а
// совпадение с фактическим create-specification.md там, где расхождение стоит
// дорого: фазы и права записи, источник итога ревью, правила форматов
// анализа и развилки, где требований может не быть вовсе.
console.log('Промпт system-analyst — две фазы этапа create-specification:');
{
  const flatten = (s) => s.replace(/\s+/g, ' ');
  const saPrompt = fs.readFileSync(path.join(root, 'core/prompts/system-analyst.md'), 'utf8');
  const saAgent = fs.readFileSync(path.join(root, 'adapters/claude-code/agents/system-analyst.md'), 'utf8');
  const pf = flatten(saPrompt);
  const af = flatten(saAgent);
  const sect = (name) => flatten(saPrompt.split(/^## /m).find((s) => s.startsWith(name)) || '');

  // Этапа create-feature нет вовсе. Единственное законное упоминание
  // feature.md — легаси-артефакт задачи, продолженной по TASK-ID из 1.x;
  // любое другое зовёт агента производить удалённый артефакт.
  const stale = [];
  for (const [rel, txt] of [
    ['core/prompts/system-analyst.md', pf],
    ['adapters/claude-code/agents/system-analyst.md', af],
  ]) {
    if (txt.includes('create-feature')) stale.push(`${rel}: create-feature`);
    if (
      txt
        .split('feature.md')
        .slice(0, -1)
        .some((p) => !/легаси-$/.test(p))
    )
      stale.push(`${rel}: feature.md без пометки «легаси»`);
  }
  if (!stale.length) ok('system-analyst: промпт и карточка агента без удалённого этапа create-feature');
  else bad('system-analyst: остатки старого маршрута — ' + stale.join('; '));

  // Право записи в чужой репозиторий есть только в фазе A: в фазе B стейдж
  // ставит `--write none`, и агент, считающий, что ему всё ещё можно править
  // анализ, будет упираться в guard вместо сборки спецификации.
  const heads = /^## Фаза A/m.test(saPrompt) && /^## Фаза B/m.test(saPrompt);
  const tools = sect('Инструменты');
  const rights = /фаз\S* A/.test(tools) && /фаз\S* B/.test(tools) && /read-only/i.test(tools);
  const agentPhases = /фаз\S* A/i.test(af) && /фаз\S* B/i.test(af);
  if (heads && rights && agentPhases) ok('system-analyst: обе фазы названы, запись в анализ — только в фазе A');
  else
    bad(
      'system-analyst: фазы — ' +
        [
          heads ? null : 'в промпте нет разделов «Фаза A»/«Фаза B»',
          rights ? null : 'раздел «Инструменты» не разводит права записи по фазам (фаза A / фаза B read-only)',
          agentPhases ? null : 'карточка агента не называет обе фазы',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Раздел «Ревью» спецификации заполняется в фазе B, а сам цикл идёт в фазе
  // A — возможно, в другой сессии. Единственный носитель итога — meta.json;
  // агент, которому не сказано, откуда его брать и что делать при его
  // отсутствии, выдумает замечания задним числом (_review-loop.md, «Запись
  // итога»).
  const rev = sect('Ревью');
  const fromMeta = /stages\.specification\.review/.test(rev);
  const noInvent = /(не выдумыв|не придумыв)/i.test(rev);
  if (fromMeta && noInvent) ok('system-analyst: итог ревью фазы A берётся из meta.json, при его отсутствии не выдумывается');
  else
    bad(
      'system-analyst: раздел «Ревью» — ' +
        (rev
          ? [
              fromMeta ? null : 'не назван источник stages.specification.review',
              noInvent ? null : 'не запрещено выдумывать замечания, когда итога нет',
            ]
              .filter(Boolean)
              .join('; ')
          : 'раздела нет'),
    );

  // Форматы анализа. Каждый пункт — следствие устройства конвейера: .adoc
  // собран из include-кусков (один файл ≠ документ), якоря и xref держат
  // ссылки из других мест, а разобранный и заново сериализованный yml/xml
  // даёт дифф на весь файл — по нему не работают ни ревью фазы A, ни сборка
  // спецификации в фазе B.
  const fmt = sect('Форматы');
  const missing = [
    /include::/.test(fmt) ? null : 'include:: — .adoc собирается из кусков',
    /(якор|anchor|xref)/i.test(fmt) ? null : 'якоря/xref не переименовывать',
    /(не разбирай|не парси|не разбор)/i.test(fmt) && /сериализ/i.test(fmt)
      ? null
      : 'yml/xml — точечно, без разбора и обратной сериализации',
    /(переносы строк|CRLF)/i.test(fmt) ? null : 'сохранение переносов строк',
  ].filter(Boolean);
  if (fmt && !missing.length) ok('system-analyst: правила работы с .adoc/.yml/.xml на месте');
  else bad('system-analyst: форматы анализа — ' + (fmt ? `нет правил: ${missing.join(', ')}` : 'нет раздела про форматы'));

  // Два входа, на которых требований может не быть: задача, продолженная по
  // TASK-ID из 1.x (intent'а не существует), и пустой дифф фазы B. Агент, не
  // предупреждённый об этом, либо встанет, либо сочинит требования сам.
  const phaseB = sect('Фаза B');
  const legacy = /легаси-feature\.md/.test(pf) && /только из диффа/i.test(pf);
  const emptyDiff = /дифф[^.]{0,120}пуст|пуст\S*[^.]{0,60}дифф/i.test(phaseB) && /текущ\S* состояни/i.test(phaseB);
  if (legacy && emptyDiff) ok("system-analyst: развилки без intent'а и с пустым диффом описаны");
  else
    bad(
      'system-analyst: развилки — ' +
        [
          legacy ? null : "не сказано, что вместо intent'а приходит легаси-feature.md, а без него требования только из диффа",
          emptyDiff ? null : 'в фазе B не сказано, что делать при пустом диффе (текущее состояние документов)',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2l) Этап create-autotest-plan стоит на трёх решениях, и каждое держится
// только текстом. Первое: план строится по СПЕЦИФИКАЦИИ — вернувшийся
// `git-ops diff` молча подменяет предмет проверки, и тесты начинают закреплять
// то, что получилось в коде, вместо того чтобы ловить расхождение с
// требованиями. Второе: покрытие критериев приёмки — единственная
// содержательная проверка артефакта, потому что (третье) цикла ревью здесь
// нет, он остаётся на /conveyor:implement-auto-test, где тесты реально
// прогоняются. Скилл и команду модель читает ДО стейджа, поэтому смотрим все
// три файла этапа.
console.log('Этап create-autotest-plan — план по спецификации, без диффа и без ревью:');
{
  const rels = [
    'core/stages/create-autotest-plan.md',
    'adapters/claude-code/skills/create-autotest-plan/SKILL.md',
    'adapters/gigacode/commands/conveyor/create-autotest-plan.md',
  ];
  const absent = rels.filter((rel) => !exists(rel));
  if (absent.length) bad('create-autotest-plan: нет файлов этапа: ' + absent.join(', '));
  else {
    const files = rels.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8').replace(/\s+/g, ' ')]);
    const stageFlat = files[0][1];

    const withDiff = files.filter(([, t]) => /git-ops(?:\.mjs)?"?\s+diff/.test(t)).map(([rel]) => rel);
    const closed = /кодов\S*[^.]{0,140}не открыва/i.test(stageFlat);
    if (!withDiff.length && closed) ok('create-autotest-plan: дифф реализации не готовится, кодовая база не открывается');
    else
      bad(
        'create-autotest-plan: предмет проверки — ' +
          [
            withDiff.length ? `дифф реализации вернулся в ${withDiff.join(', ')}` : null,
            closed ? null : 'в стейдже не сказано, что кодовая база не открывается',
          ]
            .filter(Boolean)
            .join('; '),
      );

    const validates = /validate-artifact[^`]{0,200}--type autotest-plan/.test(stageFlat);
    const coverage = /критери\S* приёмки/i.test(stageFlat) && /не автоматизируется/i.test(stageFlat);
    if (validates && coverage) ok('create-autotest-plan: валидация шаблона плюс покрытие критериев приёмки');
    else
      bad(
        'create-autotest-plan: валидация артефакта — ' +
          [
            validates ? null : 'нет вызова validate-artifact --type autotest-plan',
            coverage ? null : 'не предписана проверка покрытия критериев приёмки («не автоматизируется» с причиной)',
          ]
            .filter(Boolean)
            .join('; '),
      );

    // Подключением считаем ССЫЛКУ НА ФАЙЛ цикла (`core/stages/_review-loop.md`)
    // — так его зовут производящие этапы; голое имя в отрицании («_review-loop.md
    // не подключается») — наоборот, полезная оговорка, как в стейдже intent.
    const withLoop = files.filter(([, t]) => t.includes('core/stages/_review-loop.md')).map(([rel]) => rel);
    const saysNo = /ревью[^.]{0,160}НЕ запускается/.test(stageFlat) && /implement-auto-test/.test(stageFlat);
    if (!withLoop.length && saysNo) ok('create-autotest-plan: цикл ревью не подключён, он остаётся на implement-auto-test');
    else
      bad(
        'create-autotest-plan: цикл ревью — ' +
          [
            withLoop.length ? `подключён в ${withLoop.join(', ')}` : null,
            saysNo ? null : 'в стейдже не сказано, что ревью НЕ запускается и остаётся на implement-auto-test',
          ]
            .filter(Boolean)
            .join('; '),
      );
  }
}

// 2m) qa-autotest-engineer работает на двух этапах подряд, и промпт роли —
// всё, что он о них знает: стейджи субагент не читает никогда. Первый этап
// сменил и имя, и предмет — план строится по СПЕЦИФИКАЦИИ, репозиторий
// автотестов на нём только читается, диффа нет. Промпт, зовущий удалённый
// /create-requirements-auto-test и требующий дифф реализации, отправляет
// агента либо за диффом в закрытую для него кодовую базу, либо писать код
// тестов этапом раньше — в репозиторий, куда на этом этапе запрещена запись.
// Стейдж implement-auto-test — второй конец той же пары: он обязан звать
// артефакт текущим именем, иначе и агент, и ревьюер получат ссылку на файл,
// которого в папке задачи нет.
console.log('qa-autotest-engineer и implement-auto-test — артефакт autotest-plan.md:');
{
  const flatten = (s) => s.replace(/\s+/g, ' ');
  const promptRaw = fs.readFileSync(path.join(root, 'core/prompts/qa-autotest-engineer.md'), 'utf8');
  const stageRaw = fs.readFileSync(path.join(root, 'core/stages/implement-auto-test.md'), 'utf8');
  const prompt = flatten(promptRaw);
  const stage = flatten(stageRaw);
  const sect = (raw, name) => flatten(raw.split(/^## /m).find((s) => s.startsWith(name)) || '');

  const stale = [
    ['core/prompts/qa-autotest-engineer.md', prompt],
    ['core/stages/implement-auto-test.md', stage],
  ]
    .filter(([, t]) => t.includes('requirements-auto-test'))
    .map(([rel]) => rel);
  const named = prompt.includes('/conveyor:create-autotest-plan') && prompt.includes('/conveyor:implement-auto-test');
  if (!stale.length && named) ok('qa-autotest-engineer: этапы названы актуально, удалённого артефакта нет');
  else
    bad(
      'qa-autotest-engineer: маршрут роли — ' +
        [
          stale.length ? `старое имя requirements-auto-test в ${stale.join(', ')}` : null,
          named ? null : 'промпт не называет оба этапа (/conveyor:create-autotest-plan, /conveyor:implement-auto-test)',
        ]
          .filter(Boolean)
          .join('; '),
    );

  const planSect = sect(promptRaw, 'На этапе /conveyor:create-autotest-plan');
  const input = /specification\.md/.test(planSect) && /plan\.md/.test(planSect) && /ТОЛЬКО ДЛЯ ЧТЕНИЯ/i.test(planSect);
  const noDiff = !/дифф/i.test(planSect) && /кодов\S*[^.]{0,140}не открыва/i.test(planSect);
  const noWrite = /(писать|запис\S*)[^.]{0,60}репозитори\S* автотестов[^.]{0,60}(НЕЛЬЗЯ|запрещ)/i.test(planSect);
  if (planSect && input && noDiff && noWrite) ok('qa-autotest-engineer: вход этапа плана — спецификация и план, автотесты read-only, записи нет');
  else
    bad(
      'qa-autotest-engineer: этап плана — ' +
        (planSect
          ? [
              input ? null : 'вход не назван полностью (specification.md, plan.md, путь к автотестам ТОЛЬКО ДЛЯ ЧТЕНИЯ)',
              noDiff ? null : 'дифф реализации не исключён либо не сказано, что кодовая база не открывается',
              noWrite ? null : 'не запрещена запись в репозиторий автотестов на этом этапе',
            ]
              .filter(Boolean)
              .join('; ')
          : 'нет раздела «На этапе /conveyor:create-autotest-plan»'),
    );

  const byCriteria = /критери\S* приёмки/i.test(planSect) && /не автоматизируется/i.test(planSect);
  const traced = /TC-/.test(planSect) && /REQ-/.test(planSect);
  const reuse = /(переиспольз|фикстур)/i.test(planSect) && /дубл/i.test(planSect);
  if (byCriteria && traced && reuse) ok('qa-autotest-engineer: кейсы по критериям приёмки, TC-N → REQ-N, без дублей');
  else
    bad(
      'qa-autotest-engineer: правила кейсов — ' +
        [
          byCriteria ? null : 'кейсы не привязаны к критериям приёмки («не автоматизируется» с причиной)',
          traced ? null : 'нет ID TC-N и трассировки на REQ-N',
          reuse ? null : 'не предписано переиспользовать существующие фикстуры и не дублировать покрытые сценарии',
        ]
          .filter(Boolean)
          .join('; '),
    );

  const pre = /Предусловие:\*\* [^.]{0,40}autotest-plan\.md/.test(stage);
  const agentIn = /qa-autotest-engineer:? вход[^.]{0,80}autotest-plan\.md/i.test(stage);
  const revIn = /reviewer:[^.]{0,120}autotest-plan\.md/i.test(stage);
  const dod = /autotest-plan\.md/.test(sect(stageRaw, 'DoD'));
  if (pre && agentIn && revIn && dod) ok('implement-auto-test: autotest-plan.md в предусловии, входе агента, входе ревьюера и DoD');
  else
    bad(
      'implement-auto-test: имя артефакта — ' +
        [
          pre ? null : 'предусловие не ссылается на autotest-plan.md',
          agentIn ? null : 'во входе qa-autotest-engineer нет autotest-plan.md',
          revIn ? null : 'во входе reviewer нет autotest-plan.md',
          dod ? null : 'DoD не ссылается на autotest-plan.md',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2n) Стейдж /setup создаёт то, из чего потом читает ВЕСЬ плагин, и выполняет
// его основная сессия без агента. Ролей у него две, и они противоположны по
// правам: первичная инициализация (тимлид, один раз) создаёт структуру, а
// диагностика окружения (каждый разработчик после клонирования фасадного
// репозитория) не создаёт ничего — она чаще на порядок. Проверяем то, чего
// пользователь не может исправить постфактум дешёво: пересозданный поверх
// готового settings.json, `git status`, затянувший чужие рабочие деревья,
// шаблон, набранный по памяти (потерянные ключи всплывают этапом позже), и
// таблицу диагностики, разошедшуюся с фактическим ответом repos-status.mjs.
console.log('Стейдж setup — инициализация и диагностика:');
{
  const raw = fs.readFileSync(path.join(root, 'core/stages/setup.md'), 'utf8');
  const flat = raw.replace(/\s+/g, ' ');
  const section = (name) => raw.split(/^## /m).find((s) => s.startsWith(name)) || '';
  const algo = section('Алгоритм');
  const steps = algo.split(/\n(?=\d+\. )/);
  const stepWith = (marker) => (steps.find((s) => s.includes(marker)) || '').replace(/\s+/g, ' ');

  // Роль разработчика — основная по частоте, и её единственная защита в тексте:
  // при существующем settings.json ничего не создаётся и не переписывается.
  // Пересозданный settings.json — это чужие ссылки и taskPrefix команды,
  // затёртые молча, причём заметит это следующий этап, а не /setup.
  // Роли смотрим в шапке (до «## Алгоритм»): это то, что модель прочитает
  // раньше первого шага, и именно там развилка «создать» / «ничего не трогать».
  const preamble = raw.split(/^## /m)[0].replace(/\s+/g, ' ');
  const roles = /перв\S* инициализаци/i.test(preamble) && /диагностик/i.test(preamble);
  const firstStep = stepWith('settings.json');
  // Запрет обязан стоять в ВЕТКЕ «settings.json есть», а не где-нибудь в шаге:
  // рядом живёт фраза про шаги 4-6 («ничего не пересоздают»), и проверка по
  // всему шагу проходила бы, даже если саму гарантию удалить.
  const existsBranch = (firstStep.match(/-\s*\*\*есть\*\*[\s\S]*?(?=-\s*\*\*|$)/) || [''])[0];
  const keeps =
    /(не трога|не перезапис|не пересозда)/i.test(existsBranch) && /диагностик/i.test(existsBranch);
  if (roles && keeps) ok('stage setup: обе роли названы, готовый settings.json не пересоздаётся — сразу диагностика');
  else
    bad(
      'stage setup: две роли — ' +
        [
          roles ? null : 'в тексте нет обеих ролей (первичная инициализация / диагностика)',
          firstStep ? null : 'нет шага, проверяющего наличие settings.json',
          !firstStep || keeps ? null : 'шаг не запрещает трогать существующий settings.json и не уводит в диагностику',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Шаблоны — копированием ФАЙЛОВ: набранный по памяти settings.json теряет
  // ключи, добавленные в шаблон (их отсутствие вскроется на другом этапе), а
  // самопроверка состава ключей — единственное, что ловит это на месте.
  // Каталоги ищем в САМОМ шаге создания структуры, а не по всему файлу: тот же
  // список перечислен в DoD, и по всему файлу проверка проходит даже когда шаг
  // каталог больше не создаёт.
  const initStep = stepWith('copyFileSync');
  const dirs = ['tasks/FE', 'tasks/BE', 'intents/', 'repos/'].filter((d) => !initStep.includes(d));
  const copies = /copyFileSync/.test(flat) && /settings\.example\.json/.test(flat) && /env\.example/.test(flat);
  const byHand = /(НЕ набирай|не набирай)[^.]{0,80}памяти/i.test(flat);
  const selfCheck = /Object\.keys/.test(flat) && /missing/.test(flat);
  if (!dirs.length && copies && byHand && selfCheck)
    ok('stage setup: структура каталогов создаётся, шаблоны копируются файлами, состав ключей сверяется');
  else
    bad(
      'stage setup: инициализация — ' +
        [
          dirs.length ? `не названы каталоги: ${dirs.join(', ')}` : null,
          copies ? null : 'шаблоны не копируются через copyFileSync (settings.example.json, env.example)',
          byHand ? null : 'нет запрета набирать шаблон по памяти',
          selfCheck ? null : 'нет самопроверки состава ключей скопированного settings.json',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Корень плагина, подставленный ВНУТРЬ JS-строки (`copyFileSync('<корень>/…')`),
  // на Windows ломается молча: путь приходит с обратными слэшами, и JS съедает
  // их как escape — `C:\Users\…\test-ai` превращается в `C:Users…` с табуляцией
  // вместо `\t`, а copyFileSync падает с ENOENT на пути, которого никто не
  // писал. Корень отдаём аргументом (`process.argv`), где никакой escape не
  // действует, и обозначаем `${CONVEYOR_ROOT}` — той же нотацией, что и весь
  // остальной плагин, включая соседний шаг диагностики.
  const eCmds = [...flat.matchAll(/node -e "([^"]*)"((?: "[^"]*")*)/g)].map((m) => ({ script: m[1], args: m[2] }));
  const rootCmds = eCmds.filter((c) => /core\/(templates|scripts)\//.test(c.script));
  const rootInString = rootCmds.filter((c) => /CONVEYOR_ROOT/.test(c.script)).length;
  const rootByArg = rootCmds.filter((c) => /process\.argv/.test(c.script) && /\$\{CONVEYOR_ROOT\}/.test(c.args)).length;
  const angleRoot = /<CONVEYOR_ROOT>/.test(flat);
  if (rootCmds.length && !rootInString && rootByArg === rootCmds.length && !angleRoot)
    ok('stage setup: корень плагина в `node -e` передаётся аргументом (process.argv), а не внутрь JS-строки');
  else
    bad(
      'stage setup: корень плагина в командах — ' +
        [
          rootCmds.length ? null : 'нет ни одной команды node -e, читающей файл плагина',
          rootInString ? 'корень подставляется внутрь JS-строки — на Windows обратные слэши съест escape' : null,
          !rootCmds.length || rootByArg === rootCmds.length
            ? null
            : 'корень не передан аргументом "${CONVEYOR_ROOT}" и не прочитан из process.argv',
          angleRoot ? 'нотация <CONVEYOR_ROOT> расходится с ${CONVEYOR_ROOT} из _common.md' : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  // `.gitignore` обязан появиться ДО того, как в `repos/` окажутся рабочие
  // копии: иначе первый же `git status` в фасадном репозитории покажет чужие
  // рабочие деревья целиком, а разработчик их закоммитит. `.cache/` — строка
  // версии 1.x: область этапа давно живёт в системном temp, а каталог кэша
  // клонов удалён вместе с клонированием.
  const giStep = algo.indexOf('.gitignore');
  const diagStep = algo.indexOf('repos-status');
  const giText = stepWith('.gitignore');
  // Строки берём из перечисления («нужны строки: …»), а не из всего шага: сам
  // `repos/` шаг называет и в объяснении, зачем .gitignore пишется раньше
  // рабочих копий, — по всему шагу проверка проходит с пустым перечислением.
  const giListed = (giText.match(/строк[а-яё]*[^]{0,120}/i) || [''])[0];
  const giLines = ['`repos/`', '`.env`'].filter((l) => !giListed.includes(l));
  const staleCache = /\.cache\//.test(giText);
  // Порядка шагов мало: роль «диагностика» уходит из шага 1 сразу к номеру,
  // который там назван, и если это номер ПОСЛЕ .gitignore — состав .gitignore
  // не проверяет вообще никто (в validate-config.mjs его нет, а
  // migrate-workspace.mjs дописывает строки только с --apply). Прерванная
  // инициализация и 1.x без миграции остаются с чужими рабочими деревьями в
  // `git status`. Шаг только дописывает недостающее, поэтому обязан выполняться
  // в обеих ролях.
  const stepNum = (s) => Number((s.match(/(?:^|\n)(\d+)\. /) || [, 0])[1]);
  const giNum = stepNum(steps.find((s) => s.includes('.gitignore')) || '');
  const jumpTo = Number((firstStep.match(/шаг[уа] (\d+)/i) || [, 0])[1]);
  const giBothRoles = /обе(их)? рол/i.test(giText);
  if (giStep > -1 && diagStep > giStep && !giLines.length && !staleCache && jumpTo && giNum && jumpTo <= giNum && giBothRoles)
    ok('stage setup: .gitignore (repos/, .env) дописывается в обеих ролях и до диагностики рабочих копий');
  else
    bad(
      'stage setup: .gitignore — ' +
        [
          giStep > -1 ? null : 'нет шага, записывающего .gitignore',
          giStep > -1 && diagStep > giStep ? null : 'шаг .gitignore стоит не раньше диагностики рабочих копий',
          giLines.length ? `в шаге нет строк: ${giLines.join(', ')}` : null,
          staleCache ? 'предписан .cache/ от версии 1.x' : null,
          !jumpTo || !giNum
            ? 'не разобран переход из шага 1 (нет «переходи к шагу N») или номер шага .gitignore'
            : jumpTo <= giNum
              ? null
              : `роль «диагностика» уходит к шагу ${jumpTo} и перепрыгивает .gitignore (шаг ${giNum})`,
          giBothRoles ? null : 'не сказано, что шаг .gitignore выполняется в обеих ролях',
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Диагностика — это repos-status.mjs, и стейдж обязан называть его поля и
  // состояния ТАК ЖЕ, как их отдаёт скрипт: по чужому имени состояния модель
  // ветку не найдёт и покажет пользователю таблицу собственного сочинения.
  // Ожидаемое берём из исходников, чтобы проверка не разошлась с ними: поля —
  // из ответа repos-status.mjs, состояния — из ядра (config.repoState), где
  // лежит единственный критерий пригодности рабочей копии. Ищем состояния там,
  // где они объявлены, иначе перенос логики в ядро оставит стейдж сверяться с
  // пустым списком.
  const rsSrc = fs.readFileSync(path.join(root, 'core/scripts/repos-status.mjs'), 'utf8');
  const cfgSrc = fs.readFileSync(path.join(root, 'core/scripts/lib/config.mjs'), 'utf8');
  // Литерал entry разбираем по запятым ВЕРХНЕГО уровня и берём имя из каждой
  // части. Регексп «имя, за которым идёт , или :» так не умеет: он съедает
  // разделитель и пропускает каждое второе поле, а последнее — у него
  // завершающего разделителя нет — не видит вовсе. Из-за этого список молча
  // обмелел до key, path, state, clean, и `hint`, который стейдж обязан
  // показывать дословно, не спрашивался со стейджа ничем.
  // Число полей зафиксировано отдельно: разбор берёт ожидаемое из самого
  // скрипта, поэтому без ассерта сжатие repos-status.mjs так же незаметно
  // уменьшит и требования к стейджу — вместе с регрессией, которую эта
  // проверка ловит.
  const RS_FIELD_COUNT = 7; // key, link, path, state, branch, clean, hint
  const topLevelParts = (src) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (const ch of src) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim()).filter(Boolean);
  };
  const entryLiteral = (rsSrc.match(/const entry = \{([^}]*)\}/) || [, ''])[1];
  // Имя поля — начало части: `key` (сокращение) или `key: value`.
  const rsFields = topLevelParts(entryLiteral)
    .map((p) => (p.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/) || [, ''])[1])
    .filter(Boolean);
  // Только тело repoState: в config.mjs есть и состояния рабочей ОБЛАСТИ
  // (none/stale/corrupt/active) — к таблице /setup они отношения не имеют.
  const repoStateSrc = (cfgSrc.match(/export function repoState\(([\s\S]*?)\n\}/) || [''])[0];
  const rsStates = [...new Set([...repoStateSrc.matchAll(/state: '([a-z-]+)'/g)].map((m) => m[1]))];
  // Смотрим шаг диагностики, а не весь файл: часть состояний разбирается ещё
  // и в «Ошибках», и по всему файлу проверка проходит для таблицы, в которой
  // состояния уже нет.
  const diagText = stepWith('repos-status');
  const noField = rsFields.filter((f) => !diagText.includes('`' + f + '`'));
  const noState = rsStates.filter((s) => !diagText.includes('`' + s + '`'));
  const calls = /repos-status\.mjs/.test(diagText);
  const fieldsParsed = rsFields.length === RS_FIELD_COUNT;
  if (calls && fieldsParsed && rsStates.length && !noField.length && !noState.length)
    ok(
      'stage setup: диагностика — repos-status.mjs, все ' +
        RS_FIELD_COUNT +
        ' полей и состояния названы как в скрипте (' +
        rsStates.join(', ') +
        ')',
    );
  else
    bad(
      'stage setup: диагностика — ' +
        [
          calls ? null : 'не вызывается repos-status.mjs',
          fieldsParsed
            ? null
            : `в литерале entry репозиториев разобрано полей: ${rsFields.length} (${rsFields.join(', ') || '—'}), ожидалось ${RS_FIELD_COUNT}` +
              ' — состав ответа repos-status.mjs изменился, обнови RS_FIELD_COUNT и стейдж',
          rsStates.length ? null : 'состояния repoState не разобраны',
          noField.length ? `не названы поля: ${noField.join(', ')}` : null,
          noState.length ? `не названы состояния: ${noState.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Плагин не клонирует — это решение всей версии 2.0. Стейдж, предлагающий
  // `git clone` за пользователя, кладёт чужой репозиторий не туда и не тем
  // способом (ssh-ключи, подмодули, LFS — всё это дело разработчика).
  const clones = /git clone/.test(flat);
  const handover = /клонирует\s+(сам\s+)?разработчик|склонир\S+ (его )?сами|разработчик клонирует/i.test(flat);
  const errs = section('Ошибки').replace(/\s+/g, ' ');
  const namedStates = ['missing', 'link-is-url'].filter((s) => !errs.includes(s));
  if (!clones && handover && !namedStates.length)
    ok('stage setup: плагин не клонирует — рабочую копию разработчик заводит сам');
  else
    bad(
      'stage setup: клонирование — ' +
        [
          clones ? 'в тексте есть git clone' : null,
          handover ? null : 'не сказано, что репозиторий клонирует сам разработчик',
          namedStates.length ? `в «Ошибках» не разобраны состояния: ${namedStates.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Миграция 1.x правит ЧУЖОЙ рабочий репозиторий с реальными задачами, и её
  // сухой прогон — режим по умолчанию не случайно: `--apply`, предложенный
  // первым, переписывает settings.json и meta.json всех задач до того, как
  // пользователь увидел план.
  const mig = stepWith('migrate-workspace');
  const dryFirst = /(сначала|сухой|без)[^.]{0,140}--apply/i.test(mig);
  const next = /\/conveyor:intent/.test(section('Вывод').replace(/\s+/g, ' '));
  // Коммит должен быть ПРЕДПИСАН шагом: названный только во вступлении, он
  // остаётся описанием роли, а не действием — и settings.json не доедет до
  // остальной команды.
  const commits = /(закоммит|коммит)[^.]{0,120}settings\.json|settings\.json[^.]{0,120}(закоммит|коммит)/i.test(
    algo.replace(/\s+/g, ' '),
  );
  if (mig && dryFirst && next && commits)
    ok('stage setup: миграция 1.x предлагается сухим прогоном, settings.json коммитится, следующий шаг — /conveyor:intent');
  else
    bad(
      'stage setup: хвост этапа — ' +
        [
          mig ? null : 'нет шага с migrate-workspace.mjs',
          !mig || dryFirst ? null : 'миграция предложена сразу с --apply',
          commits ? null : 'не сказано, что settings.json коммитится',
          next ? null : 'в «Выводе» не назван следующий шаг /conveyor:intent',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2o) _common.md модель читает на КАЖДОМ этапе, и таблица рабочих областей —
// единственное место, откуда она узнаёт, куда этапу можно писать. Строка
// удалённого этапа хуже отсутствующей: своей строки модель не находит и берёт
// ближайшую — то есть считает, что вправе править чужой репозиторий там, где
// scope.mjs этого права не даёт, и упирается в guard посреди этапа. Состав
// строк и колонку «пишет» сверяем со stageWriteRepoKeys, а не с текстом плана.
console.log('_common.md — таблица рабочих областей против stageWriteRepoKeys:');
{
  const commonRaw = fs.readFileSync(path.join(root, 'core/stages/_common.md'), 'utf8');
  const csect = (name) => commonRaw.split(/^## /m).find((s) => s.startsWith(name)) || '';
  const scopeSect = csect('Рабочая область этапа');
  const rows = scopeSect
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
    .filter((c) => c.length >= 3 && !/^-+$/.test(c[0]) && c[0] !== 'Этап');

  // Область ставят все этапы, кроме служебных setup/task-status: у них нет ни
  // типа задачи, ни рабочих копий.
  const scopedStages = STAGE_NAMES.filter((s) => s !== 'setup' && s !== 'task-status');
  const rowStage = (cell) => (cell.match(/[a-z][a-z-]+/) || [''])[0];
  const listed = rows.map((c) => rowStage(c[0]));
  const unknown = [...new Set(listed.filter((s) => !STAGE_NAMES.includes(s)))];
  const absent = scopedStages.filter((s) => !listed.includes(s));
  if (!unknown.length && !absent.length && rows.length)
    ok('_common.md: в таблице ровно этапы конвейера, у которых есть рабочая область');
  else
    bad(
      '_common.md: состав таблицы рабочих областей — ' +
        [
          rows.length ? null : 'таблица не найдена',
          unknown.length ? `несуществующие этапы: ${unknown.join(', ')}` : null,
          absent.length ? `нет строки для: ${absent.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Строка intent появилась в таблице вместе с самим этапом, а образец вызова
  // над таблицей остался с `--type <FE|BE>`: у этапов из STAGES_WITHOUT_TASK_TYPE
  // тип не просто лишний — scope.mjs его ОТВЕРГАЕТ, и область не встанет вовсе.
  const noTypeStage = STAGES_WITHOUT_TASK_TYPE.filter(
    (s) => !new RegExp(`--stage ${s}\\b(?![^\`]*--type)`).test(scopeSect.replace(/\s+/g, ' ')),
  );
  if (!noTypeStage.length)
    ok('_common.md: у этапов без типа задачи показан вызов scope.mjs без --type');
  else
    bad(
      '_common.md: вызов scope.mjs для этапов без типа задачи не показан — ' +
        `${noTypeStage.join(', ')} (scope.mjs отвергает --type у этих этапов)`,
    );

  // Колонка «пишет» = stageWriteRepoKeys. Единственное расхождение с кодом
  // законно и названо в самой таблице: фаза B create-specification снимает
  // право записи вызовом `--write none`, хотя у этапа оно есть.
  const wrong = [];
  for (const c of rows) {
    const stage = rowStage(c[0]);
    if (!STAGE_NAMES.includes(stage)) continue;
    const phaseB = /фаза\s*B/i.test(c[0]);
    const declared = !/^—/.test(c[2]) && !/только артефакт/i.test(c[2]);
    const actual = stageWriteRepoKeys(stage, 'FE').length > 0 && !phaseB;
    if (declared !== actual)
      wrong.push(`${c[0]}: таблица говорит «${c[2]}», stageWriteRepoKeys — ${actual ? 'запись в репозиторий' : 'только артефакты'}`);
  }
  const writeNone = /--write\s+none/.test(scopeSect);
  if (!wrong.length && writeNone)
    ok('_common.md: право записи в колонке «пишет» совпадает с ядром, у фазы B назван --write none');
  else
    bad(
      '_common.md: права записи в таблице — ' +
        [wrong.join('; ') || null, writeNone ? null : 'не сказано, что фаза B снимает запись через --write none']
          .filter(Boolean)
          .join('; '),
    );

  // Папки, которые guard пускает на запись при активном этапе, перечислены в
  // ARTIFACT_DIRS. Правило, называющее только tasks/, отправляет intent.md в
  // отказ guard'а, а обещанный `.cache/` — в отказ гарантированно: этой папки
  // в разрешённых больше нет вовсе.
  const rules = scopeSect.replace(/\s+/g, ' ');
  const missingDirs = ARTIFACT_DIRS.filter((d) => !new RegExp(`${d}/`).test(rules));
  const cacheAllowed = /\.cache\//.test(rules);
  if (!missingDirs.length && !cacheAllowed)
    ok('_common.md: правило артефактов называет обе папки (tasks/, intents/) и не обещает .cache/');
  else
    bad(
      '_common.md: правило про папки артефактов — ' +
        [
          missingDirs.length ? `не названы: ${missingDirs.map((d) => d + '/').join(', ')}` : null,
          cacheAllowed ? '.cache/ назван разрешённым к записи, хотя guard его не пускает' : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  // Артефакты конвейера = шаблоны в core/templates. Промахнувшийся перечень
  // велит модели вставить в промпт агента шаблон по несуществующему пути, а в
  // «Быстром режиме» — вызвать валидатор с типом, который тот не знает
  // (`неизвестный тип`), и валидация артефакта просто не выполнится.
  const artifacts = fs
    .readdirSync(path.join(root, 'core/templates'))
    .filter((f) => f.endsWith('.md'))
    .sort();
  const tplRule = (commonRaw.split(/\n\n/).find((p) => /Шаблон артефакта/.test(p)) || '').replace(/\s+/g, ' ');
  const tplMiss = artifacts.filter((a) => !tplRule.includes(a));
  const tplExtra = ['feature.md', 'requirements-auto-test.md'].filter((a) => tplRule.includes(a));
  if (tplRule && !tplMiss.length && !tplExtra.length)
    ok('_common.md: «шаблон текстом» перечисляет ровно артефакты из core/templates');
  else
    bad(
      '_common.md: перечень артефактов в правиле «шаблон текстом» — ' +
        [
          tplRule ? null : 'правило не найдено',
          tplMiss.length ? `нет: ${tplMiss.join(', ')}` : null,
          tplExtra.length ? `удалённые: ${tplExtra.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  const bogus = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', 'x', '--type', '__нет__']));
  const validTypes = ((String(bogus.problems && bogus.problems[0]).match(/Допустимые:\s*(.+)$/) || [])[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fastRule = (csect('Быстрый режим').match(/--type\s*<[^>]*>/) || [''])[0];
  const typeMiss = validTypes.filter((t) => !new RegExp(`\\b${t}\\b`).test(fastRule));
  const typeExtra = ((fastRule.match(/<(.*)>/) || ['', ''])[1] || '')
    .split('|')
    .map((s) => s.trim())
    .filter((t) => t && !validTypes.includes(t));
  if (validTypes.length && !typeMiss.length && !typeExtra.length)
    ok('_common.md: типы валидатора в «Быстром режиме» совпадают с validate-artifact.mjs');
  else
    bad(
      '_common.md: типы валидатора в «Быстром режиме» — ' +
        [
          validTypes.length ? null : 'список допустимых типов не разобран из validate-artifact.mjs',
          typeMiss.length ? `не названы: ${typeMiss.join(', ')}` : null,
          typeExtra.length ? `неизвестные валидатору: ${typeExtra.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2p) _review-loop.md — единственное описание цикла ревью, и оба его конца
// сместились: производит содержимое теперь фаза A create-specification, а итог
// ревью по домену systems-analysis ложится в specification.md. Перечень,
// зовущий /create-feature, оставляет цикл без входа на реально производящем
// этапе; названный feature.md — без места для раздела «Ревью».
console.log('_review-loop.md — производящие этапы и место итога:');
{
  const rl = fs.readFileSync(path.join(root, 'core/stages/_review-loop.md'), 'utf8');
  const flat = rl.replace(/\s+/g, ' ');
  // Производящие этапы — ровно те, что ссылаются на цикл (проверено в 2b).
  const producing = ['create-specification', 'implement-plan', 'implement-auto-test'];
  const head = rl.split(/^## /m)[0].replace(/\s+/g, ' ');
  const notNamed = producing.filter((s) => !head.includes(s));
  const staleStage = /create-feature/.test(flat);
  if (!notNamed.length && !staleStage)
    ok('_review-loop.md: перечень производящих этапов — фаза A спецификации, реализация, автотесты');
  else
    bad(
      '_review-loop.md: перечень производящих этапов — ' +
        [
          notNamed.length ? `не назван: ${notNamed.join(', ')}` : null,
          staleStage ? 'остался удалённый /create-feature' : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  const outcome = (rl.split(/^## /m).find((s) => s.startsWith('Запись итога')) || '').replace(/\s+/g, ' ');
  const namesSpec = /specification\.md/.test(outcome) && !/feature\.md/.test(outcome);
  // Три списка держат итог ревью между фазами: раздел «Ревью» в specification.md
  // заполняет фаза B, которая после обрыва идёт ОТДЕЛЬНОЙ сессией и контекста
  // фазы A не видит. Схлопнутый до одного счётчика объект — потерянный итог.
  const lists = ['fixed', 'rebutted', 'unresolved'].filter((k) => !outcome.includes(k));
  if (namesSpec && !lists.length)
    ok('_review-loop.md: итог домена анализа пишется в specification.md, в meta.json — три списка');
  else
    bad(
      '_review-loop.md: запись итога — ' +
        [
          namesSpec ? null : 'артефакт итога назван не specification.md (или остался feature.md)',
          lists.length ? `в meta.json нет списков: ${lists.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('; '),
    );

  const pair = (rl.split(/^## /m).find((s) => /FE-BE пара/.test(s)) || '').replace(/\s+/g, ' ');
  if (pair && /create-specification/.test(pair) && !/feature\.md/.test(pair))
    ok('_review-loop.md: FE-BE пара описана через create-specification');
  else bad('_review-loop.md: раздел «FE-BE пара» — ' + (pair ? `остался про удалённый этап: «${pair.slice(0, 90)}…»` : 'не найден'));
}

// 2q) reviewer — субагент: перечень доменов в промпте и карточке агента это
// всё, что он знает о своём месте в конвейере. Названный удалённый этап или
// артефакт, которого никто не производит, он не может ни открыть, ни сверить:
// вместо ревью получится ревью «по памяти о конвейере 1.x».
console.log('reviewer — домены и артефакты по фактическим этапам:');
{
  const files = ['core/prompts/reviewer.md', 'adapters/claude-code/agents/reviewer.md'];
  const stale = [];
  for (const rel of files) {
    const txt = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\s+/g, ' ');
    for (const token of ['create-feature', 'feature.md', 'requirements-auto-test'])
      if (txt.includes(token)) stale.push(`${rel}: ${token}`);
  }
  const prompt = fs.readFileSync(path.join(root, 'core/prompts/reviewer.md'), 'utf8').replace(/\s+/g, ' ');
  const card = fs.readFileSync(path.join(root, 'adapters/claude-code/agents/reviewer.md'), 'utf8').replace(/\s+/g, ' ');
  const domainsNamed = ['systems-analysis', 'frontend', 'backend', 'autotests'].filter((d) => !prompt.includes(d));
  const specStage = /create-specification/.test(prompt) && /create-specification/.test(card);
  const testsSot = /autotest-plan\.md/.test(prompt);
  if (!stale.length && !domainsNamed.length && specStage && testsSot)
    ok('reviewer: домены названы через актуальные этапы, источник истины автотестов — autotest-plan.md');
  else
    bad(
      'reviewer: описание доменов — ' +
        [
          stale.length ? `удалённые имена: ${stale.join('; ')}` : null,
          domainsNamed.length ? `в промпте нет доменов: ${domainsNamed.join(', ')}` : null,
          specStage ? null : 'этап домена systems-analysis назван не create-specification (промпт и/или карточка)',
          testsSot ? null : 'source-of-truth для автотестов — не autotest-plan.md',
        ]
          .filter(Boolean)
          .join('; '),
    );
}

// 2r) «Следующий шаг» — единственная навигация по конвейеру: пользователь
// набирает то, что назвал предыдущий этап. Имя удалённого этапа здесь — тупик
// (команды нет), а имя не-соседа тихо пропускает этап. Порядок берём из
// STAGE_NAMES, чтобы проверка не разошлась с ядром.
console.log('Следующий шаг этапов — по порядку STAGE_NAMES:');
{
  const chain = STAGE_NAMES.filter((s) => s !== 'task-status');
  const wrong = [];
  const seen = new Set();
  for (let i = 0; i < chain.length - 1; i++) {
    const stage = chain[i];
    const successor = chain[i + 1];
    for (const rel of [`core/stages/${stage}.md`, `adapters/claude-code/skills/${stage}/SKILL.md`]) {
      const p = path.join(root, rel);
      if (!fs.existsSync(p)) continue;
      const txt = fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ');
      for (const m of txt.matchAll(/ледующий шаг[^.]{0,120}/g)) {
        const named = (m[0].match(/\/(?:conveyor:)?([a-z][a-z-]+)/) || [])[1];
        if (!named) continue;
        seen.add(stage);
        if (named !== successor) wrong.push(`${rel}: «${named}» вместо «${successor}»`);
      }
    }
  }
  // implement-plan — тот самый разрыв: без явного требования проверка
  // молчала бы, просто не найдя предложения про следующий шаг.
  const silent = ['implement-plan'].filter((s) => !seen.has(s));
  if (!wrong.length && !silent.length)
    ok('следующий шаг каждого этапа — его сосед по STAGE_NAMES');
  else
    bad(
      'следующий шаг этапа — ' +
        [wrong.join('; ') || null, silent.length ? `не назван вовсе у: ${silent.join(', ')}` : null]
          .filter(Boolean)
          .join('; '),
    );
}

// 2s) Сквозная зачистка: имена удалённых этапов, артефактов и полей конфигурации
// живут ещё и в шапках скриптов и в «кратко» скиллов — тех текстах, которые
// модель читает раньше стейджа. Один общий проход по репозиторию дешевле
// точечных проверок и ловит возврат старого имени в любом новом файле.
console.log('Сквозная зачистка удалённых имён:');
{
  // Файлы, где старые имена ЗАКОННЫ: миграция 1.x переименовывает старое (и
  // потому обязана его называть), а check.mjs это переименование проверяет.
  // README.md и INSTALL.md — не законны, а ещё не переписаны (Task 25); их
  // строки исключаются вместе с задачей.
  const allowed = new Set([
    'core/scripts/migrate-workspace.mjs',
    'scripts/check.mjs',
    'README.md',
    'INSTALL.md',
  ]);
  // `.cache/repos` в список не входит: каталог 1.x упоминается законно —
  // setup.md его ищет как признак старого репозитория, scope.mjs и
  // validate-config.mjs подчищают. Проверяются имена, которых больше НЕТ.
  const gone = /create-feature|create-requirements-auto-test|requirements-auto-test|missingVars|repoCache|CONVEYOR_REPO_CACHE|repoCacheEnabled/;
  const hits = [];
  // Список файлов берём из git, а не обходом каталога. Рядом с исходниками
  // .gitignore разрешает временные workspace `ws*/`, и они по назначению
  // содержат фикстуры 1.x: обход красил гейт по файлам, которых в репозитории
  // нет. `--cached --others --exclude-standard` = отслеживаемые ПЛЮС ещё не
  // добавленные в индекс, минус игнорируемые: `ws*/` остаётся за бортом, а
  // только что созданный файл проверяется сразу — до `git add`, то есть в тот
  // самый момент, когда гейт и прогоняют. Без git (распакованный архив)
  // остаётся обход, но `ws*` пропускается наравне с node_modules.
  const skipTop = ['node_modules', '.git', 'dist', 'docs'];
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  const files = [];
  if (listed.status === 0 && listed.stdout) {
    const seen = new Set();
    for (const rel of listed.stdout.split('\0')) {
      if (!rel || seen.has(rel) || skipTop.includes(rel.split('/')[0])) continue;
      seen.add(rel);
      files.push(rel);
    }
  } else {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipTop.includes(e.name) || (e.isDirectory() && /^ws/.test(e.name))) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else files.push(path.relative(root, abs).split(path.sep).join('/'));
      }
    })(root);
  }
  for (const rel of files) {
    if (!/\.(md|mjs|json)$/.test(rel) || allowed.has(rel)) continue;
    const abs = path.join(root, rel);
    // Файл может числиться в индексе, но быть удалён из рабочего дерева.
    if (!fs.existsSync(abs)) continue;
    fs.readFileSync(abs, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const m = line.match(gone);
        if (m) hits.push(`${rel}:${i + 1} (${m[0]})`);
      });
  }
  if (!hits.length) ok('удалённых имён этапов, артефактов и полей конфигурации в репозитории нет');
  else bad('остатки старых имён — ' + hits.join('; '));
}

// 2t) QWEN.md — это ВЕСЬ системный промпт GigaCode: хуков там нет, стейджи
// модель читает уже после него, и всё, что здесь написано, она исполняет
// буквально. Поэтому проверяем не стиль, а то, что тихо ломает прогон:
// пропущенную причину останова на первом шаге (правило по несуществующему
// полю не сработает НИКОГДА — этап пойдёт дальше на несуществующей рабочей
// копии), состав таблиц (этап, которого нет в таблице команд, модель не
// предложит) и каталоги записи в «Защите».
console.log('QWEN.md — протокол GigaCode:');
{
  const qwen = fs.readFileSync(path.join(root, 'adapters/gigacode/QWEN.md'), 'utf8');
  const flat = (s) => s.replace(/\s+/g, ' ');
  const section = (name) => qwen.split(/^## /m).find((s) => s.startsWith(name)) || '';
  // Первая ячейка каждой строки таблицы (без шапки и разделителя).
  const firstCells = (text) =>
    text
      .split('\n')
      .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s-]*\|/.test(l))
      .map((l) => l.split('|')[1].trim())
      .filter((c) => c && !/^Этап$|^Команда$/.test(c));
  const problems = [];

  // 1. Три причины останова resolve-config — те же, что в _common.md. Искать
  // их по ВСЕЙ секции нельзя: слова `missingLinks`, `urlLinks` и `inside` есть
  // и в перечне полей ответа, поэтому удаление самого правила останова такую
  // проверку не роняет — ровно тот fail-open, ради которого она написана.
  // Смотрим в БУЛЛЕТ реакции: от «- » до следующего буллета, обрезанный по
  // первой строке с нулевым отступом (следующий пункт протокола).
  const protoSection = section('Общий протокол');
  const proto = flat(protoSection);
  const stopRule = flat(
    protoSection
      .split(/\n(?=\s*- )/)
      .map((b) => b.split(/\n(?=\S)/)[0])
      .filter((b) => /^\s*- /.test(b) && /останови этап/.test(b) && !/found/.test(b))
      .join(' '),
  );
  if (!stopRule) problems.push('в протоколе нет правила «останови этап», когда репозиторий этапа непригоден');
  else {
    const missingReasons = [
      ['missingLinks', /missingLinks/],
      ['urlLinks', /urlLinks/],
      ['inside', /inside/],
    ]
      .filter(([, re]) => !re.test(stopRule))
      .map(([n]) => n);
    if (missingReasons.length) problems.push('в правиле останова не названы причины: ' + missingReasons.join(', '));
  }
  // Путь рабочей копии — только из конфигурации: угаданный путь уводит агента
  // писать мимо рабочего репозитория, и guard об этом не спросит.
  if (!/links\S*\.path/.test(proto)) problems.push('в протоколе не сказано, что пути рабочих копий берутся из links[<ключ>].path');

  // 2. Таблица рабочих областей — этапы конвейера, кроме setup/task-status,
  // с разбивкой create-specification на фазы (права на анализ у них разные).
  const wantAreas = STAGE_NAMES.filter((s) => s !== 'setup' && s !== 'task-status').flatMap((s) =>
    s === 'create-specification' ? ['create-specification (фаза A)', 'create-specification (фаза B)'] : [s],
  );
  const gotAreas = firstCells(section('Рабочая область'));
  if (gotAreas.join(' | ') !== wantAreas.join(' | '))
    problems.push(`таблица рабочих областей: [${gotAreas.join(', ')}] вместо [${wantAreas.join(', ')}]`);

  // 3. Таблица команд и строка «естественный язык → команда» — обе по
  // STAGE_NAMES: команда без строки в таблице для пользователя не существует.
  const cmdSection = section('Команды');
  const tableCmds = firstCells(cmdSection).map((c) => (c.match(/\/conveyor:([a-z][a-z-]*)/) || [])[1] || c);
  if (tableCmds.join(' | ') !== STAGE_NAMES.join(' | '))
    problems.push(`таблица команд: [${tableCmds.join(', ')}] вместо [${STAGE_NAMES.join(', ')}]`);
  const nlText = flat(cmdSection.split('\n').filter((l) => !l.trim().startsWith('|')).join(' '));
  const mapped = new Set([...nlText.matchAll(/→\s*([a-z][a-z-]*)/g)].map((m) => m[1]));
  const nlMissing = STAGE_NAMES.filter((s) => !mapped.has(s));
  if (nlMissing.length) problems.push('«естественный язык → команда» не покрывает: ' + nlMissing.join(', '));

  // 4. Каталоги записи в «Защите» — по checkWrite: рабочий репозиторий
  // (tasks/, intents/), рабочие копии области этапа (repos/*), системный temp.
  const guardSection = section('Защита');
  const dirsBullet = flat(guardSection.split(/\n(?=- )/).find((b) => /пиши только внутри/.test(b)) || '');
  if (!dirsBullet) problems.push('в «Защите» нет пункта о разрешённых каталогах записи');
  else {
    const missDirs = ['tasks/', 'intents/', 'repos/'].filter((d) => !dirsBullet.includes(d));
    if (missDirs.length) problems.push('каталоги записи не названы: ' + missDirs.join(', '));
  }
  // `.cache/` — каталог 1.x: в протоколе GigaCode его быть не может (признаком
  // старого репозитория он остаётся только в setup.md и migrate-workspace).
  if (/\.cache/.test(qwen)) problems.push('упомянут .cache/ (каталог 1.x)');

  if (!problems.length) ok('QWEN.md: протокол, таблицы этапов/команд и каталоги записи — по ядру');
  else bad('QWEN.md — ' + problems.join('; '));
}

// 2u) Скилл setup слабая модель читает ПЕРВЫМ и часто вместо стейджа: его
// «Кратко» — это то, что реально будет исполнено. Расхождение со стейджем
// здесь дороже прочих: этап создаёт структуру рабочего репозитория, и
// пропущенный каталог или лишний файл достаются всей команде через git.
console.log('Скилл setup — «Кратко» против стейджа:');
{
  const skill = fs.readFileSync(path.join(root, 'adapters/claude-code/skills/setup/SKILL.md'), 'utf8');
  const flat = skill.replace(/\s+/g, ' ');
  const problems = [];

  // Дальше проверяем ШАГИ «Кратко» — то, что модель реально исполняет.
  // Проверка по всему файлу удовлетворялась бы описанием во frontmatter
  // (оно перечисляет и структуру, и .gitignore): каталог мог бы пропасть из
  // шага, а гейт остался бы зелёным.
  const steps = flat.split(/(?=\d+\. )/).filter((s) => /^\d+\. /.test(s));

  // Структура — ровно та, что создаёт стейдж (ARTIFACT_DIRS + repos/), и
  // названа она должна быть в шаге СОЗДАНИЯ (он же копирует шаблоны
  // конфигурации): `repos/` встречается и в шаге про .gitignore, а каталог
  // нужно завести, а не только спрятать от git.
  const mkStep = steps.find((s) => s.includes('.env.example')) || '';
  if (!mkStep) problems.push('нет шага создания структуры (копирования шаблонов конфигурации)');
  else
    for (const d of ['tasks/FE', 'tasks/BE', 'intents/', 'repos/'])
      if (!mkStep.includes(d)) problems.push('шаг создания структуры не называет: ' + d);

  // .gitignore: repos/ и .env. `.cache/` — строка 1.x, в новом репозитории
  // она прячет не тот каталог и оставляет чужие рабочие деревья в git status.
  // Ищем именно ШАГ (описание в frontmatter .gitignore тоже упоминает).
  const giStep = steps.find((s) => s.includes('.gitignore')) || '';
  if (!giStep) problems.push('нет шага про .gitignore');
  else {
    if (!/`repos\/`/.test(giStep) || !/`\.env`/.test(giStep)) problems.push('в .gitignore не названы строки repos/ и .env');
    if (/\.cache/.test(giStep)) problems.push('в .gitignore предписан .cache/');
  }

  // .env не обязателен, и стейдж прямо запрещает его создавать.
  if (!/\.env не создавай/.test(flat)) problems.push('не сказано, что .env создавать не нужно');
  if (/заполнить[^.]{0,40}\.env/.test(flat)) problems.push('в выводе обещано «что осталось заполнить в .env»');

  // Диагностика — repos-status.mjs (git-ops locate ищет ОДНУ ссылку и молчит
  // про состояние рабочей копии).
  if (!flat.includes('repos-status.mjs')) problems.push('диагностика не через repos-status.mjs');
  if (/git-ops\S*\s+locate/.test(flat)) problems.push('диагностика через git-ops locate');

  if (!problems.length) ok('skill setup: структура, .gitignore, .env и диагностика — по core/stages/setup.md');
  else bad('skill setup — ' + problems.join('; '));
}

// 2v) У команды GigaCode тело безопасное (отсылает к стейджу), но description
// читается ПЕРВЫМ — при выборе команды и при разборе «настрой конвейер». Если
// он обещает структуру 1.x или «проверку ссылок» вместо диагностики рабочих
// копий, пользователь получает не тот этап ещё до чтения стейджа.
console.log('Команда GigaCode setup — описание:');
{
  const cmd = fs.readFileSync(path.join(root, 'adapters/gigacode/commands/conveyor/setup.md'), 'utf8');
  const desc = ((cmd.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '').replace(/\s+/g, ' ');
  const problems = [];
  if (!/description:/.test(desc)) problems.push('нет frontmatter description');
  else {
    for (const d of ['tasks/FE', 'tasks/BE', 'intents/', 'repos/'])
      if (!desc.includes(d)) problems.push('описание не называет часть структуры: ' + d);
    // Вторая (и более частая) роль этапа — диагностика рабочих копий через
    // repos-status; «проверяет ссылки» — формулировка 1.x, когда копий в
    // рабочем репозитории не было.
    // \w в JS — только ASCII, кириллицу им не добрать: класс задаём явно.
    if (!/рабоч[а-яё]* копи/i.test(desc)) problems.push('описание не обещает диагностику рабочих копий');
  }
  if (!problems.length) ok('gigacode setup: описание команды — структура и диагностика по core/stages/setup.md');
  else bad('gigacode setup — ' + problems.join('; '));
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

  // То же для QWEN.md: это ВЕСЬ системный промпт GigaCode, и перечисленные в
  // нём поля `links.<ключ>` модель считает существующими. Поле, которого
  // resolve-config не отдаёт, — обещание пустоты: правило, написанное по нему,
  // не сработает никогда. Сверяем перечень с ключами реального ответа.
  {
    const qwenMd = fs.readFileSync(path.join(root, 'adapters/gigacode/QWEN.md'), 'utf8');
    const listed = (qwenMd.replace(/\s+/g, ' ').match(/`links\.<ключ>`\s*=\s*`?\{([^}]*)\}/) || [])[1];
    const fields = (listed || '').split(',').map((s) => s.replace(/[`\s]/g, '')).filter(Boolean);
    const real = Object.keys(rc.links.systemsAnalysis);
    const ghosts = fields.filter((f) => !real.includes(f));
    const forgotten = real.filter((f) => !fields.includes(f));
    if (fields.length && !ghosts.length && !forgotten.length)
      ok('QWEN.md: поля links.<ключ> — те, что resolve-config действительно отдаёт');
    else
      bad(
        'QWEN.md: перечень полей links.<ключ> разошёлся со скриптом — ' +
          (listed === undefined
            ? 'перечень не найден'
            : `нет в ответе: ${ghosts.join(', ') || '(нет)'}; не названы: ${forgotten.join(', ') || '(нет)'}`),
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

  // settings.json 1.x правили руками, и repos.<ключ> в нём бывает примитивом
  // (`"systemsAnalysis": "repos/system-analysis"`) — ровно ту форму разбирает
  // предупреждением migrate-workspace. Ядро на ней падало TypeError ещё до
  // возврата: у repos-status stdout оставался ПУСТ (контракт «всегда JSON
  // {ok:false,error}» не работал), а SessionStart-хук глотал ошибку и молчал.
  const tmpPrim = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-prim-'));
  try {
    fs.writeFileSync(
      path.join(tmpPrim, 'settings.json'),
      JSON.stringify({
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: 'repos/system-analysis',
          frontend: 42,
          backend: { link: 'repos/backend', mainBranch: 'main' },
          autoTest: { link: '', mainBranch: 'main' },
        },
      }),
    );
    const rcPrim = runScriptFull('core/scripts/resolve-config.mjs', [tmpPrim]);
    let rcPrimJson = null;
    try {
      rcPrimJson = JSON.parse(rcPrim.stdout);
    } catch {
      rcPrimJson = null;
    }
    if (
      rcPrim.status === 0 &&
      rcPrimJson &&
      rcPrimJson.found === true &&
      (rcPrimJson.missingLinks || []).includes('systemsAnalysis') &&
      (rcPrimJson.missingLinks || []).includes('frontend') &&
      !(rcPrimJson.missingLinks || []).includes('backend')
    )
      ok('readConfig: repos.<ключ> примитивом не роняет чтение — ключ в missingLinks');
    else
      bad(
        'readConfig: repos.<ключ> примитивом ломает чтение: ' +
          JSON.stringify({
            status: rcPrim.status,
            stderr: rcPrim.stderr.split('\n')[0],
            error: rcPrimJson && rcPrimJson.error,
            missingLinks: rcPrimJson && rcPrimJson.missingLinks,
          }),
      );
    const rsPrim = runScriptFull('core/scripts/repos-status.mjs', [tmpPrim]);
    let rsPrimJson = null;
    try {
      rsPrimJson = JSON.parse(rsPrim.stdout);
    } catch {
      rsPrimJson = null;
    }
    const rsPrimSA = rsPrimJson && (rsPrimJson.repos || []).find((r) => r.key === 'systemsAnalysis');
    if (rsPrimJson && rsPrimSA && rsPrimSA.state === 'link-empty')
      ok('repos-status: repos.<ключ> примитивом — JSON с состоянием, а не стек Node');
    else bad('repos-status: на примитиве нет JSON: ' + JSON.stringify({ status: rsPrim.status, stdout: rsPrim.stdout.slice(0, 200) }));
    const vcPrim = runScriptFull('core/scripts/validate-config.mjs', [], JSON.stringify({ cwd: tmpPrim }));
    let vcPrimCtx = '';
    try {
      vcPrimCtx = JSON.parse(vcPrim.stdout).hookSpecificOutput.additionalContext || '';
    } catch {
      vcPrimCtx = '';
    }
    if (vcPrim.status === 0 && vcPrimCtx.includes('systemsAnalysis') && vcPrimCtx.includes('frontend'))
      ok('validate-config: repos.<ключ> примитивом — ключи названы, хук не молчит');
    else bad('validate-config: на примитиве хук молчит: ' + JSON.stringify({ status: vcPrim.status, ctx: vcPrimCtx }));
  } finally {
    fs.rmSync(tmpPrim, { recursive: true, force: true });
  }

  // Свежий рабочий репозиторий: settings.json взят ИЗ ШАБЛОНА (ссылки заполнены
  // дефолтами repos/*), но ничего ещё не склонировано. Пустых ссылок нет,
  // git-URL нет, inside=true — и по трём «ссылочным» критериям хук молчит,
  // хотя ни один этап работать не может. Первый внятный сигнал человек ловил
  // только глубоко внутри этапа, ошибкой git-ops locate. Фикстура — копия
  // шаблона: разъедься дефолты с REPO_DIRS, проверка поедет вместе с ними.
  const tmpFresh = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-fresh-'));
  try {
    fs.copyFileSync(path.join(root, 'core/templates/settings.example.json'), path.join(tmpFresh, 'settings.json'));
    const vcFresh = vcCtxOf(JSON.stringify({ cwd: tmpFresh }));
    const namesAll = REPO_KEYS.filter((k) => vcFresh.includes(k));
    if (namesAll.length === REPO_KEYS.length)
      ok('validate-config: в свежем workspace названы все несклонированные рабочие копии');
    else
      bad(
        'validate-config: несклонированные копии не названы (названы: ' +
          `${namesAll.join(', ') || 'никто'}): ` +
          JSON.stringify(vcFresh),
      );
    // Ради самой ценной части сообщения: какие этапы из-за этого не поедут.
    if (
      /Заблокированы этапы/.test(vcFresh) &&
      ['create-specification', 'implement-plan', 'implement-auto-test'].every((s) => vcFresh.includes(s))
    )
      ok('validate-config: несклонированные копии названы вместе с заблокированными этапами');
    else bad('validate-config: этапы при несклонированных копиях не названы: ' + JSON.stringify(vcFresh));

    // Каталог есть, но это не репозиторий — состояние отдельное, и лечится
    // иначе (git не клонирует в непустой каталог). Не свести его с «копии нет».
    fs.mkdirSync(path.join(tmpFresh, 'repos', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(tmpFresh, 'repos', 'backend', 'note.txt'), 'чужой каталог\n');
    const vcNotRepo = vcCtxOf(JSON.stringify({ cwd: tmpFresh }));
    if (/не git-репозитор/i.test(vcNotRepo) && /backend/.test(vcNotRepo))
      ok('validate-config: каталог без .git назван отдельно от «копии нет»');
    else bad('validate-config: not-a-repo не отличён: ' + JSON.stringify(vcNotRepo));

    // Настоящая рабочая копия молчания заслуживает: предупреждение, которое
    // не гаснет после устранения причины, читают как шум и перестают замечать.
    for (const key of REPO_KEYS) {
      const dir = path.join(tmpFresh, REPO_DIRS[key]);
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    }
    const vcCloned = vcCtxOf(JSON.stringify({ cwd: tmpFresh }));
    if (!/⚠ conveyor/.test(vcCloned)) ok('validate-config: при готовых рабочих копиях предупреждений нет');
    else bad('validate-config: предупреждение не гаснет после клонирования: ' + JSON.stringify(vcCloned));
  } finally {
    fs.rmSync(tmpFresh, { recursive: true, force: true });
  }

  // Fail-open — свойство хука, а не деталь: SessionStart с ненулевым кодом или
  // мусором в stdout ломает старт сессии. Проверяем на неразбираемом
  // settings.json (внутренняя ошибка) и на каталоге без него.
  const tmpFail = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-failopen-'));
  try {
    fs.writeFileSync(path.join(tmpFail, 'settings.json'), '{ это не JSON');
    const broken = runScriptFull('core/scripts/validate-config.mjs', [], JSON.stringify({ cwd: tmpFail }));
    const parses = (s) => {
      if (!s.trim()) return true;
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    };
    if (broken.status === 0 && parses(broken.stdout))
      ok('validate-config: неразбираемый settings.json — код 0 и валидный stdout (fail-open)');
    else bad('validate-config: сломанный settings.json роняет хук: ' + JSON.stringify(broken));
    const noSettings = runScriptFull(
      'core/scripts/validate-config.mjs',
      [],
      JSON.stringify({ cwd: path.parse(tmpFail).root }),
    );
    if (noSettings.status === 0 && noSettings.stdout.trim() === '')
      ok('validate-config: вне рабочего репозитория — тишина и код 0');
    else bad('validate-config: вне workspace хук не молчит: ' + JSON.stringify(noSettings));
  } finally {
    fs.rmSync(tmpFail, { recursive: true, force: true });
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

  // repos-status: состояние рабочих копий. Плагин НЕ клонирует, поэтому скрипт —
  // единственный источник «что настроено» для /setup и validate-config, и
  // разница между «ссылки нет», «путь не туда» и «каталог есть, но это не
  // репозиторий» решает, что пользователю делать руками.
  const rs = JSON.parse(runScript('core/scripts/repos-status.mjs', [tmp]));
  const byKey = Object.fromEntries((rs.repos || []).map((r) => [r.key, r]));
  if (byKey.systemsAnalysis && byKey.systemsAnalysis.state === 'ok') ok('repos-status: существующая копия → ok');
  else bad('repos-status: systemsAnalysis: ' + JSON.stringify(byKey.systemsAnalysis));
  if (byKey.frontend && byKey.frontend.state === 'link-empty') ok('repos-status: пустая ссылка → link-empty');
  else bad('repos-status: frontend: ' + JSON.stringify(byKey.frontend));
  if (rs.summary && rs.summary.ok === 2 && rs.summary.problems === 2) ok('repos-status: сводка посчитана');
  else bad('repos-status: сводка: ' + JSON.stringify(rs.summary));

  // Остальные четыре состояния — на отдельном мини-workspace: у основной
  // фикстуры четыре ключа, а состояний шесть. Ключевой случай — `outside` при
  // НЕсуществующем каталоге: проверка границы проекта, отложенная до проверок
  // существования, даёт `missing` и подсказку «склонируйте сюда» на путь, куда
  // клонировать нельзя вовсе (guard-writes такую копию не примет).
  // hint проверяем отдельно: /setup и validate-config показывают его КАК ЕСТЬ.
  const tmpStatus = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-status-'));
  try {
    // Как и в проверках ссылок выше, «наружу» уводим ВЫШЕ системного temp:
    // сосед во временном каталоге сам по себе лежит в разрешённом корне.
    const outsideRepo = path.join(path.parse(tmpStatus).root, 'conveyor-outside-frontend');
    const outsideValue = path.relative(tmpStatus, outsideRepo).split(path.sep).join('/');
    fs.mkdirSync(path.join(tmpStatus, 'repos', 'autotests'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpStatus, 'settings.json'),
      JSON.stringify({
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: { link: 'git@git.example.com:group/system-analysis.git', mainBranch: 'main' },
          frontend: { link: outsideValue, mainBranch: 'main' },
          backend: { link: 'repos/backend', mainBranch: 'main' },
          autoTest: { link: 'repos/autotests', mainBranch: 'main' },
        },
      }),
    );
    const rs2 = JSON.parse(runScript('core/scripts/repos-status.mjs', [tmpStatus]));
    const st = Object.fromEntries((rs2.repos || []).map((r) => [r.key, r]));
    const want = {
      systemsAnalysis: 'link-is-url',
      frontend: 'outside',
      backend: 'missing',
      autoTest: 'not-a-repo',
    };
    const stateDiff = Object.keys(want).filter((k) => !st[k] || st[k].state !== want[k]);
    if (!stateDiff.length) ok('repos-status: состояния link-is-url / outside / missing / not-a-repo различаются');
    else
      bad(
        'repos-status: состояния разошлись: ' +
          stateDiff.map((k) => `${k}→${st[k] ? st[k].state : '(нет)'} (ждали ${want[k]})`).join(', '),
      );
    const noHint = Object.keys(want).filter((k) => !(st[k] && typeof st[k].hint === 'string' && st[k].hint.trim()));
    if (!noHint.length) ok('repos-status: у каждой проблемы есть готовая к показу подсказка');
    else bad('repos-status: подсказки нет у: ' + noHint.join(', '));
    // not-a-repo — каталог СУЩЕСТВУЕТ и не пуст, а `git clone` в непустой
    // каталог не выполняется вовсе. Подсказка «склонируйте сюда» без слова о
    // том, что делать с каталогом, отправляет человека на ошибку git.
    const naHint = String((st['autoTest'] || {}).hint || '');
    if (/очист/i.test(naHint) && /переимен/i.test(naHint))
      ok('repos-status: подсказка not-a-repo говорит очистить или переименовать каталог');
    else bad('repos-status: подсказка not-a-repo не решает непустой каталог: ' + JSON.stringify(naHint));
    if (rs2.summary && rs2.summary.ok === 0 && rs2.summary.problems === 4)
      ok('repos-status: сводка при четырёх непригодных ссылках');
    else bad('repos-status: сводка мини-workspace: ' + JSON.stringify(rs2.summary));
  } finally {
    fs.rmSync(tmpStatus, { recursive: true, force: true });
  }

  // git-ops update: рабочая копия принадлежит разработчику, и его ветку этап
  // не переключает НИ ПРИ КАКИХ условиях. Фикстура — настоящий git-репозиторий:
  // проверяется наблюдаемое состояние (на какой ветке осталась копия), а не
  // текст скрипта. Legacy-флаг `--kind cache` включал здесь checkout main —
  // передаём его специально: устаревший вызов из стейджа не должен воскресить
  // переключение.
  // Копия лежит ВНУТРИ временного workspace: тот же живой репозиторий —
  // единственная фикстура, на которой repos-status может ЗАПОЛНИТЬ branch и
  // clean. У поддельных каталогов `.git` (обе «ok»-фикстуры выше) git падает,
  // и оба поля там всегда null — то есть не проверяются ничем.
  const liveWs = fs.mkdtempSync(path.join(os.tmpdir(), 'conveyor-live-'));
  const liveRepo = path.join(liveWs, 'repos', 'backend');
  try {
    fs.mkdirSync(liveRepo, { recursive: true });
    fs.writeFileSync(
      path.join(liveWs, 'settings.json'),
      JSON.stringify({
        taskPrefix: 'TASK',
        repos: {
          systemsAnalysis: { link: '', mainBranch: 'main' },
          frontend: { link: '', mainBranch: 'main' },
          backend: { link: 'repos/backend', mainBranch: 'main' },
          autoTest: { link: '', mainBranch: 'main' },
        },
      }),
    );
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

      // /setup печатает branch и clean в таблице «что настроено»: пустые поля
      // на исправной копии человек читает как «git недоступен».
      const liveStatus = () =>
        ((JSON.parse(runScript('core/scripts/repos-status.mjs', [liveWs])).repos || []).find((r) => r.key === 'backend')) || {};
      const liveClean = liveStatus();
      if (liveClean.state === 'ok' && liveClean.branch === 'TASK-1-feature' && liveClean.clean === true)
        ok('repos-status: на живой копии branch — текущая ветка, clean=true у чистого дерева');
      else bad('repos-status: branch/clean на живой копии: ' + JSON.stringify(liveClean));

      // Второй замер обязателен: без него clean=true неотличим от константы.
      fs.writeFileSync(path.join(liveRepo, 'dirty.txt'), 'не закоммичено\n');
      const liveDirty = liveStatus();
      if (liveDirty.state === 'ok' && liveDirty.branch === 'TASK-1-feature' && liveDirty.clean === false)
        ok('repos-status: незакоммиченная правка → clean=false (ветка та же)');
      else bad('repos-status: грязное дерево не отличено от чистого: ' + JSON.stringify(liveDirty));
    }
  } finally {
    fs.rmSync(liveWs, { recursive: true, force: true, maxRetries: 3 });
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

  // Папка задачи появляется при записи meta.json: сам каталог — не *.md и не
  // meta.json, поэтому mkdir по нему guard запрещает (обе формы, с -p и без),
  // а подсказка отказа говорит про исходники и уводит в сторону. Это опора
  // текста create-specification: он заводит до ДВУХ таких папок и предписывает
  // Write, а не mkdir.
  const mkdirTask = ['mkdir tasks/FE', 'mkdir -p tasks/FE/TASK-12'].map((c) => decisionOf(runBash(c)));
  if (mkdirTask.every((d) => d === 'deny') && writeTo(path.join(tmp, 'tasks/FE/TASK-12/meta.json')) === '')
    ok('guard-bash: mkdir папки задачи запрещён, запись meta.json разрешена');
  else bad('guard-bash: mkdir папки задачи: ' + mkdirTask.join(', '));

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
  // Каждый шаблон обязан проходить валидацию СВОЕГО типа: шаблон — эталон
  // артефакта, и если он не проходит сам, этап раздаёт агенту заведомо
  // невалидный каркас. Плейсхолдеры при этом остаются предупреждением.
  const tplChecked = {};
  for (const type of ['plan', 'intent', 'specification', 'autotest-plan']) {
    const tplPath = path.join(tmp, `tpl-${type}.md`);
    fs.copyFileSync(path.join(root, `core/templates/${type}.md`), tplPath);
    const vaTpl = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', tplPath, '--type', type]));
    tplChecked[type] = vaTpl;
    if (vaTpl.ok === true && vaTpl.placeholders.length)
      ok(`validate-artifact: шаблон ${type} проходит валидацию, плейсхолдеры — предупреждение`);
    else bad(`validate-artifact: шаблон ${type} не прошёл: ` + JSON.stringify(vaTpl));
  }

  // КАЖДЫЙ плейсхолдер шаблона обязан быть виден детектору: подсказка, которую
  // детектор не матчит (нет буквы после «<» или длиннее лимита), уезжает в
  // артефакт молча. Для intent, спецификации и плана автотестов это единственный
  // сигнал: у intent нет цикла ревью, у спецификации он ревьюет правки анализа,
  // а не текст требований, а на create-autotest-plan ревью не запускается вовсе.
  // Собираем токены шаблона наивно — всё в угловых скобках, кроме
  // html-комментариев, — и требуем, чтобы каждый попал в placeholders.
  for (const type of ['intent', 'specification', 'autotest-plan']) {
    const tplText = fs.readFileSync(path.join(root, `core/templates/${type}.md`), 'utf8');
    const tokens = [...new Set((tplText.match(/<[^<>\n]+>/g) || []).filter((t) => !t.startsWith('<!')))];
    const unseen = tokens.filter((t) => !tplChecked[type].placeholders.includes(t));
    if (tokens.length && !unseen.length)
      ok(`validate-artifact: все ${tokens.length} плейсхолдеров шаблона ${type} видны детектору`);
    else bad(`validate-artifact: детектор не видит плейсхолдеры шаблона ${type}: ` + JSON.stringify(unseen));
  }

  // Видимости заглушек мало — заглушка нужна в КАЖДОЙ обязательной секции.
  // Секция, у которой в каркасе только html-комментарий, пропускается молча:
  // заголовок на месте → ok:true, missingSections и placeholders пусты, и ни
  // одного сигнала «сюда не написали». Список обязательных секций спрашиваем у
  // самого валидатора (пустой файл называет все), чтобы не разъехаться с
  // REQUIRED. Заглушкой считаем только ту, что валидатор ПОКАЖЕТ в placeholders.
  const emptyArtPath = path.join(tmp, 'empty-artifact.md');
  fs.writeFileSync(emptyArtPath, '# Пусто\n');
  // Тело секции БЕЗ html-комментариев: они инструкция агенту, а не место для
  // заполнения, и заглушкой не считаются (так же смотрит validate-artifact).
  // Иначе секцию с одним комментарием и без единого поля инвариант пропустит.
  const sectionBody = (text, heading) => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith(heading));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    return lines
      .slice(start + 1, end)
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '');
  };
  for (const type of ['intent', 'specification', 'autotest-plan']) {
    const tplText = fs.readFileSync(path.join(root, `core/templates/${type}.md`), 'utf8');
    const required = JSON.parse(
      runScript('core/scripts/validate-artifact.mjs', ['--file', emptyArtPath, '--type', type]),
    ).missingSections;
    const bare = required.filter((h) => {
      const body = sectionBody(tplText, h);
      return !tplChecked[type].placeholders.some((p) => body.includes(p));
    });
    if (required.length && !bare.length)
      ok(`validate-artifact: каждая из ${required.length} обязательных секций шаблона ${type} несёт заглушку`);
    else bad(`validate-artifact: секции шаблона ${type} без заглушки: ` + JSON.stringify(bare));
  }

  const intentPath = path.join(tmp, 'intent-test.md');
  const intentSections = [
    '## Проблема и контекст',
    '## Бизнес-ценность',
    '## Границы',
    '## Критерии приёмки',
    '## Источники в анализе',
    '## Открытые вопросы',
  ];

  // Каркас из правильных заголовков с пустыми телами — не заполненный intent:
  // структурное правило требует хотя бы один критерий приёмки чекбоксом.
  fs.writeFileSync(intentPath, intentSections.map((h) => h + '\n').join('\n'));
  const vaIntentSkel = JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'intent']));
  if (vaIntentSkel.ok === false && !vaIntentSkel.missingSections.length && vaIntentSkel.problems.length)
    ok('validate-artifact: intent из одних заголовков не проходит (нет критериев приёмки)');
  else bad('validate-artifact: каркас intent прошёл валидацию: ' + JSON.stringify(vaIntentSkel));

  // Обратная сторона: пустой файл обязан назвать ВСЕ обязательные разделы —
  // иначе выпадение любого из них из REQUIRED.intent не поймается.
  fs.writeFileSync(intentPath, '# Пусто\n');
  const vaIntentBad = runScriptFull('core/scripts/validate-artifact.mjs', ['--file', intentPath, '--type', 'intent']);
  const vaIntentBadOut = JSON.parse(vaIntentBad.stdout);
  if (
    vaIntentBadOut.ok === false &&
    vaIntentBad.status === 1 &&
    JSON.stringify(vaIntentBadOut.missingSections) === JSON.stringify(intentSections)
  )
    ok('validate-artifact: пустой intent называет все обязательные разделы (код возврата 1)');
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
