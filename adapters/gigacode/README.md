# Адаптер GigaCode CLI

Делает плагин conveyor доступным в **GigaCode CLI**. Формат — расширение,
совместимое с Qwen (GigaCode — Qwen-совместимый CLI; так же устроен
референс-плагин polisade-orchestrator, поставляющий один и тот же билд для
Qwen и GigaCode).

## Что внутри (после сборки — dist/gigacode/)
```
conveyor/                      # каталог расширения
├── qwen-extension.json        # манифест { name, version, description }
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
```
mkdir -p ~/.gigacode/extensions
# распакуйте собранный dist/gigacode в ~/.gigacode/extensions/conveyor
cp -r dist/gigacode ~/.gigacode/extensions/conveyor
# запустите GigaCode — команды /conveyor:* регистрируются автоматически
gigacode
/conveyor:setup
```
Требуется Node.js ≥ 14 и git в PATH.

`${CONVEYOR_ROOT}` в командах = каталог установки
(`~/.gigacode/extensions/conveyor`). Если платформа не задаёт эту переменную
в окружении, подставляйте реальный путь при запуске `node`.

## Защита без хуков
В GigaCode нет перехватчиков инструментов (PreToolUse/SessionStart), как в
Claude Code. Поэтому защита исполняется самими командами (см. QWEN.md):
git — только через `core/scripts/git-ops.mjs` (в нём нет push/force), перед
записью и git-командами вызываются `core/scripts/guard-writes.mjs` /
`guard-bash.mjs`, push/MR — только по подтверждению. Это осознанная
деградация относительно Claude Code (там защита независима от команды).

## Что стоит проверить на реальном GigaCode
Формат выведен из открытого референс-плагина; перед продакшеном сверьте с
официальной документацией GitVerse/СберТех:
- имя манифеста (`qwen-extension.json` — как в референсе для GigaCode; если
  GigaCode ждёт иное имя, это переименование одного файла);
- имя контекст-файла (`QWEN.md` vs `GIGACODE.md`);
- механизм запуска субагентов (роли из `core/prompts/*` запускаются как
  субагенты);
- есть ли у GigaCode штатный перехват инструментов — тогда guard-скрипты
  можно повесить на него вместо вызовов из команд.
