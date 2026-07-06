# Установка conveyor — пошагово

Плагин ставится в **GigaCode CLI** (как расширение) и в **Claude Code** (как
плагин). Ниже — по шагам для каждой среды.

Предварительно нужно:
- **Node.js ≥ 14** — проверьте: `node --version`;
- **git** в PATH — проверьте: `git --version`;
- установленный **GigaCode CLI** (`gigacode --version`) — для установки в GigaCode.

---

## A. GigaCode CLI

### Шаг 1. Получить исходники плагина
Скопируйте/склонируйте каталог плагина к себе и перейдите в него:
```
cd путь/к/conveyor        # каталог, где лежат core/, adapters/, scripts/
```

### Шаг 2. Собрать дистрибутив
```
node scripts/build.mjs
```
Появится `dist/gigacode/` — готовое расширение (манифест
`gigacode-extension.json`, `QWEN.md`, `commands/conveyor/*`, вложенный `core/`).

### Шаг 3. (Опционально) Прогнать самопроверку
```
node scripts/check.mjs
```
Должно закончиться строкой «Все проверки пройдены».

### Шаг 4. Установить расширение штатной командой GigaCode
```
gigacode extensions install dist/gigacode
```
GigaCode покажет security-предупреждение («Extensions may introduce
unexpected behavior») — подтвердите вводом `Y`.
Команда сама скопирует файлы в `~/.gigacode/extensions/conveyor/` и
ЗАРЕГИСТРИРУЕТ расширение в реестре.

> Не копируйте вручную (`cp -r`) — ручное копирование не регистрирует
> расширение, и в списке команд оно не появится.

### Шаг 5. Проверить, что расширение встало
```
gigacode extensions list
```
Ожидаемый вывод: `conveyor (1.0.0)`, `Enabled (User): true`,
`Enabled (Workspace): true` и 8 команд:
`/conveyor:setup`, `/conveyor:create-feature`, `/conveyor:create-specification`,
`/conveyor:create-plan`, `/conveyor:implement-plan`,
`/conveyor:create-requirements-auto-test`, `/conveyor:implement-auto-test`,
`/conveyor:task-status`.

### Шаг 6. Запустить GigaCode и инициализировать рабочий репозиторий
```
gigacode
/conveyor:setup
```
`/conveyor:setup` создаёт в текущем каталоге `settings.json`, `.env.example`,
`tasks/FE`, `tasks/BE`, `.gitignore`.

### Шаг 7. Заполнить .env
Скопируйте `.env.example` → `.env` и укажите пути/URL к четырём репозиториям
(системный анализ, фронтенд, бэкенд, автотесты). Пустые `*_MAIN_BRANCH`
означают ветку `main`.

Опциональные переменные (пустые = значения по умолчанию):
- `CONVEYOR_FAST=true` — **быстрый режим** для медленных/слабых моделей:
  ревью отключается, валидация артефактов — скриптом, короче git-контекст
  и диффы. По умолчанию выключен.
- `CONVEYOR_REVIEW_ROUNDS` — раундов цикла ревью (пусто = 2; `0` — ревью
  выключено, не трогая остальное).
- `CONVEYOR_REPO_CACHE=true` — разрешить git-URL в ссылках (клонирование в
  `.cache/repos/`). По умолчанию выключен — ссылки должны быть локальными.

Готово — можно запускать `/conveyor:create-feature`.

### Обновление / удаление
```
gigacode extensions uninstall conveyor          # снять
node scripts/build.mjs                           # пересобрать после правок
gigacode extensions install dist/gigacode        # поставить заново
```

---

## B. Claude Code

### Шаг 1–3. Собрать (те же шаги)
```
cd путь/к/conveyor
node scripts/build.mjs        # появится dist/claude-code/
node scripts/check.mjs        # опционально
```
`dist/claude-code/` — готовый плагин: внутри `.claude-plugin/plugin.json`,
`skills/`, `agents/`, `hooks/`, `core/`.

### Шаг 4. Подключить как плагин
Укажите Claude Code на каталог `dist/claude-code/` как локальный плагин
(команда `/plugin` → установка из локального пути, либо добавление каталога в
настройки плагинов — способ зависит от версии Claude Code).

### Шаг 5. Проверить и инициализировать
Команды доступны как `/conveyor:<имя>` (или короткой формой `/<имя>`, если нет
конфликта со встроенными). Запустите `/setup`, затем заполните `.env` (как в
шаге 7 выше).

Отличие от GigaCode: в Claude Code защита работает через хуки автоматически;
в GigaCode — через сами команды (см. `adapters/gigacode/README.md`).

---

## Устранение проблем

| Симптом | Причина и решение |
|---|---|
| `gigacode extensions list` не показывает conveyor; при установке был `Only gigacode-extension.json is supported` | Манифест назван неверно. Он ОБЯЗАН быть `gigacode-extension.json`. Проверьте `dist/gigacode/gigacode-extension.json`, пересоберите (`node scripts/build.mjs`) и поставьте через `gigacode extensions install`. |
| Команды `/conveyor:*` не появились | Расширение скопировано вручную (`cp -r`) — оно не зарегистрировано. Снимите (`gigacode extensions uninstall conveyor`) и поставьте через `gigacode extensions install dist/gigacode`. |
| Скрипты падают: `node: command not found` | Нет Node.js в PATH. Установите Node.js ≥ 14. |
| При запуске команды — «Здесь не инициализирован рабочий репозиторий conveyor» | Не выполнен `/conveyor:setup` в этом каталоге, либо нет `settings.json`. Запустите `/conveyor:setup`. |
| «заполните .env: не хватает …» | В `.env` не заданы нужные этапу переменные. Заполните по образцу `.env.example`. |
| git-URL в ссылках, но «ошибка конфигурации» | По умолчанию кэш выключен и ссылки должны быть локальными путями. Для git-URL включите `CONVEYOR_REPO_CACHE=true` в `.env`. |
