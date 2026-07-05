# conveyor

Плагин командной разработки для **Claude Code** и **GigaCode CLI**.
Проводит задачу по конвейеру через четыре репозитория:

```
системный анализ → фича → спецификация → план → реализация
                 → требования к автотестам → автотесты
```

Каждый этап — отдельная команда; тяжёлую работу выполняют ролевые агенты
(системный аналитик, фронтенд/бэкенд-разработчик, инженер по автотестам).
После производящих этапов включается **цикл ревью**: агент-ревьюер ищет
замечания, автор спорит и исправляет (см. ниже).

## Архитектура

Ядро (вся логика) + тонкий адаптер платформы:

```
conveyor/
├── core/                 # ядро без платформенных зависимостей (Node.js, git, ФС)
│   ├── prompts/          #   промпты ролей
│   ├── stages/           #   алгоритмы этапов (+ _common.md)
│   ├── templates/        #   шаблоны артефактов и конфигурации
│   └── scripts/          #   resolve-config, validate-config, guard-*, git-ops
├── adapters/
│   ├── claude-code/      #   плагин Claude Code (skills, agents, hooks)
│   └── gigacode/         #   расширение GigaCode CLI (gigacode-extension.json)
└── scripts/build.mjs     # сборка dist/claude-code и dist/gigacode
```

Правило: `core/` не зависит от платформы, вся специфика — в адаптерах;
новую платформу добавляет ещё один адаптер, не трогая `core/`.

## Установка

Пошаговая инструкция (обе среды + устранение проблем) — в [INSTALL.md](INSTALL.md).
Кратко:

```
node scripts/build.mjs      # собирает dist/claude-code и dist/gigacode
node scripts/check.mjs       # самопроверка (JSON, соответствия, guard-скрипты)
```

