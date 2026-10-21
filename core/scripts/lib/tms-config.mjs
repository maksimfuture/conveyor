// tms-config.mjs — конвенции тест-кейсов команды в Zephyr Scale.
//
// В плагине их НЕТ: названия кастомных полей, их значения, префикс названия,
// «Команда», «АС» — это настройка проекта Zephyr у конкретной команды, а не
// механика конвейера. Они лежат в репозитории автотестов, в
// `.conveyor/tms.json`: это зона QA — конвенции меняют тестировщики своим MR,
// рядом с тестами и их @TmsLink. Образец с заглушками —
// core/templates/tms.example.json.
//
// Плагин отдаёт по каждому кейсу СМЫСЛОВЫЕ признаки в своём словаре, а файл
// говорит, как они называются в Zephyr команды:
//   kind      — «Вид тестирования» плана: НФ | Регресс;
//   automated — состояние автотеста: done (строка в «Автотестах» с [x]),
//               planned (строка есть, [ ]), no (автотеста нет);
//   level     — «Уровень» плана (API, DB, UI, …; регистр не важен).
//
// Схема:
//   {
//     "namePrefix": "…",                       — префикс названия кейса
//     "priority": "…", "status": "…",          — новых кейсов
//     "fields": {
//       "kind":      { "name": "…", "values": { "НФ": "…", "Регресс": "…" } },
//       "automated": { "name": "…", "values": { "done": "…", "planned": "…", "no": "…" } },
//       "level":     { "name": "…", "values": { "API": "…", … } }
//     },
//     "constantFields":   { "<поле>": "<значение>", … },          — у всех кейсов
//     "fieldsByTaskType": { "FE": { "<поле>": "…" }, "BE": { … } } — по типу задачи
//   }

import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './config.mjs';

// Путь — соглашение, а не настройка: этап и так открывает рабочую копию
// автотестов, и ключ в settings.json ради одного пути был бы лишним.
export const TMS_CONFIG_PATH = '.conveyor/tms.json';
export const TMS_CONFIG_EXAMPLE = 'core/templates/tms.example.json';

const TOP_KEYS = ['namePrefix', 'priority', 'status', 'fields', 'constantFields', 'fieldsByTaskType'];
const TASK_TYPES = ['FE', 'BE'];
// Смысловые признаки и обязательные ключи их значений. У level состав
// задаёт команда — какие уровни у неё вообще бывают.
const SEMANTIC = {
  kind: ['НФ', 'Регресс'],
  automated: ['done', 'planned', 'no'],
  level: null,
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Незаполненный образец: `<команда в Zephyr>`. Такое значение ушло бы в
// Zephyr буквально — лучше остановиться и назвать поле.
const UNFILLED = /<[^>]+>/;

export function validateTmsConfig(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { config: null, errors: ['файл должен содержать JSON-объект'] };

  const str = (v, where, { required = false, allowEmpty = false } = {}) => {
    if (v === undefined || v === null) {
      if (required) errors.push(`${where}: обязательное поле`);
      return null;
    }
    if (typeof v !== 'string') {
      errors.push(`${where}: нужна строка, задано ${JSON.stringify(v)}`);
      return null;
    }
    if (!allowEmpty && !v.trim()) {
      errors.push(`${where}: пустая строка`);
      return null;
    }
    if (UNFILLED.test(v)) errors.push(`${where}: не заполнено «${v}» — значение из образца`);
    return v;
  };
  const stringMap = (v, where) => {
    if (v === undefined) return {};
    if (!isPlainObject(v)) {
      errors.push(`${where}: нужен объект «поле → значение»`);
      return {};
    }
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (UNFILLED.test(k)) errors.push(`${where}: не заполнено имя поля «${k}» — значение из образца`);
      const s = str(val, `${where}.${k}`);
      if (s !== null) out[k] = s;
    }
    return out;
  };

  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k)) errors.push(`${k}: неизвестный ключ (допустимы: ${TOP_KEYS.join(', ')})`);
  }

  const config = {
    namePrefix: str(raw.namePrefix, 'namePrefix', { allowEmpty: true }) || '',
    priority: str(raw.priority, 'priority'),
    status: str(raw.status, 'status'),
    fields: {},
    constantFields: stringMap(raw.constantFields, 'constantFields'),
    fieldsByTaskType: {},
  };

  if (!isPlainObject(raw.fields)) errors.push('fields: обязательный объект (kind, automated, level)');
  const fields = isPlainObject(raw.fields) ? raw.fields : {};
  for (const k of Object.keys(fields)) {
    if (!(k in SEMANTIC)) errors.push(`fields.${k}: неизвестный признак (допустимы: ${Object.keys(SEMANTIC).join(', ')})`);
  }
  for (const [sem, required] of Object.entries(SEMANTIC)) {
    const f = fields[sem];
    if (!isPlainObject(f)) {
      if (isPlainObject(raw.fields)) errors.push(`fields.${sem}: обязательный объект { name, values }`);
      continue;
    }
    const name = str(f.name, `fields.${sem}.name`, { required: true });
    const values = stringMap(f.values, `fields.${sem}.values`);
    if (required) {
      for (const key of required) if (!(key in values)) errors.push(`fields.${sem}.values.${key}: нет значения`);
    } else if (!Object.keys(values).length) errors.push(`fields.${sem}.values: нужен хотя бы один уровень`);
    // Уровень в плане пишут как угодно (`api`, `API`) — ключи сравниваем без регистра.
    const norm = sem === 'level' ? Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v])) : values;
    config.fields[sem] = { name, values: norm };
  }

  if (raw.fieldsByTaskType !== undefined) {
    if (!isPlainObject(raw.fieldsByTaskType)) errors.push('fieldsByTaskType: нужен объект { FE: {…}, BE: {…} }');
    else
      for (const [t, v] of Object.entries(raw.fieldsByTaskType)) {
        if (!TASK_TYPES.includes(t)) errors.push(`fieldsByTaskType.${t}: неизвестный тип задачи (допустимы FE, BE)`);
        else config.fieldsByTaskType[t] = stringMap(v, `fieldsByTaskType.${t}`);
      }
  }

  // Одно поле из двух источников — второе молча затёрло бы первое.
  const own = Object.values(config.fields).map((f) => f.name).filter(Boolean);
  for (const t of TASK_TYPES) {
    const names = [...own, ...Object.keys(config.constantFields), ...Object.keys(config.fieldsByTaskType[t] || {})];
    const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dup.length) errors.push(`поле задано дважды (${t}): ${dup.join(', ')}`);
  }

  return { config: errors.length ? null : config, errors: [...new Set(errors)] };
}

// { path, found, config, errors } — config только у валидного файла.
export function readTmsConfig(repoRoot) {
  const file = path.join(repoRoot, ...TMS_CONFIG_PATH.split('/'));
  if (!fs.existsSync(file)) return { path: file, found: false, config: null, errors: [] };
  let raw;
  try {
    raw = readJsonFile(file);
  } catch (e) {
    return { path: file, found: true, config: null, errors: [`не разбирается как JSON: ${e.message}`] };
  }
  return { path: file, found: true, ...validateTmsConfig(raw) };
}
