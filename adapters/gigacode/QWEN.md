# conveyor — конвейер командной разработки (GigaCode)

Расширение проводит задачу по конвейеру через четыре репозитория (системный
анализ, фронтенд, бэкенд, автотесты). Команды регистрируются как
`/conveyor:*`. Формат расширения — Qwen-совместимый (GigaCode его понимает).

## Общий протокол выполнения команды
`${CONVEYOR_ROOT}` — каталог установки расширения (по умолчанию
`~/.gigacode/extensions/conveyor`). Всё ядро — в `${CONVEYOR_ROOT}/core/`.
Если переменная `CONVEYOR_ROOT` не задана в окружении, подставляй реальный
путь установки при запуске `node`.

Каждая команда (кроме `setup` и `task-status`):
1. Первым делом получает конфигурацию:
   `node "${CONVEYOR_ROOT}/core/scripts/resolve-config.mjs"`. При `found:false`
   — остановись («запустите /conveyor:setup»); при непустом `missingVars`,
   нужном этому этапу, — останови и перечисли переменные.
2. Читает и выполняет ТОЧНО `${CONVEYOR_ROOT}/core/stages/_common.md` и
   `${CONVEYOR_ROOT}/core/stages/<команда>.md`.
3. Роли-агентов (system-analyst, frontend/backend-developer,
   qa-autotest-engineer, reviewer) запускает как СУБАГЕНТОВ с телом промпта из
   `${CONVEYOR_ROOT}/core/prompts/<агент>.md`, передавая контекст в промпте
   (субагент не видит сессию).

## Защита (важно: в GigaCode нет хуков-перехватчиков)
В Claude Code запись и git-операции перехватывают хуки. В GigaCode
перехватчиков нет, поэтому защита исполняется САМОЙ командой:
- **git — только через** `${CONVEYOR_ROOT}/core/scripts/git-ops.mjs` (в нём
  нет `push`/`--force` — они структурно невозможны);
- **перед записью файла** вызывай
  `node "${CONVEYOR_ROOT}/core/scripts/guard-writes.mjs"` с JSON
  `{"cwd":"<рабочий репозиторий>","tool_input":{"file_path":"<путь>"}}` на
  stdin; если ответ `permissionDecision:"deny"` — не пиши, объясни;
- **перед git-командой** аналогично вызывай `guard-bash.mjs` с
  `{"cwd":...,"tool_input":{"command":"<команда>"}}`; `deny` — не выполняй,
  `ask` — спроси подтверждение у пользователя;
- пиши только внутри: рабочего репозитория, `.cache/`, локальных путей
  репозиториев, системного temp;
- `push`/MR — только по явному подтверждению пользователя.

Деградация честная: в Claude Code защита ловит любое действие модели
(независимый перехватчик), в GigaCode — только в точках, где команда сама
вызвала guard-скрипты.

## Команды
| Команда | Кто запускает | Что делает |
|---|---|---|
| `/conveyor:setup` | тимлид | инициализация рабочего репозитория |
| `/conveyor:create-feature` | аналитик | внести требования в анализ, завести фичу |
| `/conveyor:create-specification` | аналитик | спецификация по диффу анализа |
| `/conveyor:create-plan` | разработчик | план реализации по коду |
| `/conveyor:implement-plan` | разработчик | реализация в ветке задачи + ревью |
| `/conveyor:create-requirements-auto-test` | разработчик | требования к автотестам |
| `/conveyor:implement-auto-test` | тестировщик | реализация автотестов + ревью |
| `/conveyor:task-status` | любой | сводка по задачам |

Естественный язык → команда: «настроить/инициализировать» → setup; «завести
фичу/внести требования» → create-feature; «спецификация» →
create-specification; «план» → create-plan; «реализуй/напиши код» →
implement-plan; «требования к тестам» → create-requirements-auto-test; «напиши
автотесты» → implement-auto-test; «статус/сводка задач» → task-status.

## Требования
Node.js ≥ 14 и git в PATH.
