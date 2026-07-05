# Этап /create-specification — спецификация по диффу анализа

**Кто запускает:** системный аналитик. **Агент:** system-analyst.
**Аргументы:** `TASK-ID [--since <ref>]`.
**Предусловие:** существует `feature.md`.

## Определение диффа (по изменениям в репозитории анализа)
Головной ref (после `git fetch`) — через
`git-ops analysis-head --path <repo> --branch <analysisBranch> --main <mainBranch> --taskid <TASK-ID>`:
он вернёт `origin/<branch>` → локальную ветку → второй родитель merge-коммита
(при влитой ветке); если не смог (squash/rebase) — попроси диапазон у
пользователя.

База — по приоритету:
1. `--since <ref>` — от него;
2. повторный запуск: «дополнить» → headSha прошлого запуска (инкремент);
   «перезаписать» → `analysisShaAtFeature` (полный дифф ветки);
3. первый запуск — `analysisShaAtFeature`;
4. база не определилась — спроси диапазон.

## Алгоритм
1. Обнови рабочую копию анализа (`git-ops update --mode read`).
2. Вычисли diff (скилл):
   `git-ops diff --path <repo> --base <база> --head <головной ref>`.
   Приложи полные версии затронутых документов.
3. Запусти system-analyst: вход — feature.md + diff + документы; выход —
   `specification.md` по `core/templates/specification.md`.
   Для задачи с `relatedTaskId`: требования скоупятся по «Границам фичи» из
   СВОЕГО feature.md; изменения связанной задачи — не в REQ-ID, а ссылкой на
   relatedTaskId.
4. Валидация (скилл): все разделы шаблона на месте; у каждого требования
   есть REQ-ID и источник.
5. Зафиксируй `baseSha`/`headSha` в
   `meta.json → stages.specification`; `done = true`.

## Ошибки
Diff пуст → сообщи и предложи построить спецификацию по текущему состоянию
документов-источников (с подтверждением пользователя).

## DoD
specification.md прошёл валидацию шаблона; SHA диффа зафиксированы.
Следующий шаг — `/create-plan`.
