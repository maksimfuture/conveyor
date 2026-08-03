---
name: create-autotest-plan
description: Составляет план автотестов по спецификации задачи. Запускать, когда разработка по задаче завершена и QA берёт её в тестирование — создаёт autotest-plan.md с тест-кейсами TC-N, трассированными на требования REQ-N. Контекст берётся из репозитория автотестов (соглашения и существующие тесты), кодовая база не открывается. Аргумент TASK-ID. Запускать только по явной команде пользователя.
---

Этап конвейера conveyor: план автотестов.
**Агент:** qa-autotest-engineer.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-autotest-plan.md`.

Кратко:
1. resolve-config (см. _common.md); нужна ссылка autoTest. Предусловие —
   этап implement-plan завершён (meta.json).
2. `scope.mjs set --stage create-autotest-plan --type <FE|BE> --task
   <TASK-ID>` — запись в репозитории запрещена; при завершении/остановке —
   `scope.mjs clear`.
3. `git-ops locate` + `update --mode read` для репозитория автотестов.
4. Запусти qa-autotest-engineer: вход — specification.md (основа плана),
   plan.md (раздел «Отклонения и остатки»), путь к рабочей копии автотестов
   ТОЛЬКО для чтения, файлы соглашений, ПОЛНЫЙ текст
   `core/templates/autotest-plan.md`. Пути к кодовым базам не передавать,
   дифф реализации не готовить: тесты проверяют спецификацию.
5. Валидация `validate-artifact --type autotest-plan` плюс покрытие критериев
   приёмки; возврат агенту не только при `ok:false`, но и при непустом
   `placeholders`. Цикл ревью НЕ запускается.
6. `validate-task-folder`, `meta.json → stages['autotest-plan'].done = true`.
   Следующий шаг — `/conveyor:implement-auto-test`.
