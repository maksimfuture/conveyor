---
name: implement
description: Реализует задачу в кодовой базе по плану (plan.md) в отдельной ветке. Запускать после /create-plan, когда разработчик готов писать код. Создаёт ветку задачи, реализует шаги плана, прогоняет тесты и линтеры, коммитит. Аргумент TASK-ID.
---

Этап конвейера conveyor: реализация.
**Агент:** frontend-developer или backend-developer (по типу задачи).
**Предусловие:** есть plan.md.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/implement-plan.md`.

Кратко:
1. resolve-config; тип из meta.json → агент + кодовая база. Проверь чистоту
   working tree (`git-ops clean-check`), грязная → стоп.
2. Обнови (`update --mode write`); создай ветку `<TASK-ID>-<slug>`
   (`git-ops branch`), запиши implementBranch. Повторный запуск — продолжай
   существующую ветку.
3. Запусти агента: реализация строго по plan.md, отметки чекбоксов, прогон
   тестов/линтеров, отклонения — в plan.md.
4. Цикл ревью (core/stages/_review-loop.md, домен frontend/backend): агент
   reviewer находит замечания, разработчик спорит и исправляет (2 раунда по
   умолчанию; нерешённые blocker/major → эскалация).
5. Скилл коммитит финальные изменения в ветку задачи (push/MR — по
   подтверждению + permission-prompt guard-хука). Обнови meta.json
   (stages.implement-plan.done + review). Напечатай итог. Следующий шаг —
   /create-requirements-auto-test.
