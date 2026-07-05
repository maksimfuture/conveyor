# Этап /implement-auto-test — реализация автотестов

**Кто запускает:** тестировщик. **Агент:** qa-autotest-engineer.
**Аргументы:** `TASK-ID`.
**Предусловие:** существует `requirements-auto-test.md`.

## Алгоритм
1. Для локального пути репозитория автотестов проверь чистоту working tree
   (`git-ops clean-check`).
2. Найди и обнови рабочую копию автотестов (`git-ops locate` +
   `update --mode write`). Создай ветку `<TASK-ID>-autotests` от mainBranch
   (`git-ops branch`); имя → meta.json (`autotestBranch`). Если ветка уже
   есть — продолжай в ней (как в implement, шаг 2).
3. Подготовь контекст реализации: diff по `baseSha`/`headSha` из stage
   requirements-auto-test и путь к рабочей копии кодовой базы (нужны обе
   ссылки — autoTest и код по типу задачи, таблица 4.4).
4. Запусти qa-autotest-engineer: изучить соглашения репозитория автотестов;
   реализовать тест-кейсы из requirements-auto-test.md (в коде — ссылки на ID
   кейсов).
5. Запусти написанные тесты; результаты — в `report-auto-test.md` по
   `core/templates/report-auto-test.md` (пройдено/упало/пропущено, причины).
6. **Цикл ревью** (`${CONVEYOR_ROOT}/core/stages/_review-loop.md`), домен
   `autotests`. Передай reviewer полный контекст домена: requirements-auto-test.md,
   specification.md, diff реализации продукта (baseSha/headSha из stage
   requirements-auto-test), путь к рабочей копии автотестов (для реального
   запуска тестов) и путь к кодовой базе. reviewer проверяет покрытие
   критериев приёмки, осмысленность кейсов, соответствие соглашениям и
   реальный запуск; qa-autotest-engineer отвечает/спорит и исправляет. Итог —
   в разделе «Ревью» report-auto-test.md; нерешённые blocker|major →
   эскалация пользователю.
7. Коммит финальных (после ревью) изменений в ветку — только изменения по
   задаче (не `git add -A`; коммитит скилл); push/MR — по подтверждению
   пользователя. Обнови meta.json
   (`stages.implement-auto-test.done = true`, объект `review`).

## Ошибки
Тестовое окружение недоступно → написать тесты, пометить запуск как
заблокированный, указать, что нужно для запуска.

## DoD
Все кейсы P1 реализованы; тесты запущены (или блокировка описана);
report-auto-test.md создан; цикл ревью пройден (коммит — после ревью;
нерешённые blocker|major вынесены пользователю). Конвейер задачи завершён.