- **Claude Code:** используйте `dist/claude-code/` как плагин (внутри —
  `.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `core/`).
- **GigaCode CLI:** установите штатной командой
  `gigacode extensions install dist/gigacode` (подтвердите
  security-предупреждение), затем `gigacode` — команды `/conveyor:*`
  появятся (`gigacode extensions list`). Ручное `cp -r` НЕ регистрирует
  расширение. Манифест — `gigacode-extension.json` (иное имя GigaCode молча
  пропускает). Подробности — `adapters/gigacode/README.md`.

Требуется Node.js ≥ 14 и git в PATH.

## Команды

| Команда | Кто запускает | Что делает |
|---|---|---|
| `/setup` | тимлид | инициализация рабочего репозитория |
| `/create-feature` | аналитик | внести требования в анализ, завести фичу |
| `/create-specification` | аналитик | спецификация по диффу анализа |
| `/create-plan` | разработчик | план реализации по коду |
| `/implement-plan` | разработчик | реализация в ветке задачи |
| `/create-requirements-auto-test` | разработчик | требования к автотестам |
| `/implement-auto-test` | тестировщик | реализация автотестов |
| `/task-status` | любой | сводка по задачам |

Имена `setup`/`task-status` выбраны вместо `init`/`status`, чтобы не
конфликтовать со встроенными командами Claude Code.

## Конфигурация

`/setup` создаёт `settings.json` (значения ссылок берутся из `.env` через
`${VAR}`) и `.env.example`:

```json
{
  "taskPrefix": "TASK",
  "repos": {
    "systemsAnalysis": { "link": "${SYSTEMS_ANALYSIS_REPO}", "mainBranch": "${SYSTEMS_ANALYSIS_MAIN_BRANCH}" },
    "frontend":        { "link": "${FRONTEND_REPO}",         "mainBranch": "${FRONTEND_MAIN_BRANCH}" },
    "backend":         { "link": "${BACKEND_REPO}",          "mainBranch": "${BACKEND_MAIN_BRANCH}" },
    "autoTest":        { "link": "${AUTOTEST_REPO}",         "mainBranch": "${AUTOTEST_MAIN_BRANCH}" }
  },
  "repoCache": "${CONVEYOR_REPO_CACHE}",
  "reviewRounds": "${CONVEYOR_REVIEW_ROUNDS}",
  "language": "ru"
}
```

- **Ссылки** — локальный путь (по умолчанию) или git-URL. git-URL требует
  `CONVEYOR_REPO_CACHE=true` (тогда репозиторий клонируется в `.cache/repos/`).
- **Основная ветка** каждого репозитория — из env
  (`SYSTEMS_ANALYSIS_MAIN_BRANCH`, `FRONTEND_MAIN_BRANCH`, …); пусто = `main`.
- **repoCache** по умолчанию выключен.
- **reviewRounds** — число раундов цикла ревью, из env
  `CONVEYOR_REVIEW_ROUNDS` (пусто = 2 по умолчанию; `0` — ревью выключено).
- Секреты только в `.env` (в `.gitignore`); в `settings.json` открытых
  значений нет.

### Какая конфигурация нужна какой команде

| Команда | Обязательные ссылки |
|---|---|
| setup, task-status | — |
| create-feature, create-specification | systemsAnalysis |
| create-plan, implement-plan, create-requirements-auto-test | frontend/backend (по типу) |
| implement-auto-test | autoTest + frontend/backend (по типу) |

## Защита (guard-хуки)

В Claude Code хуки перехватывают действия модели:

- **SessionStart** → `validate-config.mjs`: предупреждает о незаполненных
  переменных и активных задачах.
- **PreToolUse (Write/Edit/NotebookEdit)** → `guard-writes.mjs`: разрешает
  запись только в рабочий репозиторий, `.cache/`, локальные пути репозиториев
  и системный temp; блокирует открытые секреты в `settings.json`.
- **PreToolUse (Bash)** → `guard-bash.mjs`: блокирует `push --force`, push и
  удаление основной ветки, запись вне корней; `reset --hard`, `clean -f` и
  прочие `push` → запрос подтверждения.

В **GigaCode CLI** перехватчиков нет — те же guard-скрипты вызываются самими
командами (см. `adapters/gigacode/QWEN.md`), а git всегда идёт через
`git-ops.mjs` (в нём нет `push`/`--force`). Это осознанная деградация: там
защита срабатывает только в точках, где команда её вызвала.

## Цикл ревью

После этапов, где агент что-то производит — `/create-feature` (правки
репозитория анализа), `/implement-plan` (код), `/implement-auto-test`
(автотесты) — запускается агент **reviewer**:

1. reviewer формирует замечания (findings) с severity `blocker`/`major`/`minor`
   и обоснованием; проверяет утверждения запуском (тесты, репро, линтеры).
2. Автор отвечает на каждое blocker/major замечание: ACCEPT (исправит) или
   REBUT (с обоснованием).
3. По спорным reviewer один раз пересматривает (снимает или подтверждает).
4. Автор исправляет принятые; по подтверждённым (held) — либо соглашается,
   либо мотивированно остаётся при своём (это нерешённое разногласие). Цикл
   повторяется до `reviewRounds` раундов (по умолчанию 2). reviewer ревьюит
   НЕзакоммиченные изменения рабочего дерева — коммит выполняется после ревью.
5. Переход к следующему этапу блокируют только `blocker`/`major`; нерешённые
   (unresolved) после всех раундов эскалируются пользователю с обеими
   позициями — он решает (исправить / принять как есть / свой вариант).

Итог ревью записывается в раздел «Ревью» артефакта этапа (feature.md /
plan.md / report-auto-test.md) и в `meta.json → stages.<этап>.review`.
Отключается: `reviewRounds: 0`.

## Структура рабочего репозитория

```
<workspace>/
├── settings.json
├── .env / .env.example
├── .cache/repos/                 # клоны git-URL (если repoCache включён)
└── tasks/<FE|BE>/<TASK-ID>/
    ├── meta.json
    ├── feature.md
    ├── specification.md
    ├── plan.md
    ├── requirements-auto-test.md
    └── report-auto-test.md
```