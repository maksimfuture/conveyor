#!/usr/bin/env node
// validate-artifact.mjs — программная проверка артефактов по шаблонам
// (core/templates/*). Снимает с модели «самопроверку» — особенно важно в
// быстром режиме (CONVEYOR_FAST), но применима всегда.
//
// Usage:
//   node validate-artifact.mjs --file <путь> --type <тип>
//     тип: intent | specification | plan | autotest-plan | report-auto-test
//   node validate-artifact.mjs --file <отчёт> --type report-auto-test --plan <autotest-plan.md>
//     — дополнительно сверяет состав автотестов отчёта с планом
//   node validate-artifact.mjs --file <plan.md> --type plan --workspace <корень> [--taskType FE|BE]
//     — сверяет репозитории плана с settings.json, а с --taskType ещё и с
//       кодовой базой задачи этого типа
//
// Output (stdout, JSON):
//   { ok, missingSections: [...], problems: [...], placeholders: [...] }
//   + planMismatch: { missing: [...], extra: [...] } — только при --plan
//   + planRepos: { repos, unknown, foreign, mismatch } — только для типа plan
//   + ciPending: <bool> — только для report-auto-test: разделы заполнены, но
//     прогона в CI ещё не было (законное промежуточное состояние, ok:true)
// ok=false, если отсутствуют обязательные разделы или не выполнены
// структурные требования (REQ-ID/TC-ID/AT-ID). Остатки плейсхолдеров шаблона
// (<...>) — предупреждение в placeholders, ok не роняют.

import fs from 'node:fs';
import { parsePlanRepos } from './lib/plan-repos.mjs';
import { readConfig, unitIds, codebaseUnits } from './lib/config.mjs';

// Значение флага — только токен, который сам не является флагом. Иначе
// `--workspace --plan x` отдаёт workspace = "--plan": readConfig пойдёт от
// такого «пути» вверх, найдёт ЧУЖОЙ settings.json и сверит план с посторонней
// конфигурацией, ничего не сказав. Флаг без значения остаётся `true` — вызовы
// ниже отличают его от строки и называют ошибкой.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

// Маркер промежуточного состояния отчёта по автотестам: разделы заполнены
// после ревью, а сборки ещё не было. Одна константа на весь файл: по ней и
// раздел «Прогон в CI» признаётся заполненным, и этап отличает промежуточный
// отчёт от финального (ciPending в выводе).
const CI_PENDING = /ожидается прогон в CI/i;

const REQUIRED = {
  intent: [
    '## Проблема и контекст',
    '## Бизнес-ценность',
    '## Границы',
    '## Критерии приёмки',
    '## Источники в анализе',
    '## Открытые вопросы',
  ],
  specification: [
    '## Цель',
    '## Границы задачи',
    '## Пользовательские сценарии',
    '## Функциональные требования',
    '## Контракты',
    '## Граничные случаи',
    '## Нефункциональные требования',
    '## Критерии приёмки',
    '## Внесённые изменения анализа',
    '## Открытые вопросы',
    // Итог ревью фазы A попадает в спецификацию уже в фазе B, а при
    // продолжении задачи фаза B идёт отдельным прогоном — раздел обязателен,
    // иначе каркас уедет незаполненным и никто этого не заметит.
    '## Ревью',
  ],
  plan: [
    '## Краткое резюме',
    // Где будут правки — часть плана, а не деталь реализации: по этому
    // разделу /implement-plan ставит область записи.
    '## Затронутые репозитории',
    '## Анализ текущего кода',
    '## Шаги реализации',
    '## Изменения контрактов',
    '## Риски',
    '## Стратегия тестирования',
    '## Что вне скоупа',
    '## Отклонения и остатки',
    '## Ревью',
  ],
  'autotest-plan': [
    // Порядок — как в шаблоне: сначала «Итого» и затронутые уровни (первое,
    // что ищет читатель-тестировщик), и только потом обоснования и детали.
    '## Итого',
    '## Уровни тестирования',
    '## Объект тестирования',
    '## Что переиспользуем',
    '## Шаги реализации тестов',
    '## Тест-кейсы',
    // Автотесты — отдельный от тест-кейсов раздел: кейс описывает проверку
    // текстом (ручной прогон), автотест — то, что будет написано кодом.
    '## Автотесты',
    '## Тестовые данные',
    '## Что не автоматизируем',
  ],
  'report-auto-test': [
    '## Итог прогона',
    '## Реализованные автотесты',
    // Прогон в CI — часть результата этапа: без него по отчёту не сказать,
    // гонялись ли тесты где-то кроме машины разработчика.
    '## Прогон в CI',
    '## Ревью',
    '## Ветка',
  ],
};

