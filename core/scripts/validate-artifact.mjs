#!/usr/bin/env node
// validate-artifact.mjs — программная проверка артефактов по шаблонам
// (core/templates/*). Снимает с модели «самопроверку» — особенно важно в
// быстром режиме (CONVEYOR_FAST), но применима всегда.
//
// Usage:
//   node validate-artifact.mjs --file <путь> --type <тип>
//     тип: intent | specification | plan | autotest-plan | report-auto-test
//
// Output (stdout, JSON):
//   { ok, missingSections: [...], problems: [...], placeholders: [...] }
// ok=false, если отсутствуют обязательные разделы или не выполнены
// структурные требования (REQ-ID/TC-ID). Остатки плейсхолдеров шаблона
// (<...>) — предупреждение в placeholders, ok не роняют.

import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

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
  ],
  plan: [
    '## Краткое резюме',
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
    '## Объект тестирования',
    '## Уровни тестирования',
    '## Тест-кейсы',
    '## Тестовые данные',
    '## Что не автоматизируем',
  ],
  'report-auto-test': ['## Итог прогона', '## Реализованные кейсы', '## Ревью', '## Ветка'],
};

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
  ],
};

function done(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

const args = parseArgs(process.argv.slice(2));
if (!args.file || !args.type) {
  done({ ok: false, problems: ['требуются --file <путь> и --type <тип>'] });
}
if (!REQUIRED[args.type]) {
  done({ ok: false, problems: [`неизвестный тип «${args.type}». Допустимые: ${Object.keys(REQUIRED).join(', ')}`] });
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

// Остатки плейсхолдеров шаблона: <название>, <TASK-ID>, <N> и т.п.
const placeholders = [];
const phRe = /<[A-Za-zА-Яа-яЁё][^<>\n]{0,60}>/g;
let m;
while ((m = phRe.exec(text))) {
  if (!placeholders.includes(m[0])) placeholders.push(m[0]);
  if (placeholders.length >= 20) break;
}

done({
  ok: missingSections.length === 0 && problems.length === 0,
  missingSections,
  problems,
  placeholders,
});
