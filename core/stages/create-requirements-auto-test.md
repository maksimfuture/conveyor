# Этап /create-requirements-auto-test — требования к автотестам

**Кто запускает:** разработчик (передаёт задачу тестированию; содержательную
работу делает QA-агент). **Агент:** qa-autotest-engineer.
**Аргументы:** `TASK-ID`. **Предусловие:** этап implement-plan завершён (meta.json).

## Алгоритм
1. Найди и обнови рабочую копию кода (`git-ops locate` + `update --mode read`).
2. Вычисли diff реализации (скилл):
   `git-ops diff --path <repo> --base <mainBranch> --head <implementBranch>`
   (merge-base-семантика). `baseSha = merge-base`, `headSha = вершина
   implementBranch` → `meta.json → stages.requirements-auto-test`.
3. Запусти qa-autotest-engineer: вход — specification.md, plan.md (с
   отметками и отклонениями), diff; выход — `requirements-auto-test.md` по
   `core/templates/requirements-auto-test.md`.
4. Валидация (скилл): каждый критерий приёмки спецификации покрыт хотя бы
   одним тест-кейсом либо явно помечен «не автоматизируется» с причиной.
5. Обнови meta.json (`stages.requirements-auto-test.done = true`, SHA).

## Ошибки
- ветка implementBranch не найдена в кодовой базе → остановка с инструкцией
  (повторить /implement-plan или указать ветку вручную);
- валидация покрытия не прошла → один автоматический возврат агенту, затем
  показать пользователю непокрытое.

## DoD
Валидация покрытия критериев приёмки пройдена; SHA диффа зафиксированы.
Следующий шаг — `/implement-auto-test`.
