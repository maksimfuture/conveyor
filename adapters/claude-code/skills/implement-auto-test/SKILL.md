---
name: implement-auto-test
description: Реализует автотесты в репозитории автотестов по требованиям (requirements-auto-test.md). Запускать после /create-requirements-auto-test, когда тестировщик готов писать автотесты. Создаёт ветку автотестов, реализует кейсы, запускает тесты, пишет отчёт. Аргумент TASK-ID.
---

Этап конвейера conveyor: реализация автотестов.
**Агент:** qa-autotest-engineer. **Предусловие:** есть requirements-auto-test.md.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/implement-auto-test.md`.

Кратко:
1. resolve-config; задача из meta.json. Проверь чистоту working tree
   репозитория автотестов.
2. Обнови копию автотестов (`update --mode write`); создай ветку
   `<TASK-ID>-autotests` (`git-ops branch`), запиши autotestBranch.
3. Подготовь diff реализации (baseSha/headSha из stage
   requirements-auto-test) и путь к кодовой базе.
4. Запусти qa-autotest-engineer: реализация кейсов по соглашениям репозитория
   автотестов; запуск тестов; report-auto-test.md
   (core/templates/report-auto-test.md).
5. Цикл ревью (core/stages/_review-loop.md, домен autotests): агент reviewer
   находит замечания, qa-autotest-engineer спорит и исправляет (2 раунда по
   умолчанию; нерешённые blocker/major → эскалация).
6. Скилл коммитит финальные изменения в ветку (push/MR — по подтверждению).
   Обнови meta.json (stages.implement-auto-test.done + review). Конвейер
   задачи завершён.
