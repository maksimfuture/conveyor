---
description: Реализует автотесты в репозитории автотестов по плану автотестов, запускает их, затем цикл ревью. Запускать после create-autotest-plan. Аргумент TASK-ID.
---

Этап конвейера conveyor: implement-auto-test. Действуй по общему протоколу из
QWEN.md (правила защиты: git — через git-ops.mjs, push — по подтверждению),
затем выполни ТОЧНО `${CONVEYOR_ROOT}/core/stages/implement-auto-test.md`.

Агент: qa-autotest-engineer. Затем цикл ревью (домен autotests) с агентом
reviewer — core/stages/_review-loop.md.
