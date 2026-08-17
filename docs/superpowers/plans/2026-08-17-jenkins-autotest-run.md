# Запуск джобы автотестов в Jenkins — план доработок

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** после того как автотесты написаны и отревьюены, этап `/conveyor:implement-auto-test` спрашивает про push, затем про запуск джобы, показывает теги (их можно изменить), запускает сборку в Jenkins по MCP, опрашивает статус раз в 3 минуты и по итогу формирует `report-auto-test.md`. Отказались от запуска — отчёт всё равно формируется, с пометкой «джоба с автотестами не запускалась».

**Architecture:** ссылка на джобу — один новый ключ `repos.autoTest.linkPipelineAutoTest` в `settings.json`. В Jenkins ходит скилл (у субагента MCP-инструментов нет), отчёт по-прежнему пишет `qa-autotest-engineer` — но ПОСЛЕ прогона, получив от скилла факты о сборке. Это единственное структурное изменение этапа: отчёт переезжает из середины в конец. Итог ревью при этом не теряется — он уже лежит в `meta.json → stages.implement-auto-test.review`, который заведён ровно для случая «артефакт пишется не в том же прогоне, что цикл ревью» (`_review-loop.md`, «Запись итога»).

**Tech Stack:** Node ≥14 (ESM, только `node:*`), Markdown-шаблоны артефактов, `scripts/check.mjs` как единственный тестовый контур, MCP-сервер Jenkins (имя и инструменты фиксируются в Task 0).

**Порядок этапа после доработки:**

1. агент реализует автотесты по плану, отмечает чекбоксы, гоняет локально;
2. цикл ревью (домен `autotests`), итог → `meta.json`;
3. коммит; вопрос пользователю: **пушить мне, запушите сами или не пушить**;
4. вопрос: **разрешаете запустить джобу автотестов?**;
5. агент показывает теги из написанных тестов: **по этим или выбрать другие** (список можно отредактировать);
6. запуск джобы, опрос статуса **раз в 3 минуты** до завершения;
7. агент формирует `report-auto-test.md` — с результатами прогона либо с причиной, почему сборки не было.

---

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `core/scripts/lib/config.mjs` | чтение `repos.autoTest.linkPipelineAutoTest` | изменить |
| `core/templates/settings.example.json` | пример ключа | изменить |
| `core/templates/report-auto-test.md` | раздел `## Прогон в CI` | изменить |
| `core/scripts/validate-artifact.mjs` | раздел обязателен + структурная проверка | изменить |
| `core/stages/implement-auto-test.md` | новый порядок шагов 3–10 | изменить |
| `core/prompts/qa-autotest-engineer.md` | отчёт пишется в конце; в CI агент не ходит | изменить |
| `adapters/claude-code/skills/implement-auto-test/SKILL.md` | пересказ порядка | изменить |
| `adapters/claude-code/agents/qa-autotest-engineer.md` | та же граница | изменить |
| `adapters/gigacode/commands/conveyor/implement-auto-test.md` | описание команды | изменить |
| `README.md`, `INSTALL.md` | ключ джобы + подключение MCP-сервера | изменить |
| `scripts/check.mjs` | тесты на всё перечисленное | изменить |

Новых скриптов в ядре нет. Теги собираются штатным `git diff --name-only` + поиск `@Tag("...")` по изменённым файлам — отдельный скрипт под это заводить рано: список всё равно показывается пользователю и правится им.

---

## Task 0: Discovery MCP-сервера Jenkins

**Files:** нет (результат — имена инструментов для Task 3)

- [ ] **Шаг 1: узнать имя подключённого MCP-сервера Jenkins**

Посмотреть список MCP-серверов сессии; сервера нет — спросить пользователя, какой планируется.

- [ ] **Шаг 2: выписать инструменты под три действия**

| Действие | Инструмент | Параметры |
|---|---|---|
| запустить сборку с параметрами | `<tool>` | джоба (URL из настроек), параметры |
| статус сборки | `<tool>` | джоба, номер сборки |
| результаты тестов сборки | `<tool>` | джоба, номер сборки |

- [ ] **Шаг 3: проверить на реальной джобе**

