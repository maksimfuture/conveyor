---
name: create-requirements-auto-test
description: Формирует требования к автотестам (requirements-auto-test.md) по диффу реализации и плану. Запускать после /implement-plan, когда нужно описать тест-кейсы с приоритетами и трассировкой на REQ-ID перед написанием автотестов. Аргумент TASK-ID.
---

Этап конвейера conveyor: требования к автотестам.
**Агент:** qa-autotest-engineer. **Предусловие:** этап implement-plan завершён.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-requirements-auto-test.md`.

Кратко:
1. resolve-config; задача из meta.json. Установи рабочую область:
   `scope.mjs set --stage create-requirements-auto-test --type <FE|BE>
   --task <TASK-ID>` (запись в репо запрещена); `clear` при завершении.
2. Найди/обнови копию кода (это делает СКИЛЛ, не агент); вычисли diff
   реализации `git-ops diff --base <mainBranch> --head <implementBranch>`
   (merge-base); baseSha/headSha → meta.json (stages.requirements-auto-test).
3. Запусти qa-autotest-engineer: вход — specification.md, plan.md, ТЕКСТ
   диффа (путь к кодовой базе агенту НЕ передаётся); выход —
   requirements-auto-test.md (core/templates/requirements-auto-test.md).
4. Валидируй покрытие критериев приёмки (непокрытые → один возврат агенту).
   Обнови meta.json (done). Следующий шаг — /implement-auto-test.
