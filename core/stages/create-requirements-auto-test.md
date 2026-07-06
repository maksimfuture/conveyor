# Этап /create-requirements-auto-test — требования к автотестам

**Кто запускает:** разработчик (передаёт задачу тестированию; содержательную
работу делает QA-агент). **Агент:** qa-autotest-engineer.
**Аргументы:** `TASK-ID`. **Предусловие:** этап implement-plan завершён (meta.json).

**Рабочая область:** агент работает ТОЛЬКО с артефактами задачи
(specification.md, plan.md) и ПОДГОТОВЛЕННЫМ командой диффом реализации —
путь к кодовой базе агенту НЕ передаётся, в репозитории он не заходит.
Diff готовит сама команда через git-ops. Запись — только артефакты задачи.

## Алгоритм
1. Установи рабочую область: `scope.mjs set --stage
   create-requirements-auto-test --type <FE|BE> --task <TASK-ID>` (запись в
   репозитории запрещена). Найди и обнови рабочую копию кода
   (`git-ops locate` + `update --mode read`) — это делает КОМАНДА, не агент.
2. Вычисли diff реализации (команда):
   `git-ops diff --path <repo> --base <mainBranch> --head <implementBranch>`
   (merge-base-семантика). `baseSha = merge-base`, `headSha = вершина
   implementBranch` → `meta.json → stages.requirements-auto-test`.
3. Запусти qa-autotest-engineer: вход — specification.md, plan.md (с
   отметками и отклонениями), ТЕКСТ диффа (или временный файл с ним);
   выход — `requirements-auto-test.md` по
   `core/templates/requirements-auto-test.md`. Путь к кодовой базе не
   передавать.
4. Валидация (скилл): каждый критерий приёмки спецификации покрыт хотя бы
   одним тест-кейсом либо явно помечен «не автоматизируется» с причиной.
5. Обнови meta.json (`stages.requirements-auto-test.done = true`, SHA).
   Сними рабочую область (`scope.mjs clear`).

## Ошибки
- ветка implementBranch не найдена в кодовой базе → остановка с инструкцией
  (повторить /implement-plan или указать ветку вручную);
- валидация покрытия не прошла → один автоматический возврат агенту, затем
  показать пользователю непокрытое.

## DoD
Валидация покрытия критериев приёмки пройдена; SHA диффа зафиксированы.
Следующий шаг — `/implement-auto-test`.
