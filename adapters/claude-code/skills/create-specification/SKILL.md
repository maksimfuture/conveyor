---
name: create-specification
description: Вносит требования из intent в репозиторий системного анализа и формирует спецификацию задачи. Запускать, когда системный аналитик берёт готовый intent в работу и нужно создать задачу tasks/<тип>/<TASK-ID>/ со specification.md, а сами требования внести в документы анализа в отдельной ветке. Второй шаг конвейера, после /conveyor:intent. Запускать только по явной команде пользователя.
---

Этап конвейера conveyor: правки анализа + спецификация (две фазы).
**Агент:** system-analyst. **Предусловие:** есть `intents/<INTENT-ID>/intent.md`.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-specification.md`.

Кратко:
1. resolve-config; аргументы `INTENT-ID [FE|BE|FE-BE] [номер]` — тип и номер
   задаёт аналитик, в intent'е их нет; не переданы — спроси ОДНИМ вопросом.
2. Фаза A (пишем в анализ): `scope.mjs set --stage create-specification
   --type <тип> --task <TASK-ID>` → создать задачу(и) и meta.json (intentId,
   пять этапов) → `git-ops locate` + `update --mode write` → ветка
   `<INTENT-ID>-analysis` (одна общая на пару FE-BE) → агент правит документы
   точечно, БЕЗ переформатирования → проверка машиночитаемых файлов → цикл
   ревью (домен systems-analysis) → коммит после ревью → `analysisDone = true`,
   `analysisBranch`/`analysisBaseSha` в meta.json.
3. Фаза B (запись в репозитории запрещена): `scope.mjs set … --write none` →
   `git-ops diff --base <analysisBaseSha> --head <analysisBranch>` → агент
   собирает specification.md по `core/templates/specification.md` →
   `validate-artifact --type specification` (возврат агенту не только при
   `ok:false`, но и при непустом `placeholders`) → `validate-task-folder` →
   `specDone` и `done`.
4. Повторный запуск при `analysisDone:true, specDone:false` начинается сразу
   с фазы B — правки чужого репозитория не переигрываются.
5. `scope.mjs clear`; следующий шаг — /conveyor:create-plan.
