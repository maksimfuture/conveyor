---
name: conveyor-setup
description: Инициализирует рабочий репозиторий conveyor — settings.json, .env.example, docs/specs/tasks/FE, docs/specs/tasks/BE, intents/, repos/, .gitignore — и диагностирует рабочие копии в repos/ (repos-status). Запускать при настройке нового рабочего репозитория команды и после его клонирования каждым разработчиком. Запускается ТОЛЬКО командой /conveyor:setup — по одному описанию задачи сам не запускай.
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

Этап конвейера conveyor: инициализация (setup создаёт конфигурацию,
resolve-config на входе не нужен). Соблюдай правила защиты из GIGACODE.md
(git — только через git-ops.mjs; перед записью — guard-writes.mjs).

Выполни ТОЧНО `.gigacode/extensions/conveyor/core/stages/setup.md`. Агент не требуется.
