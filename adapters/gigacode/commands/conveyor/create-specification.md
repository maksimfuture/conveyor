---
description: Вносит требования из intent в репозиторий системного анализа (ветка INTENT-analysis) и собирает specification.md по диффу этих правок. Второй шаг конвейера, после /conveyor:intent. Аргументы `INTENT-ID | TASK-ID [FE|BE|FE-BE] [номер]`: INTENT-ID заводит новую задачу, TASK-ID продолжает уже заведённую.
---

Этап конвейера conveyor: create-specification. Действуй по общему протоколу
из QWEN.md (resolve-config → правила защиты → субагенты), затем выполни
ТОЧНО `${CONVEYOR_ROOT}/core/stages/create-specification.md`.

Агент: system-analyst (core/prompts/system-analyst.md). Этап идёт в две фазы;
после фазы A — цикл ревью (домен systems-analysis) с агентом reviewer, см.
core/stages/_review-loop.md.

Первый аргумент опознавай по файлам: `tasks/<FE|BE>/<аргумент>/meta.json` —
это TASK-ID (продолжение задачи, тип и номер не спрашиваются),
`intents/<аргумент>/intent.md` — это INTENT-ID (новая задача). Задачу,
мигрированную с 1.x (`intentId: null`), продолжают только по TASK-ID.
