---
name: conveyor-implement-auto-test
description: Реализует автотесты в репозитории автотестов по плану автотестов, собирает тестовый код без запуска тестов, проводит цикл ревью, сверяет план с кодом, коммитит и по подтверждению пушит ветку. Тесты не запускает и отчёт не пишет — это делает run-auto-test. Запускать сразу после create-autotest-plan (implement-plan ждать не нужно). Аргумент TASK-ID. Запускается ТОЛЬКО командой /conveyor:implement-auto-test — по одному описанию задачи сам не запускай.
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

Этап конвейера conveyor: implement-auto-test. Действуй по общему протоколу из
GIGACODE.md (правила защиты: git — через git-ops.mjs, push — по подтверждению),
затем выполни ТОЧНО `.gigacode/extensions/conveyor/core/stages/implement-auto-test.md`.

Агент: qa-autotest-engineer. Затем цикл ревью (домен autotests) с агентом
reviewer — core/stages/_review-loop.md, затем сверка плана с кодом
(`tms-cases.mjs coverage`). Тесты на этом этапе не запускаются, отчёт не
пишется.
