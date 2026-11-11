# Адаптер GigaCode CLI

Делает плагин conveyor доступным в **GigaCode CLI**. Формат — расширение
GigaCode: манифест `gigacode-extension.json`, контекст `GIGACODE.md`, скиллы
этапов, агенты ролей и команды `/conveyor:*`.

> **Важно (проверено на GigaCode):** манифест обязан называться
> `gigacode-extension.json`. При имени `qwen-extension.json` GigaCode пишет
> `Only gigacode-extension.json is supported` и МОЛЧА пропускает расширение —
> команды не появляются.

## Что внутри (после сборки — dist/gigacode/)
```
conveyor/                      # <рабочий репозиторий>/.gigacode/extensions/conveyor
├── gigacode-extension.json    # манифест: contextFileName, agents, skills
├── GIGACODE.md                # контекст: общий протокол, защита, список команд
├── commands/conveyor/*.md     # 10 команд /conveyor:<этап> — обёртки над скиллами
├── skills/<этап>/SKILL.md     # 10 скиллов conveyor-<этап> — тело этапа
├── agents/*.md                # 6 ролей: аналитики, разработчики, QA, ревьюер
└── core/                      # ядро (промпты, стейджи, шаблоны, скрипты)
```

- **Команда** — то, что запускает человек: `/conveyor:create-plan TASK-ID`.
  Тело — одна инструкция «выполни скилл `conveyor-create-plan`». Команды
  остаются, потому что этап меняет репозитории и ведёт ветки: стартовать его
  должен человек, явно и с аргументами, а не модель по описанию задачи.
- **Скилл** — тело этапа: общий протокол из `GIGACODE.md` и ссылка на
  `core/stages/<этап>.md`.
- **Агент** — роль-субагент; тело роли он читает из `core/prompts/<роль>.md`.
- **Ядро** `core/` — то же, что у адаптера Claude Code.

## Установка — В рабочий репозиторий
Расширение кладётся в `<рабочий репозиторий>/.gigacode/extensions/conveyor/`
и коммитится туда. Глобальная установка (`~/.gigacode/extensions`) не
работает: политика GigaCode запрещает агенту запускать файлы вне проекта и
inline-код (`node -e`), а без скриптов ядра ни один этап не пройдёт.

```
node scripts/build.mjs                                   # из корня плагина
cd <рабочий репозиторий>
rm -rf .gigacode/extensions/conveyor
mkdir -p .gigacode/extensions
cp -r <путь/к/conveyor>/dist/gigacode .gigacode/extensions/conveyor
git add .gigacode/extensions/conveyor && git commit -m "feature: conveyor <версия>"
gigacode extensions link "$PWD/.gigacode/extensions/conveyor"   # каждый разработчик, один раз
gigacode extensions list      # должно показать conveyor (3.0.1) и 10 команд
```
GigaCode не подхватывает каталог в проекте сам — он читает только
`~/.gigacode/extensions`, поэтому каталог регистрируется ссылкой (`link`);
в Git Bash путь — только с прямыми слэшами. Подробно, с проверкой и
устранением проблем — [INSTALL.md](../../INSTALL.md).
Требуется Node.js ≥ 14 и git в PATH.

Корень расширения постоянен — `.gigacode/extensions/conveyor`, путь ОТНОСИТЕЛЬНО
корня рабочего репозитория. Сборка подставляет его во все тексты ядра (общий
с Claude Code плейсхолдер корня в `dist/gigacode` не попадает), а
абзацы, нужные только Claude Code (`<!-- only:claude-code -->`), вырезает.
Поэтому GigaCode запускается из корня рабочего репозитория, а агенты не уходят
`cd` в другие каталоги. Каталог расширения агенты не правят: guard-writes
запрещает запись в него всегда.

## Быстрый режим
Для медленных/слабых моделей можно включить быстрый режим в `.env` рабочего
репозитория: `CONVEYOR_FAST=true` (по умолчанию выключен). Эффект: цикл
ревью отключается (reviewRounds=0), валидация артефактов выполняется
скриптом `core/scripts/validate-artifact.mjs` вместо повторного прогона
агента, git-контекст и диффы короче, шаблоны заполняются кратко. Детали —
`core/stages/_common.md`, раздел «Быстрый режим».

## Защита без хуков
В GigaCode нет перехватчиков инструментов (PreToolUse/SessionStart), как в
Claude Code. Поэтому защита исполняется самими командами (см. GIGACODE.md):
git — только через `core/scripts/git-ops.mjs` (в нём нет push/force), перед
записью и git-командами вызываются `core/scripts/guard-writes.mjs` /
`guard-bash.mjs`, push/MR — только по подтверждению. Это осознанная
деградация относительно Claude Code (там защита независима от команды).