Дёрнуть «статус сборки» для последней сборки боевой джобы и убедиться, что ответ содержит номер, статус и ссылку. Не умеет — записать это ограничение: тогда в отчёт идёт только номер и ссылка, без чисел прогона.

- [ ] **Шаг 4: подставить имена в текст шага 8 стейджа (Task 3)**

Коммита здесь нет.

---

## Task 1: Ключ `linkPipelineAutoTest` в настройках

**Files:**
- Modify: `core/scripts/lib/config.mjs` (цикл по `REPO_KEYS` в `readConfig`, ~строки 271–302)
- Modify: `core/templates/settings.example.json`
- Test: `scripts/check.mjs`

- [ ] **Шаг 1: написать падающий тест**

В `scripts/check.mjs`, рядом с тестами конфигурации:

```js
  // Ссылка на джобу автотестов живёт РЯДОМ с репозиторием автотестов
  // (repos.autoTest.linkPipelineAutoTest) и хранится отдельным ключом, потому
  // что это URL: правило «link — путь внутри проекта» к джобе неприменимо.
  // Отсюда же вторая половина теста: guard настроек не должен принять этот
  // URL за негодный repos.*.link и заблокировать запись.
  {
    const jobWs = path.join(tmp, 'ws-job');
    fs.mkdirSync(jobWs, { recursive: true });
    const jobUrl = 'https://jenkins.example.com/job/MAM/job/autotest-web/';
    const settings = {
      taskPrefix: 'TASK',
      repos: { autoTest: { link: 'repos/autotests', mainBranch: 'main', linkPipelineAutoTest: ` ${jobUrl} ` } },
    };
    fs.writeFileSync(path.join(jobWs, 'settings.json'), JSON.stringify(settings, null, 2));
    const cfg = JSON.parse(runScript('core/scripts/resolve-config.mjs', [jobWs]));

    fs.writeFileSync(path.join(jobWs, 'repos-placeholder'), '');
    const guardOut = execFileSync('node', [path.join(root, 'core/scripts/guard-writes.mjs')], {
      input: JSON.stringify({
        cwd: jobWs,
        tool_input: {
          file_path: path.join(jobWs, 'settings.json'),
          content: JSON.stringify(settings),
        },
      }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: jobWs },
    }).trim();

    if (
      cfg.links.autoTest.pipelineUrl === jobUrl &&
      cfg.links.frontend.pipelineUrl === '' &&
      !/deny/.test(guardOut)
    )
      ok('config: repos.autoTest.linkPipelineAutoTest — URL джобы читается и не отвергается guard настроек');
    else
      bad(
        'config: linkPipelineAutoTest: ' +
          JSON.stringify({ autoTest: cfg.links.autoTest.pipelineUrl, guard: guardOut.slice(0, 200) }),
      );
  }
```

- [ ] **Шаг 2: запустить и убедиться, что падает**

Run: `node scripts/check.mjs`
Expected: `FAIL config: linkPipelineAutoTest: {"autoTest":undefined,...}`

- [ ] **Шаг 3: прочитать ключ в ядре**

`core/scripts/lib/config.mjs`, в цикле `for (const key of REPO_KEYS)` — после вычисления `mainBranch`:

```js
    // Ссылка на джобу автотестов в CI. Это URL, а не путь к рабочей копии:
    // проверка isUsableLink к нему НЕ применяется и применяться не должна —
    // ради этого он и заведён отдельным ключом, а не спрятан в link.
    const pipelineUrl = (((entry && entry.linkPipelineAutoTest) || '') + '').trim();
```

там же, где нормализуются `entry.link` и `entry.mainBranch`:

```js
    if (entry) {
      entry.link = value;
      entry.mainBranch = mainBranch;
      entry.linkPipelineAutoTest = pipelineUrl;
    }
```

и в объект `links[key]` — новое поле:

```js
      pipelineUrl,
```

- [ ] **Шаг 4: запустить тест**

Run: `node scripts/check.mjs`
Expected: `ok config: repos.autoTest.linkPipelineAutoTest — URL джобы читается и не отвергается guard настроек`

- [ ] **Шаг 5: показать ключ в примере настроек**

`core/templates/settings.example.json`:

```json
    "autoTest":        { "link": "repos/autotests",       "mainBranch": "main",
                         "linkPipelineAutoTest": "https://jenkins.example.com/job/MAM/job/autotest-web/" }
```

