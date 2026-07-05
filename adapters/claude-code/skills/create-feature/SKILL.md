---
name: create-feature
description: Заводит новую задачу конвейера и вносит требования в репозиторий системного анализа. Запускать, когда системный аналитик описывает требования к новой фиче (FE, BE или FE-BE) и нужно создать задачу tasks/<тип>/<TASK-ID>/ с feature.md и правками документов анализа в отдельной ветке. Первый шаг работы над любой фичей.
---

Этап конвейера conveyor: внести требования в анализ и завести фичу.
**Агент:** system-analyst.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-feature.md`.

Кратко:
1. Первый шаг — resolve-config (см. _common.md).
2. Аргументы `[FE|BE|FE-BE] [номер|TASK-ID] [требования]`; тип и номер, если
   не переданы, — уточни у пользователя (номер: предложи автоинкремент).
   FE-BE → две связанные задачи (relatedTaskId), общая ветка анализа.
3. Создай папку(и) задач и meta.json (полный скелет). Обнови рабочую копию
   анализа (`update --mode write`, грязная локальная копия → стоп). Запиши
   analysisShaAtFeature. Создай ветку `<TASK-ID>-analysis` (`git-ops branch`).
4. Запусти system-analyst: внести требования в документы анализа + собрать
   feature.md (core/templates/feature.md).
5. Цикл ревью (core/stages/_review-loop.md, домен systems-analysis): агент
   reviewer находит замечания, system-analyst спорит и исправляет
   (2 раунда по умолчанию; нерешённые blocker/major → эскалация).
6. Скилл коммитит финальные правки анализа в ветку (push/MR — по
   подтверждению). Обнови meta.json (stages.feature.done + review).
   Следующий шаг — /create-specification.
