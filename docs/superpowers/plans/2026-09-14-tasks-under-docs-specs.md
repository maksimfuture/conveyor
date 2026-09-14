# Перенос папки задач в `docs/specs/tasks` — план реализации

**Goal:** папка артефактов задач переезжает из корня фасадного репозитория
(`tasks/`) в `docs/specs/tasks/`; `intents/` остаётся в корне.

**Architecture:** путь задан ОДНОЙ константой `TASKS_DIR` в
`core/scripts/lib/config.mjs`, из неё собирается `ARTIFACT_DIRS`. Правила
записи в `checkWrite` переходят с «первого сегмента пути» на «префикс пути»
(`artifactDirOf`) — иначе вложенный путь либо перестаёт проверяться, либо
открывает запись во весь `docs/`. Существующие рабочие репозитории переносит
`migrate-workspace.mjs`; забытую папку в корне называют вслух `validate-config`
(SessionStart) и стейдж `setup` в роли «диагностика».

**Tech Stack:** Node ESM (`.mjs`), без зависимостей; тестовый контур один —
`node scripts/check.mjs`; дистрибутивы — `node scripts/build.mjs`.

**Решения пользователя (2026-09-14), менять нельзя без него:**
1. переезжает ТОЛЬКО `tasks`, `intents/` остаётся в корне;
2. путь зашит в код, ключа в `settings.json` нет;
3. существующие репозитории переносит миграция (`git mv`, иначе `fs.rename`).

---

### Task 1: константа и правила записи

**Files:** Modify `core/scripts/lib/config.mjs:693` (ARTIFACT_DIRS),
`:806-845` (checkWrite).

- [x] Ввести `export const TASKS_DIR = 'docs/specs/tasks';` (POSIX-путь от
      корня workspace) и `export const ARTIFACT_DIRS = [TASKS_DIR, 'intents'];`
- [x] Ввести `artifactDirOf(rel)`: приводит `rel` к POSIX и возвращает элемент
      `ARTIFACT_DIRS`, если `rel` равен ему или лежит ВНУТРИ него; иначе
      `undefined`. Совпадение по сегментам, не по строке: `docs/specs/tasksX`
      не должен считаться папкой задач.
- [x] Перевести на неё три правила `checkWrite`: «в папке артефактов только
      `*.md`/`meta.json`», `allowedTop` (корневые файлы конфигурации + папки
      артефактов) и «только артефакт СВОЕГО этапа».
- [x] `docs/` и `docs/specs/` сами по себе при активном этапе остаются
      запрещёнными к записи: разрешение даёт только попадание внутрь
      `TASKS_DIR`.

### Task 2: скрипты, читающие папку задач

**Files:** Modify `core/scripts/validate-config.mjs:61`,
`core/scripts/migrate-workspace.mjs:222`, комментарии
`core/scripts/scope.mjs:7`, `core/scripts/validate-task-folder.mjs:3`.

- [x] `listActiveTasks` и обход задач в миграции строят путь из `TASKS_DIR`,
      а не из литерала `'tasks'`.

### Task 3: миграция существующих репозиториев

**Files:** Modify `core/scripts/migrate-workspace.mjs` (новый шаг ДО обхода
задач), шапка файла.

- [x] Шаг выполняется, если существует `<ws>/tasks`; иначе тихо пропускается.
- [x] Обе папки существуют → `warnings` и пропуск. Автоматического слияния нет:
      это чужие данные команды.
- [x] Перенос: `git mv` при наличии `<ws>/.git`, при любой его неудаче —
      `fs.renameSync`; целевой `docs/specs` создаётся заранее
      (`mkdirSync(..., { recursive: true })`).
- [x] Ошибка записи идёт в `writeErrors` (как остальные операции) и не
      обрывает миграцию; сухой прогон только печатает запись в `changes`.
- [x] Дальнейший обход задач идёт уже по НОВОМУ пути (шаг стоит выше).

### Task 4: диагностика забытой папки

**Files:** Modify `core/scripts/validate-config.mjs`, `core/stages/setup.md`.

- [x] SessionStart-предупреждение: в корне лежит `tasks/` → назвать новый путь
      и команду миграции.
- [x] Шаг диагностики в `setup.md` — то же самое словами стейджа.

### Task 5: тексты конвейера

**Files:** Modify `core/stages/_common.md`, `create-specification.md`,
`create-autotest-plan.md`, `implement-plan.md`, `intent.md`, `setup.md`,
`task-status.md`, `core/prompts/system-analyst.md`.

- [x] Все упоминания `tasks/...` → `docs/specs/tasks/...`, включая обратный
      индекс `docs/specs/tasks/*/*/meta.json → intentId` и создание структуры
      в `setup` (`docs/specs/tasks/FE`, `docs/specs/tasks/BE`).

### Task 6: адаптеры

**Files:** Modify `adapters/claude-code/skills/{create-specification,setup,
task-status}/SKILL.md`, `adapters/gigacode/commands/conveyor/{create-
specification,setup}.md`, `adapters/gigacode/QWEN.md`.

- [x] Тексты и `description` скиллов/команд называют новый путь.

### Task 7: документация

**Files:** Modify `README.md` (дерево структуры, разделы про защиту),
`INSTALL.md`.

- [x] В дереве структуры `docs/specs/tasks/<FE|BE>/<TASK-ID>/` на месте
      прежней ветки `tasks/`.

### Task 8: проверки

**Files:** Modify `scripts/check.mjs`.

- [x] Заменить хардкод `'tasks/...'` в фикстурах и ожиданиях на новый путь
      (проверки, построенные на `ARTIFACT_DIRS`, переезжают сами).
- [x] Новая проверка: при активном этапе запись в `docs/x.md` и
      `docs/specs/x.md` — deny, а `docs/specs/tasks/FE/TASK-1/plan.md` —
      allow. Без неё переезд мог бы открыть запись во весь `docs/`.
- [x] Новая проверка миграции: `tasks/` в корне переносится в
      `docs/specs/tasks`, а при существующей цели — warning без слияния.

### Task 9: сборка и зелёный контур

- [x] `node scripts/check.mjs` — все проверки зелёные.
- [x] `node scripts/build.mjs` — оба дистрибутива собираются.
