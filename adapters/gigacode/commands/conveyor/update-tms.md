---
description: Переносит таблицу «Тест-кейсы» из autotest-plan.md в Zephyr Scale через MCP Jira (создаёт кейсы новым тестам, сверяет и при необходимости правит существующие) и заменяет заглушки PROJ-T999-N ключами кейсов в плане, отчёте и @TmsLink кода автотестов. Запускать после implement-auto-test, до run-auto-test; можно перезапускать. Аргумент TASK-ID.
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

Этап конвейера conveyor: update-tms. Действуй по общему протоколу из
QWEN.md (resolve-config → правила защиты), затем выполни ТОЧНО
`<CONVEYOR_ROOT>/core/stages/update-tms.md`.

Агент не нужен: разбор плана (`tms-cases.mjs parse`), вызовы MCP Jira/Zephyr,
запись ключей (`tms-cases.mjs record`) и замену заглушек (`tms-cases.mjs
apply`) делает сама команда. Хуков в GigaCode нет: рабочую область ставь
до первой записи — `apply` и `record` сами сверяются с ней. Цикл ревью на
этом этапе НЕ запускается.
