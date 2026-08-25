---
description: Вносит требования из intent в репозиторий системного анализа (ветка INTENT-analysis) и собирает specification.md по диффу этих правок. Второй шаг конвейера, после /conveyor:intent. Аргументы `INTENT-ID | TASK-ID [FE|BE|FE-BE] [номер]`: INTENT-ID заводит новую задачу, TASK-ID продолжает уже заведённую.
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

Этап конвейера conveyor: create-specification. Действуй по общему протоколу
из QWEN.md (resolve-config → правила защиты → субагенты), затем выполни
ТОЧНО `<CONVEYOR_ROOT>/core/stages/create-specification.md`.

Агент: system-analyst (core/prompts/system-analyst.md). Этап идёт в две фазы;
после фазы A — цикл ревью (домен systems-analysis) с агентом reviewer, см.
core/stages/_review-loop.md.

Первый аргумент опознавай по файлам: `tasks/<FE|BE>/<аргумент>/meta.json` —
это TASK-ID (продолжение задачи, тип и номер не спрашиваются),
`intents/<аргумент>/intent.md` — это INTENT-ID (новая задача). Задачу,
мигрированную с 1.x (`intentId: null`), продолжают только по TASK-ID.