- [ ] **Шаг 6: коммит**

```bash
git add core/scripts/lib/config.mjs core/templates/settings.example.json scripts/check.mjs
git commit -m "feat(ci): repos.autoTest.linkPipelineAutoTest — ссылка на джобу автотестов"
```

---

## Task 2: Раздел «Прогон в CI» в отчёте

**Files:**
- Modify: `core/templates/report-auto-test.md` (после `## Реализованные автотесты`)
- Modify: `core/scripts/validate-artifact.mjs`
- Test: `scripts/check.mjs`

- [ ] **Шаг 1: написать падающий тест**

```js
  // Раздел отвечает на один вопрос: сборка была или нет. Пустой раздел
  // читается как «прогнали, всё хорошо», хотя за ним обычно отказ
  // пользователя или ненастроенная джоба — то есть прогон, которого не было.
  {
    const ciPath = path.join(tmp, 'report-ci.md');
    const repTpl = fs.readFileSync(path.join(root, 'core/templates/report-auto-test.md'), 'utf8');
    const vaCi = (text) => {
      fs.writeFileSync(ciPath, text);
      return JSON.parse(runScript('core/scripts/validate-artifact.mjs', ['--file', ciPath, '--type', 'report-auto-test']));
    };

    const noSection = vaCi(repTpl.replace('## Прогон в CI', '## Прочее'));
    const noSectionCaught = noSection.ok === false && noSection.missingSections.includes('## Прогон в CI');

    const from = repTpl.indexOf('## Прогон в CI');
    const to = repTpl.indexOf('\n## ', from + 1);
    const emptyCaught = vaCi(repTpl.slice(0, from) + '## Прогон в CI\n\n' + repTpl.slice(to + 1)).problems.some((p) =>
      /не запускал/i.test(p),
    );

    if (noSectionCaught && emptyCaught)
      ok('validate-artifact: отчёт обязан нести «Прогон в CI» — со сборкой либо с причиной, почему её не было');
    else
      bad(
        'validate-artifact: «Прогон в CI» — ' +
          [
            noSectionCaught ? null : 'отчёт без раздела прошёл: ' + JSON.stringify(noSection.missingSections),
            emptyCaught ? null : 'пустой раздел прошёл',
          ]
            .filter(Boolean)
            .join('; '),
      );
  }
```

- [ ] **Шаг 2: запустить и убедиться, что падает**

Run: `node scripts/check.mjs`
Expected: `FAIL validate-artifact: «Прогон в CI» — отчёт без раздела прошёл: []`

- [ ] **Шаг 3: добавить раздел в шаблон**

`core/templates/report-auto-test.md`, после таблицы `## Реализованные автотесты`:

```markdown
## Прогон в CI
<!-- Прогон идёт ПО ТЕГАМ и потому шире задачи: в сборке участвуют все тесты с
     этими тегами, а не только AT-N. Числа отсюда НЕ переносятся в «Итог
     прогона» и в сверке отчёта с планом не участвуют.
     Сборки не было — раздел не удаляй, напиши причину: «джоба с автотестами
     не запускалась: <почему>» (отказ пользователя, ветка не запушена, нет
     ссылки на джобу в settings.json, MCP-сервер недоступен). -->
- **Джоба:** <ссылка из settings.json → repos.autoTest.linkPipelineAutoTest> / «джоба с автотестами не запускалась: <причина>»
- **Ветка:** <ветка, с которой собирали>
- **Теги:** <теги, с которыми запускали — после правки пользователем>
- **Сборка:** #<номер> — <ссылка на сборку>
- **Статус:** <SUCCESS / FAILURE / UNSTABLE / в процессе>
- **Тесты в этом прогоне:** <по данным Jenkins: всего N, упало N, пропущено N>
```

- [ ] **Шаг 4: сделать раздел обязательным**

`core/scripts/validate-artifact.mjs` — в `REQUIRED`:

```js
  'report-auto-test': ['## Итог прогона', '## Реализованные автотесты', '## Прогон в CI', '## Ревью', '## Ветка'],
```

и в `STRUCTURAL['report-auto-test']`:

