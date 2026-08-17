---
name: implement-auto-test
description: Реализует автотесты в репозитории автотестов по плану автотестов (autotest-plan.md). Запускать после /conveyor:create-autotest-plan, когда тестировщик готов писать автотесты. Создаёт ветку автотестов, реализует кейсы, запускает тесты, пишет отчёт. Аргумент TASK-ID.
---

Этап конвейера conveyor: реализация автотестов.
**Агент:** qa-autotest-engineer. **Предусловие:** есть autotest-plan.md.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/implement-auto-test.md`.

Кратко:
1. resolve-config; задача из meta.json. Установи рабочую область:
   `scope.mjs set --stage implement-auto-test --type <FE|BE> --task
   <TASK-ID>` (запись — только репо автотестов; `clear` при завершении).
   Проверь чистоту working tree репозитория автотестов.
2. Обнови копию автотестов (`update --mode write`); создай ветку
   `<TASK-ID>-autotests` (`git-ops branch`), запиши autotestBranch.
3. Запусти qa-autotest-engineer: вход — ТОЛЬКО autotest-plan.md,
   specification.md и путь к рабочей копии автотестов (кодовая база FE/BE
   не открывается, дифф реализации не готовится); реализация автотестов
   `AT-N` (раздел «Автотесты» — что писать, «Шаги реализации тестов» — где)
   по соглашениям репозитория автотестов, с отметкой чекбокса каждого
   выполненного шага в autotest-plan.md
   (`- [ ]` → `- [x]`; остальной текст плана не правится); запуск тестов;
   report-auto-test.md (core/templates/report-auto-test.md).
4. Сверь отчёт с планом:
   `validate-artifact --file <задача>/report-auto-test.md --type
   report-auto-test --plan <задача>/autotest-plan.md` — на каждый `AT-N`
   плана строка в отчёте. `planMismatch.missing` → возврат агенту; `extra`
   → должен быть объяснён в «Расхождении с планом».
5. Цикл ревью (core/stages/_review-loop.md, домен autotests): агент reviewer
   находит замечания, qa-autotest-engineer спорит и исправляет (2 раунда по
   умолчанию; нерешённые blocker/major → эскалация).
6. Скилл коммитит финальные изменения в ветку (push/MR — по подтверждению).
   Обнови meta.json (stages.implement-auto-test.done + review). Конвейер
   задачи завершён.
