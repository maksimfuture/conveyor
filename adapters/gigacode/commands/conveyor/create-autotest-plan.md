---
description: Составляет план автотестов по спецификации задачи (тест-кейсы TC-N с трассировкой на REQ-N). Контекст — репозиторий автотестов (только чтение); кодовая база не открывается. Запускать после implement-plan. Аргумент TASK-ID.
---

Этап конвейера conveyor: create-autotest-plan. Действуй по общему протоколу
из QWEN.md (resolve-config → правила защиты → субагенты), затем выполни
ТОЧНО `${CONVEYOR_ROOT}/core/stages/create-autotest-plan.md`.

Агент: qa-autotest-engineer (core/prompts/qa-autotest-engineer.md). Цикл
ревью на этом этапе НЕ запускается.
