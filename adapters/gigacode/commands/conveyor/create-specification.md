---
description: Вносит требования из intent в репозиторий системного анализа (ветка INTENT-analysis) и собирает specification.md по диффу этих правок. Второй шаг конвейера, после /conveyor:intent. Аргументы INTENT-ID [FE|BE|FE-BE] [номер].
---

Этап конвейера conveyor: create-specification. Действуй по общему протоколу
из QWEN.md (resolve-config → правила защиты → субагенты), затем выполни
ТОЧНО `${CONVEYOR_ROOT}/core/stages/create-specification.md`.

Агент: system-analyst (core/prompts/system-analyst.md). Этап идёт в две фазы;
после фазы A — цикл ревью (домен systems-analysis) с агентом reviewer, см.
core/stages/_review-loop.md.
