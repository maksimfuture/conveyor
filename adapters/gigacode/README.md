# Адаптер GigaCode CLI

Делает плагин conveyor доступным в **GigaCode CLI**. Формат — расширение
GigaCode: манифест `gigacode-extension.json`, контекст `QWEN.md` и команды
`commands/<plugin>/<имя>.md`. Проверено на реальном GigaCode CLI: команды
регистрируются как `/conveyor:*`.

> **Важно (проверено на GigaCode):** манифест обязан называться
> `gigacode-extension.json`. При имени `qwen-extension.json` GigaCode пишет
> `Only gigacode-extension.json is supported` и МОЛЧА пропускает расширение —
> команды не появляются.

## Что внутри (после сборки — dist/gigacode/)
```
conveyor/                      # каталог расширения
├── gigacode-extension.json    # манифест { name, version, description }
├── QWEN.md                    # контекст: общий протокол, защита, список команд
├── commands/conveyor/*.md     # 8 команд → /conveyor:<имя>
└── core/                      # ядро (промпты, стейджи, шаблоны, скрипты)
```

Команды — namespaced markdown `commands/conveyor/<имя>.md` (frontmatter
`description` + тело). Они регистрируются как `/conveyor:*`. Тело каждой
команды тонкое: следует общему протоколу из `QWEN.md` и выполняет
соответствующий `core/stages/<имя>.md`. Вся логика — в `core/` (то же ядро,
что у адаптера Claude Code).

## Установка
Сначала соберите дистрибутив (из корня плагина):
```
node scripts/build.mjs
```
Затем поставьте расширение штатной командой GigaCode — она копирует файлы,
валидирует манифест и РЕГИСТРИРУЕТ расширение в реестре:
```
gigacode extensions install dist/gigacode
```
GigaCode спросит подтверждение (security-предупреждение) — подтвердите. После
этого:
```
gigacode extensions list      # должно показать conveyor (2.0.0) и 8 команд
gigacode
/conveyor:setup
```
Требуется Node.js ≥ 14 и git в PATH.

> Не копируйте вручную (`cp -r dist/gigacode ~/.gigacode/extensions/...`):
> ручное копирование не прописывает расширение в реестр, и
> `gigacode extensions list` его не увидит. Используйте
> `gigacode extensions install`.

Обновление/удаление:
```
gigacode extensions uninstall conveyor   # снять
# затем снова: node scripts/build.mjs && gigacode extensions install dist/gigacode
```

`${CONVEYOR_ROOT}` в командах = каталог установки (GigaCode ставит расширение
в `~/.gigacode/extensions/conveyor`). Если платформа не задаёт эту переменную
в окружении, подставляйте реальный путь при запуске `node`.

## Быстрый режим
Для медленных/слабых моделей можно включить быстрый режим в `.env` рабочего
репозитория: `CONVEYOR_FAST=true` (по умолчанию выключен). Эффект: цикл
ревью отключается (reviewRounds=0), валидация артефактов выполняется
скриптом `core/scripts/validate-artifact.mjs` вместо повторного прогона
агента, git-контекст и диффы короче, шаблоны заполняются кратко. Детали —
`core/stages/_common.md`, раздел «Быстрый режим».

## Защита без хуков
В GigaCode нет перехватчиков инструментов (PreToolUse/SessionStart), как в
Claude Code. Поэтому защита исполняется самими командами (см. QWEN.md):
git — только через `core/scripts/git-ops.mjs` (в нём нет push/force), перед
записью и git-командами вызываются `core/scripts/guard-writes.mjs` /
`guard-bash.mjs`, push/MR — только по подтверждению. Это осознанная
деградация относительно Claude Code (там защита независима от команды).
