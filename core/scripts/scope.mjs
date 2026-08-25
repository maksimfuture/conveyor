#!/usr/bin/env node
// scope.mjs — рабочая область этапа (защита от «гуляния» агентов по репо).
//
// Скилл/команда вызывает `set` ПОСЛЕ определения этапа и типа задачи и
// `clear` при завершении этапа. Пока scope активен, guard-writes/guard-bash
// разрешают запись в рабочие копии ТОЛЬКО перечисленных репозиториев
// (артефакты в tasks/ и системный temp разрешены всегда).
//
// Usage:
//   node scope.mjs set --stage <имя> --type FE|BE|FE-BE [--task TASK-ID]
//                      [--write id1,id2|none]     # override; иначе по этапу
//
// --write принимает id ЮНИТОВ (рабочих копий): frontend, systemsAnalysis,
// autoTest, backend.core, backend.api, … Ключ группы («backend») не
// принимается: на /implement-plan область записи — это репозитории, которые
// назвал plan.md, а не «весь бэкенд». Список только СУЖАЕТ права этапа: id
// вне кодовой базы этапа и типа задачи отвергается — иначе содержимое
// артефакта (plan.md) решало бы, куда плагину можно писать.
//   node scope.mjs set --stage intent --task INTENT-ID   # этап без типа
//   node scope.mjs clear
//   node scope.mjs show
//
// --type обязателен у set: на implement-plan область записи считается по нему
// (BE → backend, иначе frontend), и пропуск молча отдал бы BE-задаче frontend.
// Единственное исключение — этапы из STAGES_WITHOUT_TASK_TYPE (intent): типа
// задачи там не существует, он появляется только на спецификации. У них --type
// не просто необязателен, а ЗАПРЕЩЁН: принятый «FE» записал бы в область
// выдумку и скрыл бы, что строку скопировали с соседнего этапа. Для FE-BE-пары
// в create-specification передавайте FE-BE, --task — TASK-ID FE-задачи.
// Повторный set перезаписывает область.
//
// Output: JSON { ok, scope? } on stdout. Exit 0/1.

import fs from 'node:fs';
import path from 'node:path';
import {
  readConfig,
  readScopeState,
  stageWriteRepoKeys,
  repoRootFor,
  expandKeys,
  unitIds,
  REPO_KEYS,
  STAGE_NAMES,
  STAGES_WITHOUT_TASK_TYPE,
  scopeFilePath,
  LEGACY_SCOPE_FILE,
} from './lib/config.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function done(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(obj.ok === false ? 1 : 0);
}

const [, , sub, ...rest] = process.argv;
const args = parseArgs(rest);

// Все флаги scope.mjs принимают значение. Флаг без значения парсер отдаёт как
// true, а незакавыченная пустая подстановка приходит как ''. Молча взять
// дефолт нельзя ни у одного из них: `--write` вернул бы фазе B спецификации
// запись в анализ, а `--type --task TASK-9` дал бы BE-задаче область frontend
// вместо backend — ровно то, от чего область и защищает.
const FLAG_VALUE_HINT = {
  stage: 'имя этапа',
  type: 'FE, BE или FE-BE',
  task: 'TASK-ID',
  write: 'список id рабочих копий (backend.api,backend.core) или none',
};
// Командную строку набирает модель по шаблону этапа, поэтому опечатка в ИМЕНИ
// флага — рядовое событие, а не экзотика. Неизвестное имя со значением раньше
// проходило молча: `--tpye BE` терял тип и открывал BE-задаче запись во
// frontend, а выдуманный `--no-write true` не отменял ничего. Флаги принимает
// только `set`; clear и show не принимают ни одного.
const allowedFlags = sub === 'set' ? Object.keys(FLAG_VALUE_HINT) : [];
for (const [key, value] of Object.entries(args)) {
  if (key === '_') continue;
  if (!allowedFlags.includes(key)) {
    const allowed = allowedFlags.length
      ? `Допустимые: ${allowedFlags.map((k) => `--${k}`).join(', ')}`
      : `Подкоманда ${sub || '(нет)'} флагов не принимает`;
    done({ ok: false, error: `неизвестный флаг «--${key}». ${allowed}` });
  }
  if (typeof value !== 'string' || value.trim() === '') {
    done({ ok: false, error: `--${key} требует значение (${FLAG_VALUE_HINT[key]})` });
  }
}
// Токен без двух дефисов парсер складывал в args._, который никто не читает, —
// тот же тихий отказ, что и у неизвестного флага: `-write none` (потерянный
// дефис) оставлял фазе B запись в анализ, а `--write frontend, backend`
// (пробел в списке) выбрасывал backend. Позиционных аргументов не принимает
// ни одна подкоманда.
if (args._.length) {
  done({
    ok: false,
    error: `лишний аргумент «${args._[0]}»: set|clear|show принимают только флаги (имя флага — через два дефиса, список --write — без пробелов)`,
  });
}

const cfg = readConfig(process.cwd());
if (!cfg.found) done({ ok: false, error: 'не найден рабочий репозиторий conveyor (settings.json)' });
// Нечитаемый settings.json — не повод молча выдать область с ПУСТЫМИ правами:
// этап решил бы, что защита стоит, а на деле у него нет ни одного разрешённого
// корня, и первая же запись упрётся в отказ без объяснимой причины.
if (cfg.error) {
  done({ ok: false, error: `${cfg.error} — почините settings.json или запустите /conveyor:setup` });
}

// Файл области — в системном temp (ключ от пути workspace): при локальных
// ссылках рабочий репозиторий не трогается вовсе.
const scopePath = scopeFilePath(cfg.workspaceRoot);

