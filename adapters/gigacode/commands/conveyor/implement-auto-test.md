---
description: Реализует автотесты в репозитории автотестов по плану автотестов, прогоняет их локально, проводит цикл ревью, формирует отчёт, коммитит и по подтверждению пушит ветку. Джобу в Jenkins не запускает — это делает run-auto-test. Запускать сразу после create-autotest-plan (implement-plan ждать не нужно). Аргумент TASK-ID.
---

Этап конвейера conveyor: implement-auto-test. Выполни скилл `conveyor-implement-auto-test`, передав ему
аргументы этой команды как есть. Скилл не загрузился — прочитай и выполни
ТОЧНО `.gigacode/extensions/conveyor/skills/implement-auto-test/SKILL.md` (путь от корня
рабочего репозитория).
