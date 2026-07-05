---
description: Реализует задачу в кодовой базе по плану в отдельной ветке, прогоняет тесты и линтеры, затем цикл ревью. Запускать после create-plan. Аргумент TASK-ID.
---

Этап конвейера conveyor: implement. Действуй по общему протоколу из QWEN.md
(особенно правила защиты: git — через git-ops.mjs, push — только по
подтверждению), затем выполни ТОЧНО `${CONVEYOR_ROOT}/core/stages/implement-plan.md`.

Агент по типу задачи: frontend-developer или backend-developer. Затем цикл
ревью (домен frontend/backend) с агентом reviewer — core/stages/_review-loop.md.