// Тело раздела: от заголовка до следующего «## ». Нужно там, где требование
// адресовано КОНКРЕТНОМУ разделу: «где-то в файле есть TC-N» — не то же самое,
// что «шаги связаны с кейсами».
//
// html-комментарии шаблона вырезаем: это инструкция агенту, а не содержимое
// артефакта, и удалять её из готового файла нигде не предписано. Иначе
// проверка засчитывала бы СВОЮ ЖЕ подсказку за ответ — раздел с одним
// комментарием шаблона проходил бы как заполненный.
function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/<!--[\s\S]*?-->/g, '');
}

// Тело подраздела «### ...» внутри уже вырезанного тела раздела: у автотестов
// требования к новому функционалу и к регрессу разные, и проверять их надо
// порознь.
function subSectionBody(body, heading) {
  const start = body.indexOf(heading);
  if (start === -1) return '';
  const rest = body.slice(start + heading.length);
  const end = rest.search(/\n### /);
  return end === -1 ? rest : rest.slice(0, end);
}

// Список ID вида AT-1 в порядке появления, без повторов.
function ids(text, prefix) {
  const re = new RegExp(`${prefix}-\\d+`, 'g');
  return [...new Set(text.match(re) || [])];
}

// Структурные требования сверх разделов.
const STRUCTURAL = {
  intent: [
    {
      test: (t) => /- \[[ xX]\]/.test(t),
      problem: 'нет ни одного критерия-чекбокса в «Критериях приёмки»',
    },
  ],
  specification: [
    {
      test: (t) => /REQ-\d+/.test(t),
      problem: 'нет ни одного требования с ID (REQ-N) в «Функциональных требованиях»',
    },
  ],
  plan: [
    {
      test: (t) => /- \[[ xX]\]/.test(t),
      problem: 'нет ни одного шага-чекбокса в «Шагах реализации»',
    },
    {
      test: (t) => /REQ-\d+/.test(t),
      problem: 'шаги не ссылаются на REQ-ID из спецификации',
    },
  ],
  'autotest-plan': [
    { test: (t) => /TC-\d+/.test(t), problem: 'нет ни одного тест-кейса с ID (TC-N)' },
    { test: (t) => /REQ-\d+/.test(t), problem: 'кейсы не трассированы на REQ-ID' },
    {
      test: (t) => /- \[[ xX]\]/.test(t),
      problem: 'нет ни одного шага-чекбокса в «Шагах реализации тестов»',
    },
    // «Итого» и «Шаги» — производные разделы: они пересказывают кейсы. Строка
    // без TC-ID означает, что работа взялась ниоткуда и при правке кейсов
    // разъедется с ними молча. Раздела нет — про это уже сказал missingSections.
    {
      test: (t) => {
        const body = sectionBody(t, '## Шаги реализации тестов');
        return !body || /TC-\d+/.test(body);
      },
      problem: 'шаги реализации не связаны с кейсами (в разделе нет ни одного TC-ID)',
    },
    // Кейсы на «ручные» и «автоматизированные» не делятся: таблица одна, а
    // покрытие — колонка «Автотест». Пустая клетка в ней означает «неизвестно,
    // будет ли тест», и это единственное место, где такой пробел видно: ни
    // «Автотесты», ни «Что не автоматизируем» про несуществующую строку не
    // скажут. Поэтому проверяем и заголовок колонки, и КАЖДУЮ строку кейса.
    {
      test: (t) => {
        const body = sectionBody(t, '## Тест-кейсы');
        return !body || /\|\s*Автотест\s*\|/.test(body);
      },
      problem: 'в таблице «Тест-кейсы» нет колонки «Автотест» (какой AT-N закрывает кейс либо «нет»)',
    },
    {
      test: (t) => {
        const rows = sectionBody(t, '## Тест-кейсы')
          .split('\n')
          .filter((l) => /^\|\s*TC-\d+/.test(l));
        return rows.every((l) => /AT-\d+|\|\s*нет\s*\|/.test(l));
      },
      problem: 'у кейса не заполнена колонка «Автотест»: нужен AT-N либо «нет»',
    },
    // Кейс без автотеста проходят руками, и единственное место, где написано
    // КАК, — его детальный блок. «Что не автоматизируем» держит причину, а не
    // шаги; строки таблицы для прогона мало. Кейс, закрытый существующим
    // тестом, здесь не требуется: его описание — в самом тесте.
    {
      test: (t) => {
        const manual = sectionBody(t, '## Тест-кейсы')
          .split('\n')
          .filter((l) => /^\|\s*TC-\d+/.test(l) && !/AT-\d+/.test(l))
          .map((l) => l.match(/TC-\d+/)[0]);
        return manual.every((id) => new RegExp(`###\\s*${id}\\b`).test(t));
      },
      problem: 'кейс с «нет» в колонке «Автотест» не описан блоком «### TC-N» — по чему его проходить руками',
    },
    // Автотесты — то, что реально будет написано кодом, и именно их количество
    // сверяется с отчётом о прогоне. Раздел без AT-ID означает, что автотесты
    // не выделены из ручных кейсов и сверять в отчёте будет нечего.
    {
      test: (t) => {
        const body = sectionBody(t, '## Автотесты');
        return !body || /AT-\d+/.test(body);
      },
      problem: 'нет ни одного автотеста с ID (AT-N) в разделе «Автотесты»',
    },
    {
      test: (t) => {
        const body = sectionBody(t, '## Автотесты');
        return !body || (body.includes('### Новый функционал') && body.includes('### Регресс'));
      },
      problem: 'в «Автотестах» нет разбиения на «### Новый функционал» и «### Регресс»',
    },
    // Новый функционал читают по уровням тестирования: без группировки список
    // автотестов сливается в одну кучу, и уровень каждого приходится угадывать.
    {
      test: (t) => {
        const nf = subSectionBody(sectionBody(t, '## Автотесты'), '### Новый функционал');
        return !nf || /####\s*Уровень/.test(nf);
      },
      problem: 'автотесты нового функционала не сгруппированы по уровням («#### Уровень: ...»)',
    },
    // Регресс выбирают, а не берут целиком: без уровня и обоснования список
    // нечем проверить на осмысленность, а цикла ревью на этом этапе нет.
    {
      test: (t) => {
        const rg = subSectionBody(sectionBody(t, '## Автотесты'), '### Регресс');
        // Пункты шаблона, а не просто слова в тексте: «почему» встречается и в
        // подсказке про уровень, и обоснование выбора тестов уезжало бы молча.
        return !rg || (/^\s*-\s*\*\*Уровень/m.test(rg) && /^\s*-\s*\*\*Почему/m.test(rg));
      },
      problem: 'в «Регрессе» нет пункта «Уровень» и/или «Почему выбраны эти тесты» (обоснование выбора)',
    },
    {
      test: (t) => {
        const body = sectionBody(t, '## Шаги реализации тестов');
        return !body || /AT-\d+/.test(body);
      },
      problem: 'шаги реализации не связаны с автотестами (в разделе нет ни одного AT-ID)',
    },
  ],
  'report-auto-test': [
    {
      test: (t) => {
        const body = sectionBody(t, '## Реализованные автотесты');
        return !body || /AT-\d+/.test(body);
      },
      problem: 'нет ни одного автотеста с ID (AT-N) в «Реализованных автотестах»',
    },
    // У раздела про CI три допустимых состояния: сборка (у неё есть номер),
    // прямым текстом — почему её не было, либо маркер ожидания (отчёт написан
    // после ревью, сборки ещё не было). Четвёртого нет: пустой раздел молча
    // читается как «прогнали», а за ним обычно работа, которую никто не делал.
    // Ожидание законно, но промежуточно: валидацию оно проходит, а этап по
    // нему не закрывается — за это отвечает ciPending, а не ok.
    {
      test: (t) => {
        const body = sectionBody(t, '## Прогон в CI');
        return !body || /#\s*\d+/.test(body) || /не запускал/i.test(body) || CI_PENDING.test(body);
      },
      problem:
        'в «Прогоне в CI» нет ни номера сборки, ни причины «джоба с автотестами не запускалась», ' +
        'ни маркера «ожидается прогон в CI»',
    },
  ],
};

function done(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (typeof args.file !== 'string' || typeof args.type !== 'string') {
  done({ ok: false, problems: ['требуются --file <путь> и --type <тип>'] });
}
if (!REQUIRED[args.type]) {
  done({ ok: false, problems: [`неизвестный тип «${args.type}». Допустимые: ${Object.keys(REQUIRED).join(', ')}`] });
}
// Необязательные флаги, потерявшие значение, — не «как будто их нет»: этап
// думает, что сверка выполнена, а её не было. Называем это ошибкой.
for (const [flag, hint] of [
  ['workspace', 'путь к корню рабочего репозитория'],
  ['plan', 'путь к autotest-plan.md'],
  ['taskType', 'FE или BE'],
]) {
  if (args[flag] === true) done({ ok: false, problems: [`--${flag} требует значение (${hint})`] });
}
if (!fs.existsSync(args.file)) {
  done({ ok: false, problems: [`файл не найден: ${args.file}`] });
}

const text = fs.readFileSync(args.file, 'utf8');

const missingSections = REQUIRED[args.type].filter((h) => !text.includes(h));

const problems = [];
for (const rule of STRUCTURAL[args.type] || []) {
  if (!rule.test(text)) problems.push(rule.problem);
}

// План: раскладка по репозиториям. Разбор — общий с /implement-plan
// (lib/plan-repos.mjs), иначе валидатор признавал бы план годным, а этап
// получал бы другой список репозиториев. Идентификаторы сверяются с
// settings.json только при переданном --workspace: без него проверка
// остаётся чистым разбором текста.
let planRepos;
if (args.type === 'plan') {
  const parsed = parsePlanRepos(text);
  // Отсутствие самого раздела уже названо в missingSections — второй раз о
  // том же в problems только шумит.
  const sectionMissing = missingSections.includes('## Затронутые репозитории');
  problems.push(...parsed.problems.filter((p) => !(sectionMissing && p.startsWith('нет раздела'))));
  let unknown = [];
  let foreign = [];
  if (typeof args.workspace === 'string') {
    const cfg = readConfig(args.workspace);
    if (cfg.found && !cfg.error) {
      const known = unitIds(cfg);
      unknown = parsed.repos.filter((r) => !known.includes(r));
      if (unknown.length) {
        problems.push(
          `в плане названы репозитории, которых нет в settings.json: ${unknown.join(', ')}. ` +
            `Допустимые: ${known.join(', ')}`,
        );
      }
      // Репозиторий ЧУЖОЙ кодовой базы — отдельная и более опасная ошибка:
      // такой id существует, значит ни «неизвестный репозиторий», ни guard о
      // нём не скажут, а область записи /implement-plan ставится ПО ПЛАНУ —
      // FE-задача с забытой строкой-образцом открыла бы себе запись в бэкенд.
      if (typeof args.taskType === 'string') {
        const mine = codebaseUnits(cfg, args.taskType.trim().toUpperCase());
        foreign = parsed.repos.filter((r) => known.includes(r) && !mine.includes(r));
        if (foreign.length) {
          problems.push(
            `план ${args.taskType}-задачи называет репозитории чужой кодовой базы: ${foreign.join(', ')}. ` +
              `Кодовая база этой задачи: ${mine.join(', ')}`,
          );
        }
      }
    }
  }
  planRepos = { repos: parsed.repos, unknown, foreign, mismatch: parsed.mismatch };
}

// Сверка отчёта с планом: количество автотестов в report-auto-test.md обязано
// совпадать с планом. Считаем не числа из «Итого» (их правят руками и они
// расходятся с таблицей молча), а состав ID: AT-N раздела «Автотесты» плана
// против AT-N таблицы отчёта.
//   missing — автотест из плана не дошёл до отчёта: работа потеряна, ok:false;
//   extra   — тест сверх плана: не ошибка сама по себе, но обязан быть
//             объяснён строкой «Расхождение с планом», поэтому только warning.
let planMismatch;
if (args.type === 'report-auto-test' && args.plan) {
  if (!fs.existsSync(args.plan)) {
    problems.push(`план автотестов не найден: ${args.plan}`);
  } else {
    const planText = fs.readFileSync(args.plan, 'utf8');
    const planIds = ids(sectionBody(planText, '## Автотесты'), 'AT');
    const reportIds = ids(sectionBody(text, '## Реализованные автотесты'), 'AT');
    planMismatch = {
      missing: planIds.filter((id) => !reportIds.includes(id)),
      extra: reportIds.filter((id) => !planIds.includes(id)),
    };
    if (!planIds.length) problems.push(`в плане ${args.plan} нет ни одного AT-ID — сверять отчёт не с чем`);
    if (planMismatch.missing.length)
      problems.push(
        `в отчёте нет автотестов из плана: ${planMismatch.missing.join(', ')} ` +
          `(в плане ${planIds.length}, в отчёте ${reportIds.length})`,
      );
  }
}

// Промежуточное состояние отчёта: после ревью он полон всем, кроме «Прогона в
// CI», — сборки ещё не было. Такой отчёт валиден (состав автотестов уже сверен
// с планом, и это главное), но этапом не закрывается. Отдаём это отдельным
// полем: по одному ok:true промежуточный отчёт не отличить от финального, а
// разница между ними — целый прогон в CI.
let ciPending;
if (args.type === 'report-auto-test') {
  ciPending = CI_PENDING.test(sectionBody(text, '## Прогон в CI'));
}

// Остатки плейсхолдеров шаблона: <название>, <TASK-ID>, <N> и т.п.
// Лимит держит вывод ограниченным, но обязан вмещать самый крупный шаблон
// целиком: иначе хвост нетронутого каркаса молча выпадает из предупреждения.
//
// html-комментарии шаблона — инструкция АГЕНТУ, а не место для заполнения,
// и удалять их из готового артефакта нигде не предписано. Токен в угловых
// скобках внутри комментария заглушкой не считается: иначе даже полностью
// заполненный артефакт вечно возвращался бы агенту «на доработку».
const PLACEHOLDER_LIMIT = 40;
const placeholders = [];
const scanned = text.replace(/<!--[\s\S]*?-->/g, '');
const phRe = /<[A-Za-zА-Яа-яЁё][^<>\n]{0,60}>/g;
let m;
while ((m = phRe.exec(scanned))) {
  if (!placeholders.includes(m[0])) placeholders.push(m[0]);
  if (placeholders.length >= PLACEHOLDER_LIMIT) break;
}

done({
  ok: missingSections.length === 0 && problems.length === 0,
  missingSections,
  problems,
  placeholders,
  ...(ciPending === undefined ? {} : { ciPending }),
  ...(planMismatch ? { planMismatch } : {}),
  ...(planRepos ? { planRepos } : {}),
});
