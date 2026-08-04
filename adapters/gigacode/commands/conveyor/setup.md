---
description: Инициализирует рабочий репозиторий conveyor — settings.json, .env.example, tasks/FE, tasks/BE, intents/, repos/, .gitignore — и диагностирует рабочие копии в repos/ (repos-status). Запускать при настройке нового рабочего репозитория команды и после его клонирования каждым разработчиком.
---

Этап конвейера conveyor: инициализация (setup создаёт конфигурацию,
resolve-config на входе не нужен). Соблюдай правила защиты из QWEN.md
(git — только через git-ops.mjs; перед записью — guard-writes.mjs).

Выполни ТОЧНО `${CONVEYOR_ROOT}/core/stages/setup.md`. Агент не требуется.