```js
    // Либо сборка (её номер), либо прямым текстом — почему её не было.
    // Третьего состояния у этого раздела нет.
    {
      test: (t) => {
        const body = sectionBody(t, '## Прогон в CI');
        return !body || /#\s*\d+/.test(body) || /не запускал/i.test(body);
      },
      problem: 'в «Прогоне в CI» нет ни номера сборки, ни причины «джоба с автотестами не запускалась»',
    },
```

- [ ] **Шаг 5: запустить тесты**

Run: `node scripts/check.mjs`
Expected: `ok validate-artifact: отчёт обязан нести «Прогон в CI»…`; шаблон отчёта по-прежнему проходит валидацию своего типа.

- [ ] **Шаг 6: коммит**

```bash
git add core/templates/report-auto-test.md core/scripts/validate-artifact.mjs scripts/check.mjs
git commit -m "feat(ci): раздел «Прогон в CI» в отчёте по автотестам"
```

---

## Task 3: Новый порядок шагов в стейдже

**Files:**
- Modify: `core/stages/implement-auto-test.md` (шаги 3–6 → 3–10, «Ошибки», «DoD»)
- Test: `scripts/check.mjs`

- [ ] **Шаг 1: написать падающий тест**

```js
  // Четыре вещи, которые держатся только текстом стейджа и потому проверяются
  // машинно: (1) отчёт формируется ПОСЛЕ прогона — иначе результата сборки в
  // нём не будет; (2) джоба запускается только после push, иначе соберётся
  // старый код и отчитается зелёным; (3) на запуск спрашивают разрешение;
  // (4) отказ не отменяет отчёт — он пишется с причиной.
  {
    const stageRaw = fs.readFileSync(path.join(root, 'core/stages/implement-auto-test.md'), 'utf8');
    const stage = stageRaw.replace(/\s+/g, ' ');
    const pushFirst = stage.indexOf('push') < stage.indexOf('джоб');
    const reportLast = stage.lastIndexOf('report-auto-test.md') > stage.indexOf('джоб');
    const askRun = /(разрешени|спроси)\w*[^.]{0,120}(запуск|джоб)/i.test(stage);
    const askTags = /тег\w*[^.]{0,160}(друг|отредактир|измен)/i.test(stage);
    const poll = /(3 минут|три минут)/i.test(stage);
    const refusedStillReports = /(отказ|не запускал)\w*[^.]{0,200}отчёт/i.test(stage);

    if (pushFirst && reportLast && askRun && askTags && poll && refusedStillReports)
      ok('implement-auto-test: push → разрешение → теги → сборка (опрос раз в 3 минуты) → отчёт; отказ не отменяет отчёт');
    else
      bad(
        'implement-auto-test: порядок прогона в CI — ' +
          [
            pushFirst ? null : 'запуск джобы описан раньше push',
            reportLast ? null : 'отчёт формируется раньше прогона',
            askRun ? null : 'не спрашивается разрешение на запуск джобы',
            askTags ? null : 'пользователю не предлагается изменить теги',
            poll ? null : 'не указан опрос статуса раз в 3 минуты',
            refusedStillReports ? null : 'не сказано, что при отказе отчёт всё равно формируется',
          ]
            .filter(Boolean)
            .join('; '),
      );
  }
```

- [ ] **Шаг 2: запустить и убедиться, что падает**

Run: `node scripts/check.mjs`
Expected: `FAIL implement-auto-test: порядок прогона в CI — отчёт формируется раньше прогона; не спрашивается разрешение…`

- [ ] **Шаг 3: переписать шаги стейджа**

`core/stages/implement-auto-test.md` — заменить шаги 3–6 (имена MCP-инструментов подставить из Task 0):

