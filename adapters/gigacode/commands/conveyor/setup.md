---
description: Инициализирует рабочий репозиторий conveyor — settings.json, .env.example, tasks/FE, tasks/BE, intents/, repos/, .gitignore — и диагностирует рабочие копии в repos/ (repos-status). Запускать при настройке нового рабочего репозитория команды и после его клонирования каждым разработчиком.
---

**Шаг 0. Корень расширения.** Файлы этапа и скрипты лежат в каталоге установки
расширения — ВНЕ текущего проекта. Определи его абсолютный путь:
`node -e "const o=require('os'),f=require('fs'),d=(o.homedir()+'/.gigacode/extensions/conveyor').split(String.fromCharCode(92)).join('/');console.log(f.existsSync(d+'/core/stages/_common.md')?d:'NOT_FOUND')"`
Напечатанный путь — это `<CONVEYOR_ROOT>`: подставляй его БУКВАЛЬНО вместо
плейсхолдера во всех путях и командах ниже. Переменной окружения с таким
именем нет — `$` с фигурными скобками раскроется в пустоту. Напечатано
`NOT_FOUND` — останови этап и спроси у пользователя каталог, куда
`gigacode extensions install` поставил conveyor: гадать и искать по диску
нельзя. Если файловый инструмент ограничен каталогом проекта и
файлы этапа не читает — читай их оболочкой:
`cat "<CONVEYOR_ROOT>/core/stages/_common.md"`.

Этап конвейера conveyor: инициализация (setup создаёт конфигурацию,
resolve-config на входе не нужен). Соблюдай правила защиты из QWEN.md
(git — только через git-ops.mjs; перед записью — guard-writes.mjs).

Выполни ТОЧНО `<CONVEYOR_ROOT>/core/stages/setup.md`. Агент не требуется.
