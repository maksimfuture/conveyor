---
name: conveyor-create-plan
description: Составляет план реализации (plan.md) по спецификации, анализируя кодовую базу; привязка шагов к файлам и репозиториям, покрытие REQ-ID. Запускать после create-specification. Аргумент TASK-ID. Запускается ТОЛЬКО командой /conveyor:create-plan — по одному описанию задачи сам не запускай.
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

Этап конвейера conveyor: create-plan. Действуй по общему протоколу из GIGACODE.md,
затем выполни ТОЧНО `.gigacode/extensions/conveyor/core/stages/create-plan.md`.

Агент по типу задачи: frontend-developer или backend-developer
(core/prompts/<агент>.md).

Кодовая база берётся из `codebase.<тип>` ответа resolve-config: у BE-задачи
это НЕСКОЛЬКО репозиториев (backend.core, backend.api, backend.common,
backend.config) — `git-ops locate`/`update` вызываются по каждому. План
обязан назвать, что и в каком репозитории правится: раздел «Затронутые
репозитории» и тег `Репозиторий: <id>` у каждого шага.
