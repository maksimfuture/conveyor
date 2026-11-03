---
name: conveyor-implement-plan
description: Реализует задачу по плану в ветке задачи — в каждом репозитории, который назвал план; прогоняет тесты и линтеры, затем цикл ревью. Запускать после create-plan. Аргумент TASK-ID. Запускается ТОЛЬКО командой /conveyor:implement-plan — по одному описанию задачи сам не запускай.
---

**Корень расширения** — `.gigacode/extensions/conveyor`: conveyor установлен
В рабочий репозиторий, все пути ниже и в файлах этапа — ОТНОСИТЕЛЬНО его
корня (каталога с settings.json). Команды запускай из корня рабочего
репозитория, не уходя `cd` в другие каталоги. `node -e` не используй — inline-код запрещён политикой GigaCode.
Перед первым шагом проверь инструментом платформы (Read/Glob), что есть
`.gigacode/extensions/conveyor/core/stages/_common.md`. Файла нет — останови
этап: GigaCode запущен не из корня рабочего репозитория или расширение туда
не положено; попроси перезапустить GigaCode из корня (INSTALL.md, шаг 4–5).
Не ищи файлы плагина по диску и не угадывай путь.

Этап конвейера conveyor: implement-plan. Действуй по общему протоколу из GIGACODE.md
(особенно правила защиты: git — через git-ops.mjs, push — только по
подтверждению), затем выполни ТОЧНО `.gigacode/extensions/conveyor/core/stages/implement-plan.md`.

Агент по типу задачи: frontend-developer или backend-developer. Затем цикл
ревью (домен frontend/backend) с агентом reviewer — core/stages/_review-loop.md.

Область записи задаёт ПЛАН: `plan-repos.mjs --file <plan.md> --workspace <root>`
→ `scope.mjs set … --write <список>`. У BE-задачи репозиториев обычно
несколько: ветка `<TASK-ID>-<slug>` заводится в каждом затронутом, ревью —
одно, на объединённом диффе с разметкой `### Репозиторий <id>`.