```markdown
3. Запусти qa-autotest-engineer: вход — autotest-plan.md, specification.md,
   путь к рабочей копии автотестов; реализовать автотесты `AT-N` по разделам
   «Автотесты» и «Шаги реализации тестов», отмечая чекбокс каждого
   выполненного шага в autotest-plan.md (`- [ ]` → `- [x]`), и прогнать их
   локально. `report-auto-test.md` на этом шаге НЕ пишется: он формируется в
   конце этапа, когда известен результат прогона в CI.
4. **Цикл ревью** (`${CONVEYOR_ROOT}/core/stages/_review-loop.md`), домен
   `autotests` — как раньше. Итог цикла кладётся в meta.json
   (`stages.implement-auto-test.review`); в раздел «Ревью» отчёта он попадёт
   на шаге 9 оттуда же.
5. Коммит финальных (после ревью) изменений в ветку — только изменения по
   задаче (не `git add -A`; коммитит скилл). Затем спроси пользователя
   (AskUserQuestion), что делать с push: **запушить сейчас** / **пользователь
   запушит сам** (дождись подтверждения, что запушил) / **не пушить**.
6. Разрешение на запуск джобы. Ссылка на неё —
   `settings.json → repos.autoTest.linkPipelineAutoTest` (в resolve-config:
   `links.autoTest.pipelineUrl`). Назови джобу и ветку и спроси разрешение на
   запуск. Джобу НЕ запускаем, если: ссылки нет в settings.json; ветка не
   запушена (джоба собирает ветку из origin — без push прогонится старый код и
   отчитается зелёным); пользователь отказал. Причину запомни — она уйдёт в
   отчёт, а этап продолжится с шага 9.
7. Теги прогона. Собери их из тестов, которые изменила ветка:
   `git-ops diff --path <копия> --base <mainBranch> --head <ветка>` (или
   `git diff --name-only`), возьми `*.java`/`*.kt` и вытащи значения
   `@Tag("...")`. Покажи получившийся список пользователю и спроси: запускать
   по этим тегам или выбрать другие — список можно отредактировать
   (AskUserQuestion с множественным выбором и возможностью ввести свой
   вариант). В запуск идёт то, что подтвердил пользователь.
8. Запусти сборку (`<tool:запуск>` на MCP-сервере Jenkins) по ссылке из
   настроек, передав выбранные теги в параметр `TAGS`. Прочие параметры джобы
   (включая `TEST_CYCLE`) не передавай — они остаются на умолчаниях джобы.
   Дальше опрашивай статус (`<tool:статус>`) **раз в 3 минуты**, пока сборка
   не завершится; по завершении забери результаты (`<tool:результаты>`).
   Сборка идёт дольше часа — спроси пользователя, ждать дальше или записать
   отчёт со статусом «в процессе».
9. Отчёт. Запусти qa-autotest-engineer второй раз: вход — autotest-plan.md,
   результаты локального прогона, объект `review` из meta.json и факты о
   сборке (ссылка на джобу, ветка, теги, номер и ссылка на сборку, статус,
   числа прогона). Выход — `report-auto-test.md` по
   `core/templates/report-auto-test.md`. Джоба не запускалась — те же входы,
   но в разделе «Прогон в CI»: «джоба с автотестами не запускалась: <причина>».
   Отказ от запуска отчёт НЕ отменяет.
   Затем сверь отчёт с планом:
   `node "${CONVEYOR_ROOT}/core/scripts/validate-artifact.mjs" --file <папка задачи>/report-auto-test.md --type report-auto-test --plan <папка задачи>/autotest-plan.md`
10. Обнови meta.json (`stages.implement-auto-test.done = true`, объект
    `review`, объект `ciRun`: `{ job, branch, tags, build, url, status }` либо
    `{ skipped: "<причина>" }`). Сними рабочую область (`scope.mjs clear`).
```

- [ ] **Шаг 4: дополнить «Ошибки»**

```markdown
- MCP-сервер Jenkins не отвечает, джоба недоступна, нет прав на запуск →
  этап НЕ падает: причина идёт в «Прогон в CI», отчёт формируется, этап
  завершается. Тесты написаны и закоммичены — терять это из-за CI нельзя.
- сборка упала (FAILURE/UNSTABLE) → это результат, а не ошибка этапа: статус
  и ссылка идут в отчёт; разбор падений — отдельная работа.
```

- [ ] **Шаг 5: дополнить «DoD»**

```markdown
`report-auto-test.md` сформирован ПОСЛЕ прогона и сошёлся с планом по составу
автотестов; в разделе «Прогон в CI» либо номер и статус сборки, либо причина,
почему джоба не запускалась; в meta.json записан `ciRun`;
```

- [ ] **Шаг 6: запустить тесты**

Run: `node scripts/check.mjs`
Expected: `ok implement-auto-test: push → разрешение → теги → сборка (опрос раз в 3 минуты) → отчёт; отказ не отменяет отчёт`

