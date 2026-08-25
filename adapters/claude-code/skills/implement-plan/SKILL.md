---
name: implement-plan
description: Реализует задачу в кодовой базе по плану (plan.md) в отдельной ветке. Запускать после /create-plan, когда разработчик готов писать код. Создаёт ветку задачи, реализует шаги плана, прогоняет тесты и линтеры, коммитит. Аргумент TASK-ID.
---

Этап конвейера conveyor: реализация.
**Агент:** frontend-developer или backend-developer (по типу задачи).
**Предусловие:** есть plan.md.

**Корень плагина.** `${CLAUDE_PLUGIN_ROOT}` — Claude Code подставил сюда
абсолютный путь при загрузке скилла. Ниже и во всех файлах этапа он обозначен
плейсхолдером `<CONVEYOR_ROOT>`: подставляй этот путь БУКВАЛЬНО в каждую
команду и каждый путь. Переменной окружения с таким именем нет — `$` с
фигурными скобками раскроется в пустоту, а окружение между вызовами Bash не
сохраняется. Остался незаменённый текст вместо пути — возьми каталог из строки
«Base directory for this skill» выше и поднимись на два уровня.

Прочитай и выполни точно: `<CONVEYOR_ROOT>/core/stages/_common.md` и
`<CONVEYOR_ROOT>/core/stages/implement-plan.md`.

Кратко:
1. resolve-config; тип из meta.json → агент + кодовая база. Установи рабочую
   область: `scope.mjs set --stage implement-plan --type <FE|BE> --task
   <TASK-ID>` (`clear` при завершении/остановке). Проверь чистоту
   working tree (`git-ops clean-check`), грязная → стоп.
2. Обнови (`update --mode write`); создай ветку `<TASK-ID>-<slug>`
   (`git-ops branch`), запиши implementBranch. Повторный запуск — продолжай
   существующую ветку.
3. Запусти агента: реализация строго по plan.md, отметки чекбоксов, прогон
   тестов/линтеров, отклонения — в plan.md.
4. Цикл ревью (core/stages/_review-loop.md, домен frontend/backend): агент
   reviewer находит замечания, разработчик спорит и исправляет (2 раунда по
   умолчанию; нерешённые blocker/major → эскалация).
5. Скилл коммитит финальные изменения в ветку задачи (push/MR — по
   подтверждению + permission-prompt guard-хука). Обнови meta.json
   (stages.implement-plan.done + review). Напечатай итог. Следующий шаг —
   `/conveyor:create-autotest-plan`.
