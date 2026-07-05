---
description: Инициализирует рабочий репозиторий conveyor — settings.json, .env.example, tasks/FE и tasks/BE, .gitignore; проверяет ссылки на репозитории. Запускать при настройке нового рабочего репозитория команды.
---

Этап конвейера conveyor: инициализация (setup создаёт конфигурацию,
resolve-config на входе не нужен). Соблюдай правила защиты из QWEN.md
(git — только через git-ops.mjs; перед записью — guard-writes.mjs).

Выполни ТОЧНО `${CONVEYOR_ROOT}/core/stages/setup.md`. Агент не требуется.