- [ ] **Шаг 7: коммит**

```bash
git add core/stages/implement-auto-test.md scripts/check.mjs
git commit -m "feat(ci): запуск джобы автотестов и отчёт по итогам прогона"
```

---

## Task 4: Промпт агента и адаптеры

**Files:**
- Modify: `core/prompts/qa-autotest-engineer.md`
- Modify: `adapters/claude-code/agents/qa-autotest-engineer.md`
- Modify: `adapters/claude-code/skills/implement-auto-test/SKILL.md`
- Modify: `adapters/gigacode/commands/conveyor/implement-auto-test.md`
- Test: `scripts/check.mjs`

- [ ] **Шаг 1: написать падающий тест**

```js
  // Агент пишет отчёт ПОСЛЕ прогона и по фактам, которые ему передал скилл: в
  // Jenkins ему ходить нечем (MCP-инструменты ему не переданы), а curl из Bash
  // обходит и подтверждение пользователя, и настройки джобы.
  {
    const prompt = fs.readFileSync(path.join(root, 'core/prompts/qa-autotest-engineer.md'), 'utf8').replace(/\s+/g, ' ');
    const noCi = /(не ход\w+|не запускай\w*)[^.]{0,80}(CI|Jenkins)/i.test(prompt);
    const factsFromSkill = /(факт\w*|данны\w*)[^.]{0,120}сборк\w*[^.]{0,120}скилл/i.test(prompt);
    if (noCi && factsFromSkill)
      ok('qa-autotest-engineer: в CI не ходит, факты о сборке получает от скилла');
    else
      bad(
        'qa-autotest-engineer: границы CI — ' +
          [noCi ? null : 'не запрещён поход в Jenkins/CI', factsFromSkill ? null : 'не сказано, откуда факты о сборке']
            .filter(Boolean)
            .join('; '),
      );
  }
```

- [ ] **Шаг 2: запустить и убедиться, что падает**

Run: `node scripts/check.mjs`
Expected: `FAIL qa-autotest-engineer: границы CI — не запрещён поход в Jenkins/CI; не сказано, откуда факты о сборке`

- [ ] **Шаг 3: дописать промпт**

`core/prompts/qa-autotest-engineer.md`, раздел «На этапе /conveyor:implement-auto-test» — заменить пункт 4 и добавить пункт 5:

```markdown
4. `report-auto-test.md` пиши, когда этап уже прогнал автотесты в CI: скилл
   вызовет тебя второй раз и передаст факты сборки (ссылка на джобу, ветка,
   теги, номер и ссылка на сборку, статус, числа прогона) плюс объект `review`
   из meta.json для раздела «Ревью». Раздел «Прогон в CI» заполняй ТОЛЬКО по
   этим фактам; сборки не было — так и напиши: «джоба с автотестами не
   запускалась: <причина>», раздел не удаляй. Числа прогона в CI в «Итог
   прогона» не переноси: сборка идёт по тегам и шире задачи.
   КОЛИЧЕСТВО АВТОТЕСТОВ В ОТЧЁТЕ ОБЯЗАНО СОВПАДАТЬ С ПЛАНОМ (см. ниже).
5. В CI ты не ходишь: сборку в Jenkins запускает скилл — как он же делает
   ветки, коммиты и push. Не запускай её через Bash (curl, jenkins-cli), даже
   зная URL: у запуска есть разрешение пользователя и выбранные им теги, мимо
   которых ходить нельзя. Локальный прогон тестов (пункт 3) остаётся твоим.
```

(перенести в новый пункт 4 требование про совпадение количества автотестов, которое сейчас живёт в старом пункте 4)

- [ ] **Шаг 4: дописать адаптеры**

`adapters/claude-code/agents/qa-autotest-engineer.md`, в пункт `/implement-auto-test`:

```markdown
  Отчёт пишется ПОСЛЕ прогона в CI, по фактам сборки от скилла; сам в
  Jenkins не ходи (ни MCP, ни curl). Джоба не запускалась — в «Прогоне в CI»
  так и пиши, с причиной.
```

