---
description: Переносит таблицу «Тест-кейсы» из autotest-plan.md в Zephyr Scale через MCP Jira (создаёт кейсы новым тестам, сверяет и при необходимости правит существующие) и заменяет заглушки PROJ-T999-N ключами кейсов в плане и @TmsLink кода автотестов. Запускать после implement-auto-test, до run-auto-test; можно перезапускать. Аргумент TASK-ID.
---

Этап конвейера conveyor: update-tms. Выполни скилл `conveyor-update-tms`, передав ему
аргументы этой команды как есть. Скилл не загрузился — прочитай и выполни
ТОЧНО `.gigacode/extensions/conveyor/skills/update-tms/SKILL.md` (путь от корня
рабочего репозитория).
