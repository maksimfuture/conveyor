---
name: intent
description: Формирует намерение (intent) по новой задаче конвейера conveyor. Запускать, когда бизнес-аналитик описывает пожелание заказчика и нужно создать intents/INTENT-N/intent.md с проблемой, ценностью, границами и бизнес-критериями приёмки. Репозиторий системного анализа при этом только читается. Первый шаг работы над любой задачей. Запускать только по явной команде пользователя.
---

Этап конвейера conveyor: сформировать намерение (intent).
**Агент:** business-analyst.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/intent.md`.

Кратко:
1. resolve-config (см. _common.md); нужна ссылка systemsAnalysis.
2. INTENT-ID из аргумента либо автоинкремент по `intents/INTENT-*`.
3. `scope.mjs set --stage intent --task <INTENT-ID>` — типа задачи у intent
   нет, `--type` НЕ передаётся; запись в репозитории запрещена; при
   завершении/остановке — `scope.mjs clear`.
4. `git-ops locate` + `update --mode read` для репозитория анализа.
5. Запусти business-analyst: вход — описание, путь к анализу (только
   чтение), ПОЛНЫЙ текст `core/templates/intent.md`, файлы соглашений.
6. Валидация `validate-artifact --type intent`; цикл ревью НЕ запускается.
7. Следующий шаг — `/conveyor:create-specification <INTENT-ID> <FE|BE|FE-BE>`.