`adapters/claude-code/skills/implement-auto-test/SKILL.md` — переписать краткий порядок под шаги 3–10 стейджа: реализация и локальный прогон → ревью → коммит и вопрос про push → разрешение на джобу → теги (можно изменить) → запуск и опрос раз в 3 минуты → отчёт (в том числе при отказе) → сверка с планом → meta.json + `scope clear`.

`adapters/gigacode/commands/conveyor/implement-auto-test.md` — в `description`:

```markdown
description: Реализует автотесты по плану, проводит цикл ревью, по подтверждению пушит ветку и запускает джобу автотестов в Jenkins (теги можно изменить), дожидается результата и формирует отчёт. Запускать после create-autotest-plan. Аргумент TASK-ID.
```

- [ ] **Шаг 5: запустить тесты**

Run: `node scripts/check.mjs`
Expected: `ok qa-autotest-engineer: в CI не ходит, факты о сборке получает от скилла`, весь прогон зелёный.

- [ ] **Шаг 6: коммит**

```bash
git add core/prompts/qa-autotest-engineer.md adapters scripts/check.mjs
git commit -m "feat(ci): отчёт формируется после прогона; в Jenkins ходит скилл, не агент"
```

---

## Task 5: Документация и сборка dist

**Files:**
- Modify: `README.md`, `INSTALL.md`
- Build: `dist/`

- [ ] **Шаг 1: README — описать ключ**

В описании `settings.json` (рядом с `repos.*.link` / `mainBranch`) добавить `linkPipelineAutoTest`: ссылка на джобу автотестов в Jenkins; ключ необязателен — без него этап не запускает сборку и пишет это в отчёт. Отдельно оговорить, что это ЕДИНСТВЕННОЕ поле-URL в `repos.*` и правило «link — путь внутри проекта» к нему не относится.

- [ ] **Шаг 2: INSTALL — подключение MCP-сервера Jenkins**

Сервер подключает пользователь в своём клиенте; плагин его не устанавливает и токенов не хранит — в `settings.json` попадает только ссылка на джобу. Токен Jenkins живёт в конфигурации MCP-сервера, не в `settings.json` и не в `.env`. Для GigaCode — оговорка: нет MCP → ключ не заполняют, этап работает как раньше.

- [ ] **Шаг 3: собрать и прогнать**

```bash
node scripts/build.mjs
node scripts/check.mjs
```
Expected: `+ dist\claude-code`, `+ dist\gigacode`, «Все проверки пройдены».

- [ ] **Шаг 4: коммит**

```bash
git add README.md INSTALL.md
git commit -m "docs(ci): ссылка на джобу автотестов и подключение MCP-сервера Jenkins"
```

---

## Что решено не делать

- **Проверять теги против параметров джобы.** Список показывается пользователю и правится им — этого достаточно; чтение параметров джобы по MCP добавим, если начнут запускать несуществующие теги.
- **Отдельный скрипт `ci-tags.mjs`.** Пока теги ищет скилл штатным git + поиском по `@Tag`. Если поиск начнёт врать (аннотации на методах, константы вместо литералов) — вынести в скрипт с тестом.
- **`TEST_CYCLE` (покраска Jira).** Параметр остаётся на умолчании джобы.
- **Разбор упавшей сборки и перезапуск только прогона.** Сборка упала — это результат в отчёте; перезапуск = повторный заход в этап.

## Риски

| Риск | Что делаем |
|---|---|
| Сборка до push прогоняет старый код и отчитывается зелёным | Джоба запускается только после подтверждённого push; на порядок есть тест |
| Числа прогона по тегам перепутают с числом `AT-N` задачи | Отдельный раздел + комментарий в шаблоне; сверка `planMismatch` смотрит только в «Реализованные автотесты» |
| Отчёт переехал в конец — цикл ревью пишет раньше | Итог ревью уже хранится в `meta.json → review` именно для такого случая (`_review-loop.md`) |
| Сборка идёт часами и блокирует сессию | Опрос раз в 3 минуты; после часа — вопрос пользователю: ждать или писать «в процессе» |
| MCP-сервера нет (GigaCode) или он недоступен | Ключ не заполнен / сервер молчит → отчёт с причиной, этап завершается штатно |
| Секреты Jenkins | В `settings.json` только ссылка на джобу; токен — в конфигурации MCP-сервера пользователя |
