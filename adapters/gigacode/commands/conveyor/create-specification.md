---
description: Вносит требования в репозиторий системного анализа (ветка <ID>-analysis) и собирает specification.md по диффу этих правок. Второй шаг конвейера, после /conveyor:intent — или сразу, без intent. Аргументы `INTENT-ID | TASK-ID [FE|BE|FE-BE] [номер]`: INTENT-ID заводит новую задачу, TASK-ID продолжает уже заведённую, новый ключ Jira (TASK-ID) с постановкой текстом в чате заводит задачу без intent.
---

Этап конвейера conveyor: create-specification. Выполни скилл `conveyor-create-specification`, передав ему
аргументы этой команды как есть. Скилл не загрузился — прочитай и выполни
ТОЧНО `.gigacode/extensions/conveyor/skills/create-specification/SKILL.md` (путь от корня
рабочего репозитория).
