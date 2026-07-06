---
name: setup
description: Инициализирует рабочий репозиторий conveyor — создаёт settings.json, .env.example, tasks/FE и tasks/BE, .gitignore и проверяет ссылки на репозитории. Запускать в начале работы с новым рабочим репозиторием, когда пользователь просит настроить/инициализировать конвейер команды. Имя setup выбрано вместо init (init занят встроенной командой).
---

Этап конвейера conveyor: инициализация рабочего репозитория.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/setup.md` (через Read/cat).

Кратко:
1. Если settings.json уже есть — не затирай, предложи дозаполнить.
2. Спроси taskPrefix (по умолчанию TASK).
3. Создай tasks/FE/, tasks/BE/; settings.json и .env.example — СКОПИРУЙ
   файлы шаблонов механически (node -e fs.copyFileSync из
   core/templates/settings.example.json и env.example; НЕ по памяти),
   затем точечно поменяй taskPrefix при необходимости; пустой .env;
   добавь .env и .cache/ в .gitignore. Сверь ключи settings.json с
   шаблоном (см. core/stages/setup.md, шаг 3).
4. Проверь каждую ссылку через `node "${CONVEYOR_ROOT}/core/scripts/git-ops.mjs" locate ...`;
   git-URL при выключенном repoCache — ошибка конфигурации.
5. Выведи таблицу OK/ошибка/не заполнено и что осталось заполнить в .env.
