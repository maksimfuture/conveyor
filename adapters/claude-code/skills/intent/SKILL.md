---
name: intent
description: Формирует намерение (intent) по новой задаче конвейера conveyor. Создаёт intents/INTENT-N/intent.md, а при repos.businessAnalysis.update=true обновляет репозиторий бизнес-анализа через ветку и MR. Первый шаг работы над любой задачей. Запускать только по явной команде пользователя.
---

Этап конвейера conveyor: сформировать намерение (intent).
**Агент:** business-analyst.

**Корень плагина.** `${CLAUDE_PLUGIN_ROOT}` — Claude Code подставил сюда
абсолютный путь при загрузке скилла. Ниже и во всех файлах этапа он обозначен
плейсхолдером `<CONVEYOR_ROOT>`: подставляй этот путь БУКВАЛЬНО в каждую
команду и каждый путь. Переменной окружения с таким именем нет — `$` с
фигурными скобками раскроется в пустоту, а окружение между вызовами Bash не
сохраняется. Остался незаменённый текст вместо пути — возьми каталог из строки
«Base directory for this skill» выше и поднимись на два уровня.

Прочитай и выполни точно: `<CONVEYOR_ROOT>/core/stages/_common.md` и
`<CONVEYOR_ROOT>/core/stages/intent.md`.

Кратко:
1. resolve-config (см. _common.md); нужна ссылка businessAnalysis.
2. INTENT-ID из аргумента либо автоинкремент по `intents/INTENT-*`.
3. По `links.businessAnalysis.update`: `false` → область `--write none` и
   `update --mode read`; `true` → `--write businessAnalysis`, режим write,
   ветка `<INTENT-ID>-business-analysis`, правки, ревью, затем `git-ops
   commit` и `git-ops push --create-mr`. При грязной ожидаемой ветке после
   обрыва продолжай только после подтверждения пользователя.
   Тип задачи не передаётся; при завершении/остановке — `scope.mjs clear`.
4. `git-ops locate` + выбранный режим `update` для бизнес-анализа.
5. Запусти business-analyst: вход — описание, путь к бизнес-анализу, режим
   update, ПОЛНЫЙ текст `core/templates/intent.md`, файлы соглашений.
6. Валидация `validate-artifact --type intent`: возврат агенту не только при
   `ok:false`, но и при непустом `placeholders` (остался каркас шаблона);
   повторный `ok:false` останавливает этап до публикации. Цикл ревью
   запускается только для правок бизнес-анализа при `update:true`.
7. Следующий шаг — `/conveyor:create-specification <INTENT-ID> <FE|BE|FE-BE>`.
