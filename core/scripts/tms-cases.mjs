#!/usr/bin/env node
// tms-cases.mjs — мост между планом автотестов и TMS (Zephyr Scale в Jira),
// этап /conveyor:update-tms. В Jira скрипт НЕ ходит: туда ходит MCP-сервер в
// сессии модели. Здесь — всё, что можно сделать детерминированно и что модель
// делать не должна:
//   - разобрать таблицу «Тест-кейсы» в готовые к отправке кейсы (шаги из
//     `1) … 2) …`, ожидаемый результат по шагам, значения кастомных полей).
//     Пересказанный моделью шаг — это уже другой кейс;
//   - запомнить, какой заглушке какой ключ выдал Zephyr (meta.json →
//     tmsCases) — СРАЗУ после создания каждого кейса: этап, упавший на пятом
//     кейсе, при повторе не продублирует первые четыре;
//   - заменить заглушки (PROJ-T999-N) на ключи в плане, отчёте и в @TmsLink
//     кода автотестов. Замена точная, по границе ID: `T999-1` не задевает
//     `T999-10`.
//
// Subcommands (`--repo` везде по умолчанию — repos.autoTest из settings.json):
//   parse      --task <папка задачи> [--repo <копия автотестов>]
//              — кейсы с готовыми полями; поля Zephyr — из <repo>/.conveyor/tms.json
//   pending    --task <папка задачи> [--repo <копия автотестов>]
//              — заглушки задачи, не заменённые ключами, в плане И в коде;
//                конфиг TMS не нужен (run-auto-test)
//   record     --task <папка задачи> --id <PROJ-T999-N> --key <PROJ-T123> [--adopted]
//              — `--adopted`: кейс не создан этапом, а найден в Zephyr и взят
//   apply      --task <папка задачи> [--repo <копия автотестов>] [--dry-run]
//   check-diff [--repo <копия автотестов>] [--task <папка задачи>]
//              — перед коммитом: в рабочей копии изменены ТОЛЬКО строки @TmsLink
//
// Output (stdout, JSON): { ok, ... } либо { ok:false, error }. Код выхода
// повторяет ok. Каждая запись проходит checkWrite — ту же проверку рабочей
// области, что и guard-хуки: скрипт пишет файлы сам, мимо PreToolUse, и без
// неё обходил бы защиту. Нет конфигурации — нет и записи (fail-closed).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readConfig, readJsonFile, checkWrite } from './lib/config.mjs';
import { TMS_CELL, sectionBody, tableHead, tableRows } from './lib/md-table.mjs';
import { readTmsConfig, TMS_CONFIG_PATH, TMS_CONFIG_EXAMPLE } from './lib/tms-config.mjs';

// Заглушка нового теста: ключ проекта, `T999` и сквозной номер по плану.
const PLACEHOLDER = /^([A-Z][A-Z0-9]{1,14})-T999-(\d+)$/;
// Ключ кейса, выданный Zephyr: без суффикса — по нему заглушку и отличаем.
const TMS_KEY = /^([A-Z][A-Z0-9]{1,14})-T\d+$/;

// Названия полей Zephyr и их значения — конвенция команды, а не плагина: они
// лежат в репозитории автотестов (`.conveyor/tms.json`, см. lib/tms-config.mjs).
// Папку и владельца этап спрашивает в сессии — они меняются от задачи к задаче.

const CASE_COLUMNS = ['ID', 'Вид тестирования', 'Уровень', 'Название', 'Шаги', 'Ожидаемый результат', 'REQ-ID', 'Автотест'];

