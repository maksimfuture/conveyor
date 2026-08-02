#!/usr/bin/env node
// scope.mjs — рабочая область этапа (защита от «гуляния» агентов по репо).
//
// Скилл/команда вызывает `set` ПОСЛЕ определения этапа и типа задачи и
// `clear` при завершении этапа. Пока scope активен, guard-writes/guard-bash
// разрешают запись в рабочие копии ТОЛЬКО перечисленных репозиториев
// (артефакты в tasks/ и системный temp разрешены всегда).
//
// Usage:
//   node scope.mjs set --stage <имя> [--type FE|BE|FE-BE] [--task TASK-ID]
//                      [--write key1,key2|none]   # override; иначе по этапу
//   node scope.mjs clear
//   node scope.mjs show
//
// --type опционален (для create-specification FE-BE-пары передавайте FE-BE
// или опускайте — на область записи это не влияет; --task для пары — TASK-ID
// FE-задачи). Повторный set просто перезаписывает область.
//
// Output: JSON { ok, scope? } on stdout. Exit 0/1.

import fs from 'node:fs';
import path from 'node:path';
import {
  readConfig,
  readScopeState,
  stageWriteRepoKeys,
  repoRootFor,
  REPO_KEYS,
  STAGE_NAMES,
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
  write: 'список ключей или none',
};
for (const [key, value] of Object.entries(args)) {
  if (key === '_') continue;
  if (typeof value !== 'string' || value.trim() === '') {
    const hint = FLAG_VALUE_HINT[key] ? ` (${FLAG_VALUE_HINT[key]})` : '';
    done({ ok: false, error: `--${key} требует значение${hint}` });
  }
}

const cfg = readConfig(process.cwd());
if (!cfg.found) done({ ok: false, error: 'не найден рабочий репозиторий conveyor (settings.json)' });

// Файл области — в системном temp (ключ от пути workspace): при локальных
// ссылках рабочий репозиторий не трогается вовсе.
const scopePath = scopeFilePath(cfg.workspaceRoot);

if (sub === 'set') {
  if (!args.stage) done({ ok: false, error: 'set: требуется --stage <имя этапа>' });
  if (!STAGE_NAMES.includes(args.stage)) {
    done({ ok: false, error: `неизвестный этап «${args.stage}». Допустимые: ${STAGE_NAMES.join(', ')}` });
  }
  // Нормализуем тип: FE | BE | FE-BE (регистронезависимо); иное — ошибка.
  let taskType = null;
  if (typeof args.type === 'string') {
    const t = args.type.trim().toUpperCase();
    if (!['FE', 'BE', 'FE-BE'].includes(t)) {
      done({ ok: false, error: `неизвестный тип «${args.type}». Допустимые: FE, BE, FE-BE` });
    }
    taskType = t;
  }
  let writeRepos;
  if (args.write === 'none') {
    writeRepos = []; // явный запрет записи в репозитории (фаза B спецификации)
  } else if (typeof args.write === 'string') {
    writeRepos = args.write.split(',').map((s) => s.trim()).filter(Boolean);
    // Список из одних разделителей — тоже потерянное значение: запрет записи
    // объявляется только словом none.
    if (!writeRepos.length) done({ ok: false, error: '--write: пустой список (для запрета записи используйте none)' });
    const bad = writeRepos.filter((k) => !REPO_KEYS.includes(k));
    if (bad.length) done({ ok: false, error: `неизвестные репозитории: ${bad.join(', ')}` });
  } else {
    writeRepos = stageWriteRepoKeys(args.stage, taskType);
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
