---
name: create-specification
description: Вносит требования из intent в репозиторий системного анализа и формирует спецификацию задачи. Запускать, когда системный аналитик берёт готовый intent в работу и нужно создать задачу tasks/<тип>/<TASK-ID>/ со specification.md, а сами требования внести в документы анализа в отдельной ветке. Запускается по INTENT-ID для новой задачи и по TASK-ID для продолжения уже заведённой (в том числе мигрированной с 1.x). Второй шаг конвейера, после /conveyor:intent. Запускать только по явной команде пользователя.
---

Этап конвейера conveyor: правки анализа + спецификация (две фазы).
**Агент:** system-analyst. **Аргументы:** `INTENT-ID | TASK-ID [FE|BE|FE-BE]
[номер]`. **Предусловие:** есть `intents/<INTENT-ID>/intent.md` — либо, для
продолжения уже заведённой задачи, `tasks/<FE|BE>/<TASK-ID>/meta.json`.

**Корень плагина.** `${CLAUDE_PLUGIN_ROOT}` — Claude Code подставил сюда
абсолютный путь при загрузке скилла. Ниже и во всех файлах этапа он обозначен
плейсхолдером `<CONVEYOR_ROOT>`: подставляй этот путь БУКВАЛЬНО в каждую
команду и каждый путь. Переменной окружения с таким именем нет — `$` с
фигурными скобками раскроется в пустоту, а окружение между вызовами Bash не
сохраняется. Остался незаменённый текст вместо пути — возьми каталог из строки
«Base directory for this skill» выше и поднимись на два уровня.

Прочитай и выполни точно: `<CONVEYOR_ROOT>/core/stages/_common.md` и
`<CONVEYOR_ROOT>/core/stages/create-specification.md`.

Кратко (команды — в полной форме; сокращённый вызов скрипты отвергают,
`<repo>` — путь из ответа locate):
1. resolve-config. Первый аргумент — INTENT-ID или TASK-ID: определи по
   файлам (`tasks/<FE|BE>/<аргумент>/meta.json` → TASK-ID,
   `intents/<аргумент>/intent.md` → INTENT-ID). СРАЗУ после resolve-config и
   ДО любых вопросов — обратный индекс `tasks/*/*/meta.json → intentId`:
   задача с этим intentId уже есть → запуск повторный (тип, номер и подэтапы
   бери из её meta.json, вторую задачу не заводи). Для НОВОЙ задачи тип и
   номер задаёт аналитик, в intent'е их нет; не переданы — спроси ОДНИМ
   вопросом.
2. Фаза A (пишем в анализ):
   `scope.mjs set --stage create-specification --type <FE|BE|FE-BE> --task <TASK-ID>`
   → задача(и) и meta.json (intentId, пять этапов; каталог задачи появляется
   этой записью — `mkdir` по нему guard запрещает) →
   `git-ops locate --link <link systemsAnalysis> --workspace <workspaceRoot> --name systemsAnalysis`
   → `git-ops update --path <repo> --main <mainBranch> --mode write` →
   `git-ops branch --path <repo> --branch <INTENT-ID>-analysis --from <mainBranch>`
   (одна общая ветка на пару FE-BE) → агент правит документы точечно, БЕЗ
   переформатирования → проверка машиночитаемых файлов → цикл ревью (домен
   systems-analysis) → коммит после ревью → `analysisDone = true`,
   `analysisBranch`/`analysisBaseSha` в meta.json.
3. Фаза B (запись в репозитории запрещена):
   `scope.mjs set --stage create-specification --type <FE|BE|FE-BE> --task <TASK-ID> --write none`
   → `git-ops diff --path <repo> --base <analysisBaseSha> --head <analysisBranch>`
   → агент собирает specification.md по `core/templates/specification.md` →
   `validate-artifact.mjs --file <папка задачи>/specification.md --type specification`
   (возврат агенту не только при `ok:false`, но и при непустом
   `placeholders`) → `validate-task-folder.mjs --task <папка задачи>` →
   `specDone` и `done`.
4. Повторный запуск при `analysisDone:true, specDone:false` идёт сразу в фазу
   B — правки чужого репозитория не переигрываются. Всё равно выполняются
   resolve-config и тот же вызов locate из п. 2: без первого нет
   workspaceRoot/links, без второго — `--path <repo>` для диффа фазы B.
   Задачу с пустым `intentId` (мигрированную из 1.x) продолжают ТОЛЬКО
   запуском по TASK-ID: обратный индекс её не находит, а чужой INTENT-ID
   завёл бы вторую задачу.
5. `scope.mjs clear`; следующий шаг — /conveyor:create-plan.
