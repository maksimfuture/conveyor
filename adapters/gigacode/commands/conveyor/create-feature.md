---
description: Заводит новую задачу и вносит требования в репозиторий системного анализа (в ветке TASK-analysis), собирает feature.md. Первый шаг работы над фичей (FE, BE или FE-BE).
---

Этап конвейера conveyor: create-feature. Действуй по общему протоколу из
QWEN.md (resolve-config → правила защиты → субагенты), затем выполни ТОЧНО
`${CONVEYOR_ROOT}/core/stages/create-feature.md`.

Агент: system-analyst (core/prompts/system-analyst.md). Затем цикл ревью
(домен systems-analysis) с агентом reviewer — см. core/stages/_review-loop.md.
