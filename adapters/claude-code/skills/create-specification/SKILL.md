---
name: create-specification
description: Формирует спецификацию (specification.md) по диффу документов репозитория системного анализа. Запускать после /create-feature, когда нужно превратить внесённые в анализ требования в формальную спецификацию с REQ-ID и критериями приёмки. Аргументы TASK-ID [--since <ref>].
---

Этап конвейера conveyor: спецификация по диффу анализа.
**Агент:** system-analyst. **Предусловие:** есть feature.md.

**Плагин-корень:** `${CONVEYOR_ROOT}` = `${CLAUDE_PLUGIN_ROOT}`. Прочитай и
выполни точно: `${CONVEYOR_ROOT}/core/stages/_common.md` и
`${CONVEYOR_ROOT}/core/stages/create-specification.md`.

Кратко:
1. resolve-config; определи задачу по TASK-ID. Установи рабочую область:
   `scope.mjs set --stage create-specification --type <FE|BE> --task
   <TASK-ID>` (запись в репозитории запрещена); `clear` при завершении.
2. Головной ref анализа — `git-ops analysis-head ...`; база — по приоритету:
   --since → headSha прошлого запуска (режим «дополнить») /
   analysisShaAtFeature (режим «перезаписать») → analysisShaAtFeature.
3. Обнови копию анализа (`update --mode read`); вычисли diff
   (`git-ops diff`).
4. Запусти system-analyst → specification.md (core/templates/specification.md);
   для relatedTaskId скоупь по «Границам фичи» своей задачи.
5. Валидируй (все разделы, REQ-ID+источник у каждого требования). Зафиксируй
   baseSha/headSha в meta.json; stages.specification.done. Следующий шаг —
   /create-plan.