if (sub === 'set') {
  if (!args.stage) done({ ok: false, error: 'set: требуется --stage <имя этапа>' });
  if (!STAGE_NAMES.includes(args.stage)) {
    done({ ok: false, error: `неизвестный этап «${args.stage}». Допустимые: ${STAGE_NAMES.join(', ')}` });
  }
  // Тип обязателен (см. шапку): без него область этапа implement-plan
  // считалась бы по умолчанию и BE-задача получила бы запись во frontend.
  // У этапов без типа задачи (intent) он, наоборот, запрещён — там ещё нечему
  // быть FE или BE, и принятое значение было бы выдумкой в области.
  const typeless = STAGES_WITHOUT_TASK_TYPE.includes(args.stage);
  if (typeless && typeof args.type === 'string') {
    done({ ok: false, error: `этап «${args.stage}» типа задачи не имеет: уберите --type` });
  }
  if (!typeless && typeof args.type !== 'string') {
    done({ ok: false, error: 'set: требуется --type FE|BE|FE-BE' });
  }
  // Нормализуем тип: FE | BE | FE-BE (регистронезависимо); иное — ошибка.
  const taskType = typeless ? null : args.type.trim().toUpperCase();
  if (!typeless && !['FE', 'BE', 'FE-BE'].includes(taskType)) {
    done({ ok: false, error: `неизвестный тип «${args.type}». Допустимые: FE, BE, FE-BE` });
  }
  let writeRepos;
  if (args.write === 'none') {
    writeRepos = []; // явный запрет записи в репозитории (фаза B спецификации)
  } else if (typeof args.write === 'string') {
    writeRepos = args.write.split(',').map((s) => s.trim()).filter(Boolean);
    // Список из одних разделителей — тоже потерянное значение: запрет записи
    // объявляется только словом none.
    if (!writeRepos.length) done({ ok: false, error: '--write: пустой список (для запрета записи используйте none)' });
    // Список сверяется с ФАКТИЧЕСКИМИ юнитами конфигурации, а не с константой:
    // состав частей бэкенда задаёт settings.json команды.
    const known = unitIds(cfg);
    const bad = writeRepos.filter((k) => !known.includes(k));
    if (bad.length) {
      // Отдельная подсказка на самую частую ошибку: ключ ГРУППЫ вместо её
      // частей. Молча пропустить нельзя — этап получил бы область, не
      // покрывающую ни одной рабочей копии, и упёрся бы в отказ guard'а на
      // первой же записи, без объяснимой причины.
      const groups = bad.filter((k) => REPO_KEYS.includes(k) && known.some((id) => id.startsWith(k + '.')));
      const hints = groups.map(
        (k) => `«${k}» — группа репозиториев; укажите её части: ${known.filter((id) => id.startsWith(k + '.')).join(', ')}`,
      );
      done({
        ok: false,
        error:
          `неизвестные репозитории: ${bad.join(', ')}. ` +
          (hints.length ? hints.join('; ') + '. ' : '') +
          `Допустимые: ${known.join(', ')}`,
      });
    }
    // Явный список СУЖАЕТ права этапа, а не выдаёт новые. Этап передаёт его,
    // прочитав plan.md, — то есть содержимое артефакта решало бы, куда можно
    // писать. Без этой проверки план FE-задачи с забытой строкой-образцом
    // («backend.core») открывал бы себе запись в бэкенд, и ни одна проверка
    // ниже по течению этого бы не заметила: id существует, guard такую область
    // исполнит буквально. Разрешённое множество считает ядро — по этапу и типу
    // задачи.
    const allowed = expandKeys(cfg, stageWriteRepoKeys(args.stage, taskType));
    const outside = writeRepos.filter((k) => !allowed.includes(k));
    if (outside.length) {
      done({
        ok: false,
        error:
          `репозитории вне кодовой базы этапа: ${outside.join(', ')}. ` +
          `На этапе «${args.stage}» задача типа ${taskType || '—'} пишет только в: ` +
          `${allowed.length ? allowed.join(', ') : 'артефакты задачи (--write none)'}`,
      });
    }
  } else {
    // Дефолт этапа — ключи верхнего уровня; до рабочих копий их доводит
    // expandKeys (BE → все части бэкенда). На /implement-plan этот дефолт
    // перекрывается явным --write из plan.md.
    writeRepos = expandKeys(cfg, stageWriteRepoKeys(args.stage, taskType));
  }
  const scope = {
    stage: args.stage,
    taskId: args.task || null,
    taskType,
    writeRepos,
    writeRoots: writeRepos.map((k) => repoRootFor(cfg, k)).filter(Boolean),
    setAt: new Date().toISOString(),
  };
  fs.writeFileSync(scopePath, JSON.stringify(scope, null, 2) + '\n');
  done({ ok: true, scope, path: scopePath });
} else if (sub === 'clear') {
  try {
    fs.unlinkSync(scopePath);
  } catch {
    /* absent — уже чисто */
  }
  // Легаси-уборка (scope раньше жил в .cache/): убрать старый файл и
  // пустые каталоги .cache/repos и .cache.
  try {
    fs.unlinkSync(path.join(cfg.workspaceRoot, LEGACY_SCOPE_FILE));
  } catch {
    /* отсутствует */
  }
  for (const d of [
    path.join(cfg.workspaceRoot, '.cache', 'repos'),
    path.join(cfg.workspaceRoot, '.cache'),
  ]) {
    try {
      fs.rmdirSync(d); // удаляет ТОЛЬКО пустой каталог, иначе бросает
    } catch {
      /* не пустой (клоны) или отсутствует — оставляем */
    }
  }
  done({ ok: true, cleared: true });
} else if (sub === 'show') {
  done({ ok: true, ...readScopeState(cfg.workspaceRoot) });
} else {
  done({ ok: false, error: `неизвестная подкоманда: ${sub || '(нет)'} (set|clear|show)` });
}
