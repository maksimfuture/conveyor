---
name: create-plan
description: Составляет план реализации (plan.md) по спецификации, анализируя кодовую базу. Запускать после /create-specification, когда разработчику нужен пошаговый план с привязкой к файлам и покрытием REQ-ID. Выбирает агента (frontend/backend) и репозиторий по типу задачи. Аргумент TASK-ID.
---

Этап конвейера conveyor: план реализации.
**Агент:** frontend-developer или backend-developer (по типу задачи).
**Предусловие:** есть specification.md.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-plan.md`.

Кратко:
1. resolve-config; тип задачи из meta.json → агент + кодовая база. Установи
   рабочую область: `scope.mjs set --stage create-plan --type <FE|BE> --task
   <TASK-ID>` (запись в репо запрещена); `clear` при завершении.
2. Найди и обнови рабочую копию кода (`git-ops locate` + `update --mode read`).
3. Запусти агента-разработчика → plan.md (core/templates/plan.md); каждый шаг
   привязан к файлам и REQ-ID.
4. Валидируй покрытие REQ-ID (непокрытые → один возврат агенту, затем показать
   пользователю). Обнови meta.json (stages.plan.done). Следующий шаг —
   /implement-plan.
