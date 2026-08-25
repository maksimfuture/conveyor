// plan-repos.mjs — разбор плана: какие репозитории он объявил затронутыми.
//
// Один разбор на двух потребителей: validate-artifact (проверяет, что план
// заполнен) и стейдж /implement-plan (ставит по нему рабочую область). Если
// бы каждый читал план по-своему, валидатор признавал бы план годным, а этап
// получал бы другой список — то есть защита стояла бы не там, где обещано.
//
// Источников два, и они обязаны совпасть:
//   - таблица раздела «Затронутые репозитории» (первая колонка);
//   - теги «Репозиторий: <id>» у шагов раздела «Шаги реализации».
// Расхождение — ошибка: план выглядит заполненным, а /implement-plan получит
// неверную область записи.

const TABLE_SECTION = '## Затронутые репозитории';
const STEPS_SECTION = '## Шаги реализации';

// Тело раздела: от заголовка до следующего «## ». html-комментарии вырезаем —
// это инструкция шаблона агенту, а не содержимое плана (иначе строка-образец
// из комментария засчитывалась бы за объявленный репозиторий).
export function sectionBody(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/<!--[\s\S]*?-->/g, '');
}

// Значение ячейки/тега → id юнита. Снимаем обратные кавычки и хвостовую
// пунктуацию: «Репозиторий: backend.api.» — это backend.api, а не «backend.api.».
function normalizeId(raw) {
  return String(raw || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/[.,;:]+$/, '')
    .trim();
}

// Незаполненный плейсхолдер шаблона (<id>) репозиторием не считается: иначе
// нетронутый каркас проходил бы как «план объявил репозиторий».
const isPlaceholder = (v) => v === '' || /^<.*>$/.test(v);

function uniq(list) {
  return [...new Set(list)];
}

// Идентификаторы из таблицы «Затронутые репозитории» (первая колонка).
export function reposFromTable(text) {
  const body = sectionBody(text, TABLE_SECTION);
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    if (!cells.length) continue;
    const first = normalizeId(cells[0]);
    if (isPlaceholder(first)) continue;
    // Шапка таблицы и разделитель — не строки данных.
    if (/^[-: ]+$/.test(first)) continue;
    if (first.toLowerCase() === 'репозиторий') continue;
    out.push(first);
  }
  return uniq(out);
}

// Шаги раздела «Шаги реализации» с тегом репозитория (и без него).
export function stepsFromPlan(text) {
  const body = sectionBody(text, STEPS_SECTION);
  const steps = [];
  for (const line of body.split(/\r?\n/)) {
    const row = line.trim();
    if (!/^- \[[ xX]\]/.test(row)) continue;
    const m = row.match(/Репозитор(?:ий|ии)\s*:\s*([^—\n]+?)(?:\.\s|\.$|;|—|$)/i);
    const label = (row.match(/\*\*(.+?)\*\*/) || [, row.slice(0, 40)])[1];
    if (!m) {
      steps.push({ label, repos: [], tagged: false });
      continue;
    }
    const repos = m[1]
      .split(',')
      .map(normalizeId)
      .filter((v) => !isPlaceholder(v));
    // Тег есть, но в нём остался каркас шаблона (`<id>`) — это не «забыли
    // написать», а «не заполнили»; лечится по-разному, поэтому и говорится
    // об этом по-разному.
    steps.push({ label, repos, tagged: true });
  }
  return steps;
}

// Полный разбор. Ничего не бросает: план приходит от модели и бывает любым.
//   repos              — объединение таблицы и шагов (порядок таблицы первым)
//   fromTable/fromSteps
//   stepsWithoutRepo   — шаги без тега «Репозиторий:»
//   mismatch           — { onlyInTable, onlyInSteps }
//   problems           — готовые к показу формулировки
export function parsePlanRepos(text) {
  const fromTable = reposFromTable(text);
  const steps = stepsFromPlan(text);
  const fromSteps = uniq(steps.flatMap((s) => s.repos));
  const stepsWithoutRepo = steps.filter((s) => !s.repos.length).map((s) => s.label);
  const stepsUnfilled = steps.filter((s) => s.tagged && !s.repos.length).map((s) => s.label);
  const stepsUntagged = steps.filter((s) => !s.tagged).map((s) => s.label);

  const mismatch = {
    onlyInTable: fromTable.filter((r) => !fromSteps.includes(r)),
    onlyInSteps: fromSteps.filter((r) => !fromTable.includes(r)),
  };

  const problems = [];
  if (text.indexOf(TABLE_SECTION) === -1) {
    problems.push(`нет раздела «${TABLE_SECTION}» — план не говорит, где будут правки`);
  } else if (!fromTable.length) {
    problems.push(
      `в разделе «${TABLE_SECTION}» нет ни одной заполненной строки таблицы ` +
        '(первая колонка — идентификатор рабочей копии, например `backend.api`)',
    );
  }
  if (!steps.length) {
    problems.push(`в разделе «${STEPS_SECTION}» нет ни одного шага`);
  }
  if (stepsUntagged.length) {
    problems.push(
      `шаги без тега «Репозиторий:»: ${stepsUntagged.join('; ')} — ` +
        'у каждого шага должен быть указан репозиторий, в котором он выполняется',
    );
  }
  if (stepsUnfilled.length) {
    problems.push(
      `шаги с незаполненным тегом «Репозиторий:»: ${stepsUnfilled.join('; ')} — ` +
        'вместо каркаса шаблона нужен идентификатор рабочей копии (например `backend.api`)',
    );
  }
  if (mismatch.onlyInTable.length) {
    problems.push(
      `репозитории есть в таблице, но ни один шаг их не правит: ${mismatch.onlyInTable.join(', ')}`,
    );
  }
  if (mismatch.onlyInSteps.length) {
    problems.push(
      `репозитории есть в шагах, но их нет в таблице «${TABLE_SECTION}»: ${mismatch.onlyInSteps.join(', ')}`,
    );
  }

  return {
    repos: uniq(fromTable.concat(fromSteps)),
    fromTable,
    fromSteps,
    steps,
    stepsWithoutRepo,
    stepsUntagged,
    stepsUnfilled,
    mismatch,
    problems,
  };
}