// Каталоги рабочей копии автотестов, где исходников тестов не бывает:
// сборка, зависимости, служебные данные IDE и git.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'out', 'dist', '.gradle', '.idea', '.mvn', 'allure-results']);
const SOURCE_EXT = new Set(['.java', '.kt', '.groovy', '.scala']);
// @TmsLink("PROJ-T1") и @TmsLink(value = "PROJ-T1"), в том числе внутри
// @TmsLinks({...}). Меняется только литерал ID в аннотации — не константы,
// не комментарии и не строки в теле теста.
const TMS_LINK = /(@TmsLink\s*\(\s*(?:value\s*=\s*)?")([^"\n]+)("\s*\))/g;
// Любая заглушка в тексте исходника — не только в @TmsLink. Заменяет скрипт
// только литерал аннотации, а ПОКАЗЫВАТЬ обязан всё: ID в константе
// (`@TmsLink(Ids.CREATE)`) иначе остался бы незамеченным, а результаты
// прогона — не связанными с кейсом.
const PLACEHOLDER_ANY = /\b[A-Z][A-Z0-9]{1,14}-T999-\d+\b/g;

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

function done(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

function fail(error, extra) {
  done({ ok: false, error, ...(extra || {}) });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Граница ID: до него не буква/цифра/дефис, после — не буква/цифра. Иначе
// замена `PROJ-T999-1` портит `PROJ-T999-10` и `XPROJ-T999-1`.
const idRe = (id) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_])`, 'g');

// Текст ячейки → текст для Zephyr. Экранированная черта — обычный символ;
// обратные кавычки markdown Zephyr не рендерит, и в кейсе они остались бы
// мусором.
function cleanCell(s) {
  return String(s || '')
    .replace(/\\\|/g, '|')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// `1) a 2) b 3) c` → [{n:1,text:'a'}, …]. Номером пункта считается только
// `N)` после пробела или в начале и только по порядку 1, 2, 3…: «ответ (200)»
// и «2) … 5)» пунктами не станут. Нет `1)` — весь текст одним пунктом без
// номера. Текст до `1)` приклеивается к первому пункту.
function splitNumbered(text) {
  const src = cleanCell(text);
  const re = /(^|\s)(\d{1,2})\)\s+/g;
  const marks = [];
  let want = 1;
  let m;
  while ((m = re.exec(src))) {
    if (Number(m[2]) !== want) continue;
    marks.push({ n: want, at: m.index + m[1].length, body: m.index + m[0].length });
    want++;
  }
  if (!marks.length) return src ? [{ n: null, text: src }] : [];
  const out = marks.map((mk, i) => ({
    n: mk.n,
    text: src.slice(mk.body, i + 1 < marks.length ? marks[i + 1].at : src.length).trim(),
  }));
  const preamble = src.slice(0, marks[0].at).trim();
  if (preamble) out[0].text = `${preamble} ${out[0].text}`.trim();
  return out;
}

// Шаги кейса: действие из «Шагов», ожидание того же номера — из «Ожидаемого
// результата». Ожидание без номера (одной фразой) — к последнему шагу: это
// итог сценария. Лишние пункты ожидания (номеров больше, чем шагов) тоже
// уходят в последний шаг — теряться им нельзя.
function buildSteps(stepsCell, expectedCell) {
  const steps = splitNumbered(stepsCell);
  const expected = splitNumbered(expectedCell);
  if (!steps.length) return [];
  const out = steps.map((s) => ({ description: s.text, testData: '', expectedResult: '' }));
  const last = out[out.length - 1];
  const numbered = steps[0].n !== null && expected.length && expected[0].n !== null;
  if (!numbered) {
    last.expectedResult = expected.map((e) => e.text).join(' ');
    return out;
  }
  for (const e of expected) {
    const target = e.n <= out.length ? out[e.n - 1] : last;
    target.expectedResult = target.expectedResult ? `${target.expectedResult} ${e.text}` : e.text;
  }
  return out;
}

// Предусловие кейса — раздел плана «Тестовые данные и окружение»: стенд,
// данные, предусловия окружения. Строки с незаполненным каркасом (`<…>`)
// пропускаем: в Zephyr они были бы мусором.
function precondition(planText) {
  return sectionBody(planText, '## Тестовые данные')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => cleanCell(l.replace(/^[-*]\s+/, '').replace(/\*\*/g, '')))
    .filter((l) => l && !/<[^>]+>/.test(l))
    .join('\n');
}

function readTask(taskArg) {
  if (!taskArg || taskArg === true) fail('нужен аргумент --task <абсолютный путь к папке задачи>');
  const taskDir = path.resolve(String(taskArg));
  const metaPath = path.join(taskDir, 'meta.json');
  if (!fs.existsSync(metaPath)) fail(`в папке задачи нет meta.json: ${taskDir}`);
  let meta;
  try {
    meta = readJsonFile(metaPath);
  } catch (e) {
    fail(`meta.json не читается: ${e.message}`);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('meta.json — не объект');
  const map = meta.tmsCases === undefined ? {} : meta.tmsCases;
  if (!map || typeof map !== 'object' || Array.isArray(map)) fail('meta.json → tmsCases должен быть объектом «заглушка → ключ»');
  // Кейсы, которые этап НЕ создавал, а нашёл в Zephyr и взял (дубль по
  // названию). Ключ у них в tmsCases, как у созданных, — заглушку в коде
  // меняют одинаково. Но писали их тестировщики, и по плану целиком их не
  // переписывают.
  const adopted = meta.tmsAdopted === undefined ? [] : meta.tmsAdopted;
  if (!Array.isArray(adopted) || !adopted.every((k) => typeof k === 'string'))
    fail('meta.json → tmsAdopted должен быть списком ключей кейсов');
  const type = meta.type || path.basename(path.dirname(taskDir));
  const taskId = meta.taskId || path.basename(taskDir);
  const cfg = readConfig(taskDir);
  return { taskDir, metaPath, meta, map, adopted: new Set(adopted), type, taskId, cfg };
}

// Без конфигурации проверять запись не по чему — значит, не пишем вовсе
// (fail-closed, как и guard-хуки). Битый settings.json или --task за
// пределами рабочего репозитория не должны превращаться в «пиши куда угодно».
function writeChecked(file, text, cfg, denied) {
  if (!cfg || !cfg.found || cfg.error) {
    denied.push({
      file,
      reason: cfg && cfg.error ? `settings.json не читается (${cfg.error})` : 'рабочий репозиторий conveyor не найден',
    });
    return false;
  }
  const verdict = checkWrite(file, cfg);
  if (!verdict.allowed) {
    denied.push({ file, reason: verdict.reason });
    return false;
  }
  fs.writeFileSync(file, text, 'utf8');
  return true;
}

// Рабочая копия автотестов: явный --repo либо repos.autoTest из настроек.
// null — не найдена (нет ссылки, ссылка наружу, нет .git).
function resolveRepo(a, cfg) {
  const auto = cfg && cfg.found && !cfg.error && cfg.links ? cfg.links.autoTest : null;
  const repo = a.repo && a.repo !== true ? path.resolve(String(a.repo)) : (auto && auto.inside && auto.path) || null;
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) return { repo: null, tried: repo };
  return { repo, tried: repo };
}

// Заглушки в исходниках рабочей копии: { файл: [ID] }.
function scanRepoPlaceholders(repo) {
  const out = {};
  for (const file of walkSources(repo, [])) {
    const found = fs.readFileSync(file, 'utf8').match(PLACEHOLDER_ANY);
    if (found) out[path.relative(repo, file).split(path.sep).join('/')] = [...new Set(found)];
  }
  return out;
}

// Заглушки ЭТОЙ задачи — из плана и из tmsCases (после замены в плане их
// уже нет, а в коде могли остаться). Заглушка в коде, которой нет ни там, ни
// там, пришла из основной ветки от чужой задачи: её показываем, но этап ею
// не блокируем — иначе он не завершился бы никогда.
function splitRepoPlaceholders(byFile, ownIds) {
  const own = [];
  const foreign = [];
  for (const [file, ids] of Object.entries(byFile)) {
    const mine = ids.filter((id) => ownIds.has(id));
    const other = ids.filter((id) => !ownIds.has(id));
    if (mine.length) own.push(`${file}: ${mine.join(', ')}`);
    if (other.length) foreign.push(`${file}: ${other.join(', ')}`);
  }
  return { own, foreign, ownIds: [...new Set(Object.values(byFile).flat().filter((id) => ownIds.has(id)))] };
}

function planPlaceholders(plan) {
  return tableRows(sectionBody(plan, '## Тест-кейсы'))
    .map((r) => r[0] || '')
    .filter((id) => PLACEHOLDER.test(id));
}

// ---- parse ------------------------------------------------------------------

function cmdParse(a, pendingOnly) {
  const { taskDir, map, adopted, type, taskId, cfg } = readTask(a.task);
  const planPath = path.join(taskDir, 'autotest-plan.md');
  if (!fs.existsSync(planPath)) fail(`нет autotest-plan.md в папке задачи: ${taskDir}`);
  const plan = fs.readFileSync(planPath, 'utf8').replace(/\r\n/g, '\n');

  const warnings = [];
  const problems = [];
  const auto = cfg.found && !cfg.error && cfg.links ? cfg.links.autoTest : null;

  // Заглушки задачи, не заменённые ключами. Мешают те, что в КОДЕ (по
  // @TmsLink прогон связывается с кейсом), а в плане их после замены уже не
  // видно — поэтому смотрим и план, и рабочую копию. Конфиг команды для
  // этого не нужен: /conveyor:run-auto-test предупреждает и там, где TMS не
  // настроена вовсе.
  const { repo, tried } = resolveRepo(a, cfg);
  const inPlan = planPlaceholders(plan);
  const ownIds = new Set([...inPlan, ...Object.keys(map)]);
  const inRepo = repo ? splitRepoPlaceholders(scanRepoPlaceholders(repo), ownIds) : null;
  const pending = [...new Set([...inPlan, ...(inRepo ? inRepo.ownIds : [])])];
  const pendingInfo = {
    pending,
    pendingIn: { plan: inPlan, repo: inRepo ? inRepo.own : null },
    // Заглушки чужих задач в коде (пришли из основной ветки) — не блокер.
    foreignPlaceholders: inRepo ? inRepo.foreign : [],
  };
  if (pendingOnly) {
    return done({
      ok: true,
      taskId,
      ...pendingInfo,
      ...(repo ? {} : { warnings: [`рабочая копия автотестов не найдена (${tried || 'нет ссылки'}) — код не проверен`] }),
    });
  }

  // Конвенции полей Zephyr — из репозитория автотестов. Без них кейс собрать
  // нечем: этап останавливается и показывает образец.
  if (!repo) fail(`не найдена рабочая копия автотестов (${tried || 'settings.json → repos.autoTest.link'}) — передайте --repo`);
  const tmsConfig = readTmsConfig(repo);
  if (!tmsConfig.found)
    fail(`в репозитории автотестов нет ${TMS_CONFIG_PATH} — конвенций полей Zephyr команды; образец: ${TMS_CONFIG_EXAMPLE}`, {
      tmsConfig: { path: tmsConfig.path, found: false },
    });
  if (!tmsConfig.config)
    fail(`${TMS_CONFIG_PATH} в репозитории автотестов заполнен с ошибками`, {
      tmsConfig: { path: tmsConfig.path, found: true, errors: tmsConfig.errors },
    });
  const conf = tmsConfig.config;
  const { kind: fKind, automated: fAuto, level: fLevel } = conf.fields;
  const tmsUrl = (auto && auto.tmsUrl) || null;
  if (!tmsUrl) warnings.push('не задана ссылка на тест-кейсы проекта (settings.json → repos.autoTest.linkTMS)');
  // projectId из ссылки вида …/Tests.jspa#/v2/testCases?projectId=329301 —
  // часть MCP-серверов Zephyr адресует проект им, а не ключом.
  const projectId = ((tmsUrl || '').match(/[?&]projectId=(\d+)/) || [])[1] || null;

  const casesBody = sectionBody(plan, '## Тест-кейсы');
  const head = tableHead(casesBody);
  const missing = CASE_COLUMNS.filter((c) => !head.includes(c));
  if (!head.length) fail('в autotest-plan.md нет таблицы «Тест-кейсы»');
  if (missing.length) fail(`в таблице «Тест-кейсы» нет колонок: ${missing.join(', ')}`);
  const col = Object.fromEntries(CASE_COLUMNS.map((c) => [c, head.indexOf(c)]));

  // Статус автотеста по ID: «Автоматизирован: Да» ставим только тесту,
  // который реально написан ([x]). Строка «да» с `[ ]` — тест обещан, но не
  // сделан: в Zephyr это «На автоматизации».
  const autoBody = sectionBody(plan, '## Автотесты');
  const autoHead = tableHead(autoBody);
  const statusIdx = autoHead.indexOf('Статус');
  const autoStatus = {};
  for (const r of tableRows(autoBody)) autoStatus[r[0]] = statusIdx >= 0 ? r[statusIdx] || '' : '';

  const rows = tableRows(casesBody);
  const usedKeys = new Set(Object.values(map));
  const prefixes = new Set();
  const cases = [];
  const pre = precondition(plan);

  for (const r of rows) {
    if (r.length !== head.length) {
      problems.push(`строка «${r[0] || '?'}»: число ячеек не совпадает с шапкой (неэкранированный «|»?)`);
      continue;
    }
    const id = r[col.ID];
    if (!TMS_CELL.test(id)) {
      problems.push(`строка «${id}»: в первой ячейке не ID теста`);
      continue;
    }
    prefixes.add(id.split('-')[0]);
    const placeholder = PLACEHOLDER.test(id);
    const mappedKey = placeholder ? map[id] || null : null;
    const kind = placeholder ? (mappedKey ? 'mapped' : 'new') : 'existing';

    const rawKind = cleanCell(r[col['Вид тестирования']]);
    const kindValue = fKind.values[rawKind] || null;
    if (!kindValue) warnings.push(`${id}: «Вид тестирования» = «${rawKind}» — ожидается НФ или Регресс, «${fKind.name}» не заполняется`);

    const rawLevel = cleanCell(r[col['Уровень']]);
    const levelValue = fLevel.values[rawLevel.toUpperCase()] || null;
    if (!levelValue)
      warnings.push(
        `${id}: уровня «${rawLevel}» нет в ${TMS_CONFIG_PATH} (${Object.keys(fLevel.values).join('/')}) — «${fLevel.name}» не заполняется`,
      );

    // Состояние автотеста: написан ([x] в «Автотестах»), обещан ([ ]) или его нет.
    const autotest = cleanCell(r[col['Автотест']]).toLowerCase();
    let autoState = 'no';
    if (autotest === 'да') {
      autoState = /\[[xX]\]/.test(autoStatus[id] || '') ? 'done' : 'planned';
      if (autoState === 'planned')
        warnings.push(`${id}: автотест в плане есть, но «Статус» не [x] — «${fAuto.name}: ${fAuto.values.planned}»`);
    }

    const title = cleanCell(r[col['Название']]);
    const req = cleanCell(r[col['REQ-ID']]);
    const steps = buildSteps(r[col['Шаги']], r[col['Ожидаемый результат']]);
    if (!steps.length) problems.push(`${id}: пустые «Шаги»`);

    const customFields = {
      [fKind.name]: kindValue,
      [fAuto.name]: fAuto.values[autoState],
      [fLevel.name]: levelValue,
      ...conf.constantFields,
      ...(conf.fieldsByTaskType[type] || {}),
    };

    const tmsKey = placeholder ? mappedKey : id;
    cases.push({
      id,
      kind,
      tmsKey,
      // Кейс создан этим этапом раньше: план для него — источник правды
      // целиком. Чужой кейс (написан тестировщиками) правится бережно — см.
      // шаг «Сверка существующих кейсов» в core/stages/update-tms.md. Взятый
      // по поиску (tmsAdopted) — тоже чужой: этап его только нашёл.
      createdByConveyor: !!tmsKey && (placeholder ? !!mappedKey : usedKeys.has(id)) && !adopted.has(tmsKey),
      adopted: !!tmsKey && adopted.has(tmsKey),
      plan: { kind: rawKind, level: rawLevel, req, autotest, autoState, status: autoStatus[id] || null },
      // У существующего кейса поле автоматизации только ПОВЫШАЕТСЯ: план
      // знает, автоматизирует ли кейс ЭТА задача, но не знает, что регресс
      // уже автоматизирован другой. «Да» из Zephyr на «Нет» не меняем.
      ...(kind === 'new' ? {} : { raiseOnly: { field: fAuto.name, value: fAuto.values[autoState] } }),
      testCase: {
        // Название без префикса — для поиска дубля: префикс (namePrefix
        // конфига) бывает меткой статуса, которую команда меняет руками, и
        // по полному названию дубль тогда не найдётся.
        title,
        name: `${conf.namePrefix}${title}`,
        objective: `${title}. Задача разработки: ${taskId}; требования: ${req}`,
        precondition: pre,
        issueLinks: [taskId],
        steps,
        customFields,
      },
    });
  }

  // Ключ проекта — из ID тестов плана: они и есть ключи кейсов Zephyr.
  let projectKey = null;
  if (prefixes.size === 1) projectKey = [...prefixes][0];
  else if (prefixes.size > 1) problems.push(`в плане ID из нескольких проектов (${[...prefixes].join(', ')}) — план должен адресовать один проект`);
  const created = cases.filter((c) => c.kind === 'new');

  done({
    ok: problems.length === 0,
    taskId,
    type,
    projectKey,
    tmsUrl,
    projectId,
    tmsConfig: { path: tmsConfig.path },
    // Приоритет и статус — только для НОВЫХ кейсов; не заданы в конфиге —
    // null, и сервер возьмёт свои умолчания.
    defaults: { priority: conf.priority, status: conf.status },
    // Порядок значений поля автоматизации — для правила «только повышать»:
    // значение кейса правее (или не из этого списка) — поле не трогаем.
    automatedRank: { field: fAuto.name, order: [fAuto.values.no, fAuto.values.planned, fAuto.values.done] },
    counts: {
      total: cases.length,
      new: created.length,
      mapped: cases.filter((c) => c.kind === 'mapped').length,
      existing: cases.filter((c) => c.kind === 'existing').length,
    },
    // Заглушки задачи, ещё не заменённые ключами, — в плане и в коде.
    // Пустой список — условие done этапа.
    ...pendingInfo,
    cases,
    warnings,
    problems,
  });
}

// ---- record -------------------------------------------------------------------

function cmdRecord(a) {
  const { metaPath, meta, map, adopted, cfg } = readTask(a.task);
  const adopt = a.adopted === true;
  const id = typeof a.id === 'string' ? a.id.trim() : '';
  const key = typeof a.key === 'string' ? a.key.trim() : '';
  const pm = id.match(PLACEHOLDER);
  if (!pm) fail(`--id «${id}» — не заглушка нового теста (PROJ-T999-N)`);
  const km = key.match(TMS_KEY);
  if (!km) fail(`--key «${key}» — не ключ кейса Zephyr (PROJ-T123)`);
  if (pm[1] !== km[1]) fail(`ключ ${key} из другого проекта, чем заглушка ${id}`);
  if (map[id] === key) {
    // Повтор той же записи — норма (перезапуск). Но «создан» и «взят» — два
    // разных факта о кейсе, и молча переписать один другим нельзя.
    if (adopted.has(key) !== adopt)
      fail(`кейс ${key} уже записан как ${adopted.has(key) ? 'взятый (--adopted)' : 'созданный этапом'} — признак не меняется`);
    return done({ ok: true, id, key, adopted: adopt, changed: false });
  }
  if (map[id]) fail(`заглушке ${id} уже сопоставлен ${map[id]} — второй кейс для одного теста не заводится`);
  const owner = Object.keys(map).find((k) => map[k] === key);
  if (owner) fail(`ключ ${key} уже сопоставлен заглушке ${owner}`);

  const next = { ...meta, tmsCases: { ...map, [id]: key } };
  if (adopt) next.tmsAdopted = [...adopted, key];
  const denied = [];
  if (!writeChecked(metaPath, JSON.stringify(next, null, 2) + '\n', cfg, denied))
    fail(`запись meta.json заблокирована: ${denied[0].reason}`);
  done({ ok: true, id, key, adopted: adopt, changed: true });
}

// ---- apply --------------------------------------------------------------------

function walkSources(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkSources(path.join(dir, e.name), out);
    } else if (SOURCE_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name));
  }
  return out;
}

function cmdApply(a) {
  const { taskDir, map, cfg } = readTask(a.task);
  const dry = a['dry-run'] === true;
  const ids = Object.keys(map).filter((k) => PLACEHOLDER.test(k) && TMS_KEY.test(map[k]));

  // Всё, что может остановить замену, — ДО первой записи. Иначе план и отчёт
  // уже с ключами, а код ещё с заглушками: хуже состояния нет — по плану
  // больше не видно, что что-то не доделано.
  if (!cfg.found || cfg.error)
    fail(cfg.error ? `settings.json не читается: ${cfg.error}` : 'рабочий репозиторий conveyor не найден — запись не проверить');
  const { repo, tried } = resolveRepo(a, cfg);
  if (!repo) fail(`рабочая копия автотестов не найдена (${tried || 'settings.json → repos.autoTest.link'}): без неё заглушки в @TmsLink остались бы на месте`);

  const denied = [];
  const changed = [];
  const leftovers = {};

  // Артефакты задачи: план и отчёт. Отчёта может ещё не быть — не ошибка.
  let planAfter = '';
  for (const name of ['autotest-plan.md', 'report-auto-test.md']) {
    const file = path.join(taskDir, name);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    let count = 0;
    for (const id of ids) {
      after = after.replace(idRe(id), () => {
        count++;
        return map[id];
      });
    }
    if (name === 'autotest-plan.md') planAfter = after;
    const left = [...new Set(after.match(PLACEHOLDER_ANY) || [])];
    if (left.length) leftovers[name] = left;
    if (!count) continue;
    if (!dry && !writeChecked(file, after, cfg, denied)) continue;
    changed.push({ file: name, count });
  }

  // Код автотестов: заменяется только литерал ID внутри @TmsLink.
  const repoFiles = [];
  for (const file of walkSources(repo, [])) {
    const before = fs.readFileSync(file, 'utf8');
    let count = 0;
    const after = before.replace(TMS_LINK, (whole, open, value, close) => {
      const v = value.trim();
      if (map[v] && TMS_KEY.test(map[v])) {
        count++;
        return `${open}${map[v]}${close}`;
      }
      return whole;
    });
    if (!count) continue;
    const rel = path.relative(repo, file).split(path.sep).join('/');
    if (!dry && !writeChecked(file, after, cfg, denied)) continue;
    repoFiles.push(rel);
    changed.push({ file: rel, count });
  }

  // Что осталось в коде после замены — ЛЮБЫЕ вхождения заглушек, не только
  // в @TmsLink: ID в константе или комментарии скрипт не меняет, но обязан
  // показать. Свои (план, tmsCases) — блокируют done этапа, чужие — нет.
  const ownIds = new Set([...planPlaceholders(planAfter), ...Object.keys(map)]);
  const inRepo = dry ? null : splitRepoPlaceholders(scanRepoPlaceholders(repo), ownIds);
  if (inRepo && inRepo.own.length) leftovers.repo = inRepo.own;
  if (inRepo && inRepo.foreign.length) leftovers.foreign = inRepo.foreign;

  done({
    ok: denied.length === 0,
    dryRun: dry,
    mapping: Object.fromEntries(ids.map((id) => [id, map[id]])),
    changed,
    // Файлы рабочей копии автотестов, изменённые заменой, — ровно их этап
    // добавляет в коммит (не `git add -A`); check-diff сверяет с ними.
    repoFiles,
    leftovers,
    ...(denied.length ? { denied } : {}),
  });
}

// ---- check-diff ---------------------------------------------------------------

// Guard видит путь файла, а не содержимое: запись в автотесты на этапе
// открыта целиком. Что изменено на деле только @TmsLink, проверяется здесь,
// ПЕРЕД коммитом: рабочая копия была чистой (шаг 2 этапа), значит, любая
// правка в ней — правка этого этапа. Новый файл или изменённая строка без
// @TmsLink — остановка, коммита нет.
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function cmdCheckDiff(a) {
  const cfg = a.task && a.task !== true ? readTask(a.task).cfg : readConfig(process.cwd());
  const { repo, tried } = resolveRepo(a, cfg);
  if (!repo) fail(`рабочая копия автотестов не найдена (${tried || 'передайте --repo'})`);
  const violations = [];
  const files = new Set();
  // core.quotepath=false: кириллица в путях без восьмеричных escape.
  const status = git(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all']);
  for (const line of status.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    files.add(file);
    if (code === '??') violations.push(`${file}: новый файл — этап только меняет ID в существующих тестах`);
    else if (/D/.test(code)) violations.push(`${file}: файл удалён`);
    else if (/R/.test(code)) violations.push(`${file}: файл переименован`);
  }
  const diff = git(repo, ['-c', 'core.quotepath=false', 'diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff']);
  let current = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      current = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('--- ') || !/^[+-]/.test(line)) continue;
    if (!/@TmsLink/.test(line)) violations.push(`${current}: изменена строка не с @TmsLink — «${line.slice(1).trim().slice(0, 120)}»`);
  }
  done({ ok: violations.length === 0, repo, files: [...files], violations });
}


// ---- dispatch -----------------------------------------------------------------

const [, , sub, ...rest] = process.argv;
const args = parseArgs(rest);
try {
  switch (sub) {
    case 'parse':
      cmdParse(args, false);
      break;
    case 'pending':
      cmdParse(args, true);
      break;
    case 'record':
      cmdRecord(args);
      break;
    case 'apply':
      cmdApply(args);
      break;
    case 'check-diff':
      cmdCheckDiff(args);
      break;
    default:
      fail(`неизвестная подкоманда: ${sub || '(нет)'}. См. шапку tms-cases.mjs.`);
  }
} catch (e) {
  fail(String(e && e.message ? e.message : e));
}
