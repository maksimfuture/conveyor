---
description: Составляет план реализации (plan.md) по спецификации, анализируя кодовую базу; привязка шагов к файлам и покрытие REQ-ID. Запускать после create-specification. Аргумент TASK-ID.
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

Этап конвейера conveyor: create-plan. Действуй по общему протоколу из QWEN.md,
затем выполни ТОЧНО `<CONVEYOR_ROOT>/core/stages/create-plan.md`.

Агент по типу задачи: frontend-developer или backend-developer
(core/prompts/<агент>.md).
