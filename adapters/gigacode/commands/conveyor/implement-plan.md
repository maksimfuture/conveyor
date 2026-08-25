---
description: Реализует задачу по плану в ветке задачи — в каждом репозитории, который назвал план; прогоняет тесты и линтеры, затем цикл ревью. Запускать после create-plan. Аргумент TASK-ID.
---

**Шаг 0. Корень расширения.** Файлы этапа и скрипты лежат в каталоге установки
расширения — ВНЕ текущего проекта. Определи его абсолютный путь:
`node -e "const o=require('os'),f=require('fs'),d=(o.homedir()+'/.gigacode/extensions/conveyor').split(String.fromCharCode(92)).join('/');console.log(f.existsSync(d+'/core/stages/_common.md')?d:'NOT_FOUND')"`
Напечатанный путь — это `<CONVEYOR_ROOT>`: подставляй его БУКВАЛЬНО вместо
плейсхолдера во всех путях и командах ниже. Переменной окружения с таким
именем нет — `$` с фигурными скобками раскроется в пустоту. Напечатано
`NOT_FOUND` — останови этап и спроси у пользователя каталог, куда
`gigacode extensions install` поставил conveyor: гадать и искать по диску
нельзя. Если файловый инструмент ограничен каталогом проекта и
файлы этапа не читает — читай их оболочкой:
`cat "<CONVEYOR_ROOT>/core/stages/_common.md"`.

Этап конвейера conveyor: implement-plan. Действуй по общему протоколу из QWEN.md
(особенно правила защиты: git — через git-ops.mjs, push — только по
подтверждению), затем выполни ТОЧНО `<CONVEYOR_ROOT>/core/stages/implement-plan.md`.

Агент по типу задачи: frontend-developer или backend-developer. Затем цикл
ревью (домен frontend/backend) с агентом reviewer — core/stages/_review-loop.md.

Область записи задаёт ПЛАН: `plan-repos.mjs --file <plan.md> --workspace <root>`
→ `scope.mjs set … --write <список>`. У BE-задачи репозиториев обычно
несколько: ветка `<TASK-ID>-<slug>` заводится в каждом затронутом, ревью —
одно, на объединённом диффе с разметкой `### Репозиторий <id>`.
