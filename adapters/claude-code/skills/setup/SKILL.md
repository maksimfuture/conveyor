---
name: setup
description: Инициализирует рабочий репозиторий conveyor — создаёт settings.json, .env.example, tasks/FE, tasks/BE, intents/, repos/, .gitignore — и диагностирует рабочие копии в repos/. Запускать в начале работы с новым рабочим репозиторием и после его клонирования, когда пользователь просит настроить/проверить конвейер команды. Имя setup выбрано вместо init (init занят встроенной командой).
---

Этап конвейера conveyor: инициализация рабочего репозитория.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/setup.md` (через Read/cat).

У этапа две роли: первичная инициализация (шаги 1-3) и диагностика окружения
после клонирования рабочего репозитория (шаги 4-5 — выполняются ВСЕГДА).
Плагин НИЧЕГО не клонирует: рабочие копии в `repos/` заводит разработчик сам.

Кратко:
1. Если settings.json уже есть — не затирай и не пересоздавай структуру:
   репозиторий инициализирован, переходи сразу к шагу 4.
2. Спроси taskPrefix (по умолчанию TASK).
3. Создай tasks/FE/, tasks/BE/, intents/, repos/; settings.json и
   .env.example — СКОПИРУЙ файлы шаблонов механически (node -e
   fs.copyFileSync из core/templates/settings.example.json и env.example; НЕ
   по памяти), затем точечно поменяй taskPrefix при необходимости. Сам .env
   не создавай — он не обязателен. Сверь ключи settings.json с шаблоном (см.
   core/stages/setup.md, шаг 3).
4. `.gitignore` — в обеих ролях: нужны строки `repos/` и `.env` (нет файла —
   создай, есть — допиши недостающие). При первичной инициализации закоммить
   settings.json вместе с .gitignore.
5. Диагностика: `node "${CONVEYOR_ROOT}/core/scripts/repos-status.mjs"` —
   выведи таблицу по каждому репозиторию (`key`, `link`, `path`, `state`,
   `branch`, `clean`, `hint`; `hint` показывай дословно) и что осталось
   сделать руками. Признаки версии 1.x (`.cache/repos/`, git-URL в ссылках,
   feature.md в папках задач) — предложи migrate-workspace.mjs, СНАЧАЛА без
   `--apply`. Следующий шаг — `/conveyor:intent`.
