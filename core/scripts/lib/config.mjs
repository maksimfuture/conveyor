// Shared configuration reader for the conveyor plugin.
//
// This module is the ONLY place that reads settings.json + .env and resolves
// ${VAR} placeholders (spec 4.1). resolve-config / validate-config / guard-*
// / git-ops / scope all build on it. No platform APIs — only node:fs /
// node:path / node:os, so the core stays free of platform-specific
// dependencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const VAR_RE = /\$\{([A-Za-z0-9_]+)\}/g;

// JSON, записанный штатными средствами Windows (PowerShell
// `Set-Content -Encoding utf8`, «UTF-8 with BOM» в редакторе), начинается с
// U+FEFF, и голый JSON.parse на нём падает — то есть НЕ РАБОТАЕТ ВЕСЬ плагин,
// а не одна команда: settings.json читает ядро, meta.json — хуки и скрипты.
// Ведущий BOM срезаем в ОДНОМ месте: все чтения settings.json / meta.json идут
// через readJsonFile.
function parseJsonText(text) {
  const str = String(text);
  return JSON.parse(str.charCodeAt(0) === 0xfeff ? str.slice(1) : str);
}

export function readJsonFile(file) {
  return parseJsonText(fs.readFileSync(file, 'utf8'));
}

// settings.json приходит из чужого рабочего репозитория и мог быть правлен
// руками — прежде чем читать или писать поля записи, надо убедиться, что это
// вообще запись (тот же критерий, что в migrate-workspace.mjs).
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The four repositories, in the order they appear in settings.json.
export const REPO_KEYS = ['systemsAnalysis', 'frontend', 'backend', 'autoTest'];

// Рабочие копии живут ВНУТРИ рабочего репозитория: <workspace>/repos/<dir>.
// Это дефолты для settings.json (repos.<key>.link) и для /setup; команда
// может указать другой путь — он всё равно резолвится от workspaceRoot.
export const REPO_DIRS = {
  systemsAnalysis: 'repos/system-analysis',
  frontend: 'repos/frontend',
  backend: 'repos/backend',
  autoTest: 'repos/autotests',
};

// All pipeline stages (used by scope.mjs validation).
export const STAGE_NAMES = [
  'setup',
  'intent',
  'create-specification',
  'create-plan',
  'implement-plan',
  'create-autotest-plan',
  'implement-auto-test',
  'task-status',
];

// Этапы, у которых типа задачи НЕТ: intent работает с намерением (INTENT-ID)
// до того, как системный аналитик решит, FE это, BE или пара. Для остальных
// этапов тип обязателен (scope.mjs), потому что от него зависит область
// записи. Список — здесь, а не в scope.mjs: конвейер описан в этом модуле.
export const STAGES_WITHOUT_TASK_TYPE = ['intent'];

// Walk up from startDir until a directory containing settings.json is found.
// Returns the absolute workspace root, or null if none exists.
export function findWorkspaceRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, 'settings.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Parse a .env file: KEY=VALUE lines, `#` comments, no `export`, optional quotes.
export function parseEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  // .env может оказаться каталогом или быть занят (OneDrive, антивирус,
  // EPERM/EACCES). Без перехвата голый стек Node уходил в stdout скриптов,
  // чей контракт — «всегда JSON»: repos-status, migrate-workspace, scope.
  // Файл необязателен, поэтому нечитаемый .env деградирует до умолчаний.
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function normalizeBool(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

// reviewRounds: number of review-loop rounds. Sourced from env via ${VAR};
// empty / undefined / invalid -> default 2. 0 disables the review loop.
export function normalizeReviewRounds(value) {
  if (value === undefined || value === null || value === '') return 2;
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10);
  if (Number.isNaN(n) || n < 0) return 2;
  return n;
}

// A link is treated as a git URL when it looks like ssh/https/git syntax
// rather than a filesystem path. The plugin never clones, so such a link is a
// configuration error — see urlLinks below.
export function isGitUrl(value) {
  if (!value) return false;
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || // https://, ssh://, git://
    /^git@/.test(value) ||                     // git@host:group/repo.git
    /^[\w.-]+@[\w.-]+:/.test(value)            // user@host:path (scp-like)
  );
}

// Единственный критерий пригодности ссылки на репозиторий: git-URL плагин не
// принимает (он не клонирует), а путь резолвится ОТ workspaceRoot и обязан
// остаться ВНУТРИ него. «../repo» и «..» выводят из проекта ровно так же, как
// абсолютный путь чужого каталога, — все они непригодны. Этот же критерий
// применяют git-ops locate и guard-writes (к ещё НЕ записанному settings.json).
export function isUsableLink(value, workspaceRoot) {
  const val = ((value === undefined || value === null ? '' : value) + '').trim();
  if (!val || isGitUrl(val)) return false;
  return isInside(path.resolve(workspaceRoot, val), workspaceRoot);
}

// Состояние рабочей копии репозитория — ОДИН источник и для /setup
// (repos-status), и для SessionStart (validate-config). Пригодность ССЫЛКИ
// считает isUsableLink (links[key].inside); здесь к ней добавляется
// единственное, чего ссылка не знает, — есть ли по этому пути git-репозиторий.
// Третьего критерия рядом заводить нельзя: разъехавшись, они дают либо
// молчание хука при неработающем конвейере, либо предупреждение, которое не
// гаснет после того, как человек всё сделал.
//
//   ok | missing | not-a-repo | link-empty | link-is-url | outside
//
// hint пишется как ГОТОВАЯ инструкция пользователю: и /setup, и SessionStart
// показывают его без переформулирования.
export function repoState(cfg, key) {
  const l = (cfg && cfg.links && cfg.links[key]) || { value: '', isGitUrl: false, path: null, inside: false };

  // Порядок ветвлений — от причины к следствию. Границу проекта проверяем ДО
  // существования каталога: ссылка наружу непригодна независимо от того, лежит
  // там что-нибудь или нет. Отложи её за `!existsSync`, и несуществующий путь
  // наружу получит state `missing` с подсказкой «склонируйте сюда» — туда,
  // куда клонировать нельзя вовсе: guard-writes такую копию не примет.
  if (!l.value) {
    return {
      state: 'link-empty',
      hint: `заполните repos.${key}.link в settings.json (обычно ${REPO_DIRS[key]}) и склонируйте туда репозиторий`,
    };
  }
  if (l.isGitUrl) {
    return {
      state: 'link-is-url',
      hint:
        `в repos.${key}.link нужен путь, а не git-URL: плагин не клонирует — ` +
        `склонируйте репозиторий в ${REPO_DIRS[key]} и укажите этот путь`,
    };
  }
  if (!l.inside) {
    return {
      state: 'outside',
      hint:
        `путь repos.${key}.link ведёт за пределы рабочего репозитория (${l.path}); ` +
        `он резолвится от корня рабочего репозитория и обязан остаться внутри него — укажите ${REPO_DIRS[key]}`,
    };
  }
  if (!fs.existsSync(l.path)) {
    return { state: 'missing', hint: `рабочей копии нет — склонируйте репозиторий в ${l.path}` };
  }
  if (!fs.existsSync(path.join(l.path, '.git'))) {
    // `git clone` в СУЩЕСТВУЮЩИЙ непустой каталог не выполняется — одного
    // «склонируйте сюда» мало: человек упрётся в ошибку git и вернётся сюда же.
    return {
      state: 'not-a-repo',
      hint:
        `каталог ${l.value} существует, но это не git-репозиторий: склонируйте репозиторий в ${l.path}; ` +
        `клонировать в непустой каталог git не станет — очистите его или переименуйте, если он лишний`,
    };
  }
  return { state: 'ok', hint: null };
}

// Состояния всех репозиториев разом: { key: { state, hint } }.
export function repoStates(cfg) {
  const out = {};
  for (const key of REPO_KEYS) out[key] = repoState(cfg, key);
  return out;
}

// Read + resolve. Returns a rich object; never throws for the common cases.
//   { found:false }                              — no settings.json
//   { found:true, error:'...' }                  — settings.json unparseable
//   { found:true, workspaceRoot, config,         — success
//     fastMode, links, missingLinks, urlLinks }
//
// links[key] = { value, isGitUrl, path, inside, mainBranch, pipelineUrl }
// inside — пригодна ли ссылка (см. isUsableLink); только такая даёт
// рабочую копию (repoRootFor). missingLinks = repo keys with an empty link;
// urlLinks = keys where the link is a git URL (a configuration error: the
// plugin never clones).
export function readConfig(startDir = process.cwd()) {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) return { found: false };

  const settingsPath = path.join(workspaceRoot, 'settings.json');
  let settings;
  try {
    settings = readJsonFile(settingsPath);
  } catch (e) {
    return { found: true, workspaceRoot, error: `settings.json: ${e.message}` };
  }

  const env = {
    ...parseEnvFile(path.join(workspaceRoot, '.env')),
    ...process.env, // process environment wins over .env
  };

  const resolveStr = (str) =>
    str.replace(VAR_RE, (_, name) => (env[name] === undefined ? '' : env[name]));

  const deep = (v) => {
    if (typeof v === 'string') return resolveStr(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = deep(val);
      return o;
    }
    return v;
  };

  const config = deep(settings);
  // fast mode (CONVEYOR_FAST): default false; forces reviewRounds = 0.
  const fastMode = normalizeBool(config.fast);
  config.fast = fastMode;
  // reviewRounds comes from env (${VAR}); empty/invalid -> default 2.
  config.reviewRounds = fastMode ? 0 : normalizeReviewRounds(config.reviewRounds);

  // Ссылка на репозиторий — путь к рабочей копии ОТНОСИТЕЛЬНО workspaceRoot
  // (по умолчанию repos/<dir>). Ссылку, выводящую за пределы проекта, помечаем
  // inside=false — GigaCode такое не разрешит; path при этом сохраняем, чтобы
  // /setup и repos-status могли показать, куда она указывает.
  const links = {};
  const missingLinks = [];
  const urlLinks = [];
  for (const key of REPO_KEYS) {
    // settings.json версии 1.x правили руками, и repos.<ключ> в нём бывает
    // примитивом (`"frontend": "repos/frontend"`) — эту форму разбирает
    // предупреждением migrate-workspace. Читать и ТЕМ БОЛЕЕ писать поля у
    // примитива нельзя: присваивание в ESM (strict mode) бросает TypeError, и
    // чтение конфигурации падает целиком — repos-status остаётся без stdout,
    // а SessionStart-хук (fail-open) молчит вместо предупреждения. Непонятную
    // запись считаем незаполненной ссылкой: ключ уходит в missingLinks.
    const entry = isPlainObject(config.repos) && isPlainObject(config.repos[key]) ? config.repos[key] : null;
    const value = (((entry && entry.link) || '') + '').trim();
    const mainBranch = (((entry && entry.mainBranch) || '') + '').trim() || 'main';
    // Ссылка на джобу автотестов в CI (repos.autoTest.linkPipelineAutoTest).
    // Это URL, а не путь к рабочей копии: проверка isUsableLink к нему НЕ
    // применяется и применяться не должна — ради этого он и заведён отдельным
    // ключом, а не спрятан в link. Ключ необязателен: пустая строка означает
    // «джоба не настроена», и этап автотестов просто не пойдёт в CI.
    const pipelineUrl = (((entry && entry.linkPipelineAutoTest) || '') + '').trim();
    // Нормализованные значения пишем обратно в config: stage-файлы отсылают
    // модель к config.repos.<ключ>.link, ядро считает по links[key].value —
    // два написания одного значения расходились бы на пробелах.
    if (entry) {
      entry.link = value;
      entry.mainBranch = mainBranch;
      entry.linkPipelineAutoTest = pipelineUrl;
    }

    const url = isGitUrl(value);
    const abs = value && !url ? path.resolve(workspaceRoot, value) : null;
    if (!value) missingLinks.push(key);
    if (url) urlLinks.push(key);

    links[key] = {
      value,
      isGitUrl: url,
      path: abs,
      inside: isUsableLink(value, workspaceRoot),
      mainBranch,
      pipelineUrl,
    };
  }

  return {
    found: true,
    workspaceRoot,
    config,
    fastMode,
    links,
    missingLinks,
    urlLinks,
  };
}

// Hook helper (guards): the session cwd can be `cd`-ed OUT of the workspace,
// which must NOT silently disable the guards. Resolution chain:
//   payload.cwd → $CLAUDE_PROJECT_DIR (Claude Code hook env) →
//   $CONVEYOR_WORKSPACE (manual pin, e.g. GigaCode).
// Returns the first found config (or {found:false} when none resolves).
export function readConfigForHook(payloadCwd) {
  const candidates = [payloadCwd, process.env.CLAUDE_PROJECT_DIR, process.env.CONVEYOR_WORKSPACE];
  for (const dir of candidates) {
    if (!dir) continue;
    const cfg = readConfig(dir);
    if (cfg.found) return cfg;
  }
  return { found: false };
}

// Which repos a stage needs (spec 4.4). taskType is 'FE' | 'BE' | undefined.
export function requiredRepoKeys(stage, taskType) {
  const code = taskType === 'BE' ? 'backend' : 'frontend';
  switch (stage) {
    case 'setup':
    case 'task-status':
      return [];
    case 'intent':
    case 'create-specification':
      return ['systemsAnalysis'];
    case 'create-plan':
    case 'implement-plan':
      return [code];
    case 'create-autotest-plan':
    case 'implement-auto-test':
      return ['autoTest'];
    default:
      return [];
  }
}

// ---- stage scope (защита от «гуляния» агентов по репозиториям) ------------
//
// Each stage may WRITE only into its own repos; artifacts always go to the
// workspace tasks/ folder. The skill records the active stage in
// .cache/active-scope.json (via scope.mjs); guard-writes/guard-bash then deny
// writes into any non-scoped repository working copy.

// Scope-файл живёт в СИСТЕМНОМ temp, а не в workspace: рабочий репозиторий
// не обрастает служебными каталогами — плагин ничего в нём не создаёт. Ключ —
// хэш реального пути workspace, чтобы guard-процессы находили тот же файл.
export function scopeFilePath(workspaceRoot) {
  const key = crypto
    .createHash('sha1')
    .update(realResolve(workspaceRoot))
    .digest('hex')
    .slice(0, 12);
  return path.join(os.tmpdir(), `conveyor-scope-${key}.json`);
}

// Устаревший путь (до переноса в temp) — validate-config подчищает его.
export const LEGACY_SCOPE_FILE = path.join('.cache', 'active-scope.json');

// A stale scope (crashed stage, old session) must not lock the workspace
// forever: past the TTL it is treated as absent.
export const SCOPE_TTL_MS = 8 * 60 * 60 * 1000; // 8 часов

// Which repos a stage may WRITE (narrower than requiredRepoKeys: read-only
// stages get []). taskType is 'FE' | 'BE' | 'FE-BE' | undefined.
// create-specification пишет в анализ только в фазе A; фаза B вызывает
// scope.mjs set --write none.
export function stageWriteRepoKeys(stage, taskType) {
  const code = taskType === 'BE' ? 'backend' : 'frontend';
  switch (stage) {
    case 'create-specification':
      return ['systemsAnalysis'];
    case 'implement-plan':
      return [code];
    case 'implement-auto-test':
      return ['autoTest'];
    // setup, task-status, intent, create-plan, create-autotest-plan:
    // artifacts only — no repo writes.
    default:
      return [];
  }
}

// Working-copy root for a repo key: absolute path resolved from the workspace
// root. null when the link is empty, is a (rejected) git URL or leads OUTSIDE
// the workspace. ЕДИНСТВЕННОЕ место, где критерий inside превращается в право
// записи: checkWrite / guard-bash / scope ходят только сюда.
export function repoRootFor(cfg, key) {
  const l = cfg.links && cfg.links[key];
  if (!l || !l.inside) return null;
  return l.path;
}

// Resolve symlinks for the nearest EXISTING ancestor of p, then append the
// rest — so writes through a symlinked dir cannot escape the checks.
export function realResolve(p) {
  let dir = path.resolve(p);
  let tail = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(dir)) {
      try {
        return tail ? path.join(fs.realpathSync(dir), tail) : fs.realpathSync(dir);
      } catch {
        return path.resolve(p);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(p);
    tail = tail ? path.join(path.basename(dir), tail) : path.basename(dir);
    dir = parent;
  }
}

// Detailed scope state:
//   { state: 'none' }                — файла нет или он устарел (TTL)
//   { state: 'stale', scope }        — старше TTL (guards считают 'none')
//   { state: 'corrupt' }             — файл есть, но не парсится (fail-closed)
//   { state: 'active', scope }
export function readScopeState(workspaceRoot) {
  const p = scopeFilePath(workspaceRoot);
  if (!fs.existsSync(p)) return { state: 'none' };
  let scope;
  try {
    scope = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { state: 'corrupt' };
  }
  if (!scope || typeof scope !== 'object' || !Array.isArray(scope.writeRepos)) {
    return { state: 'corrupt' };
  }
  const setAt = Date.parse(scope.setAt || '');
  if (!Number.isNaN(setAt) && Date.now() - setAt > SCOPE_TTL_MS) {
    return { state: 'stale', scope };
  }
  return { state: 'active', scope };
}

// Legacy helper: active scope object or null.
export function readScope(workspaceRoot) {
  const s = readScopeState(workspaceRoot);
  return s.state === 'active' ? s.scope : null;
}

// True when childPath is the same as, or nested inside, parentDir.
export function isInside(childPath, parentDir) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const CLEAR_HINT =
  'если этап уже не выполняется — снимите область: node <plugin>/core/scripts/scope.mjs clear';

// Папки артефактов конвейера в рабочем репозитории. Список ОДИН на два правила
// checkWrite — что разрешено писать в корне и где действует «только артефакты»:
// разъехавшись, они дают дыру (папка разрешена, а состав в ней не проверяется).
export const ARTIFACT_DIRS = ['tasks', 'intents'];

// Какой артефакт производит КАЖДЫЙ этап. Разрешения по расширению («любой
// *.md») мало: в 1.x один запуск ПЕРВОГО этапа создавал разом артефакты трёх
// разных этапов — все они проходили как законные записи,
// потому что структура папки задачи описана в README целиком, а модель прочла
// её как «вот что надо создать». Артефакт чужого этапа в папке задачи —
// такой же посторонний файл, как исходник, и отличается только расширением.
// `meta.json` пишут все этапы, поэтому в списках его нет — он разрешён всегда.
// Пустой список = этап в папку артефактов не пишет вовсе.
export const STAGE_ARTIFACTS = {
  setup: [],
  intent: ['intent.md'],
  'create-specification': ['specification.md'],
  'create-plan': ['plan.md'],
  // Реализация дописывает СВОЙ же plan.md: отметки шагов, «Отклонения и
  // остатки», раздел «Ревью».
  'implement-plan': ['plan.md'],
  'create-autotest-plan': ['autotest-plan.md'],
  'implement-auto-test': ['report-auto-test.md'],
  'task-status': [],
};

// В папке задачи и в папке интента живут ТОЛЬКО артефакты конвейера.
// Исходники (tsx/js/less/…) туда класть нельзя — код пишется в рабочую копию
// кодовой базы. Слабые модели путают эти два пути, поэтому правило закреплено
// проверкой.
export function isTaskArtifactFile(relPathInTasks) {
  const base = path.basename(relPathInTasks);
  return base.toLowerCase().endsWith('.md') || base === 'meta.json';
}

// Scope-aware write check (spec 8.1 + stage scope).
//   - repo working copies (repos/* inside the workspace): with an active scope
//     only the scoped repos are writable; without a scope — all of them;
//   - workspace (tasks/, intents/, settings): allowed — EXCEPT the scope file
//     itself (only scope.mjs may change it);
//   - system temp: allowed (checked last — explicit roots take priority);
//   - deepest matching root wins (nested repo/workspace configurations).
// Returns { allowed, reason } so guards can explain denials.
export function checkWrite(targetPath, cfg) {
  const target = realResolve(targetPath);

  const scopeState = readScopeState(cfg.workspaceRoot);
  // Устаревшая область (>TTL) для ЗАПРЕТОВ равна активной. Иначе длинная
  // сессия молча теряет защиту посреди работы: этап продолжается, а правила
  // уже не действуют. TTL нужен, чтобы забытая область не заперла каталог
  // навсегда, — эту роль выполняет SessionStart, он её снимает и говорит об
  // этом вслух. Внутри сессии «протухла» не должно значить «можно всё».
  const scope = scopeState.state === 'active' || scopeState.state === 'stale' ? scopeState.scope : null;
  const scopedKeys = scope ? scope.writeRepos : null; // null = области нет
  const corrupt = scopeState.state === 'corrupt';

  const wsRoot = realResolve(cfg.workspaceRoot);

  // Сам файл рабочей области (в temp) меняется только через scope.mjs —
  // проверяем ДО общего разрешения на temp.
  if (target === realResolve(scopeFilePath(wsRoot))) {
    return {
      allowed: false,
      reason: 'файл рабочей области меняется только через core/scripts/scope.mjs (set/clear)',
    };
  }

  // Собираем все корни, содержащие target, и решаем по САМОМУ ГЛУБОКОМУ
  // (вложенные конфигурации: репо внутри workspace, репо внутри репо).
  const matches = [];
  for (const key of REPO_KEYS) {
    const root = repoRootFor(cfg, key);
    if (!root) continue;
    const real = realResolve(root);
    if (isInside(target, real)) matches.push({ kind: 'repo', key, root: real });
  }
  if (isInside(target, wsRoot)) matches.push({ kind: 'ws', root: wsRoot });

  if (matches.length) {
    matches.sort((a, b) => b.root.length - a.root.length);
    const hit = matches[0];

    if (hit.kind === 'repo') {
      if (corrupt) {
        return {
          allowed: false,
          reason: `файл рабочей области повреждён — запись в репозитории заблокирована (${CLEAR_HINT})`,
        };
      }
      // Области нет — значит этап не запущен, и писать в рабочие копии команды
      // плагину незачем. Раньше здесь было разрешение, и оно делало все
      // остальные правила условными: скилл забыл поставить область — гарантии
      // молча исчезли, а прогон выглядел успешным. Теперь та же ошибка
      // упирается в отказ на первой же записи и становится видимой.
      if (!scopedKeys) {
        return {
          allowed: false,
          reason:
            `рабочая копия «${hit.key}»: вне этапа конвейера плагин в неё не пишет. ` +
            'Запустите нужный этап (он поставит рабочую область) либо правьте репозиторий вручную',
        };
      }
      if (scopedKeys.includes(hit.key)) return { allowed: true };
      return {
        allowed: false,
        reason:
          `рабочая копия «${hit.key}» вне рабочей области текущего этапа` +
          (scope && scope.stage
            ? ` (${scope.stage}: запись — ${scopedKeys.length ? scopedKeys.join(', ') : 'только артефакты задачи'}; ${CLEAR_HINT})`
            : ''),
      };
    }

    const rel = path.relative(wsRoot, target);
    const top = rel.split(path.sep)[0];

    // В tasks/ и intents/ — только артефакты (*.md, meta.json). Правило по ТИПУ
    // файла действует ВСЕГДА, в том числе без активного этапа: исходник в папке
    // артефактов не бывает правильным ни при каких обстоятельствах. Раньше это
    // правило висело на области, и без неё `.tsx` в папку задачи проходил.
    if (ARTIFACT_DIRS.includes(top) && rel !== top && !isTaskArtifactFile(rel)) {
      const hint =
        top === 'tasks'
          ? 'в папке задачи разрешены только артефакты (*.md, meta.json); ' +
            'исходники пиши в рабочую копию кодовой базы'
          : 'в папке интента разрешены только артефакты (*.md, meta.json); ' +
            'интент — документ, исходникам в нём не место';
      return { allowed: false, reason: `${hint} (запрошено: ${rel})` };
    }

    // Остальные ограничения рабочего репозитория — только при активном этапе:
    // вне конвейера человек вправе попросить модель поправить что угодно в
    // фасадном репозитории. `repos` в allowedTop намеренно нет: настроенная
    // рабочая копия сюда не доходит (матчится выше как kind:'repo'), а всё
    // прочее в repos/ — чужой клон.
    if (scopedKeys || corrupt) {
      const allowedTop = [...ARTIFACT_DIRS, 'settings.json', '.env', '.env.example', '.gitignore'];
      if (rel !== '' && !allowedTop.includes(top)) {
        return {
          allowed: false,
          reason:
            `при активном этапе в рабочем репозитории запись разрешена только в ` +
            `${ARTIFACT_DIRS.map((d) => `${d}/`).join(' и ')} ` +
            `(запрошено: ${rel}); рабочие копии — только те, что в области этапа; ` +
            `временные файлы — в системный temp`,
        };
      }
      // …и только артефакт СВОЕГО этапа: иначе один этап заводит артефакты
      // будущих — так в 1.x первый этап заводил ещё и артефакты плана и
      // автотестов, а защита это пропускала.
      const own = scope && scope.stage ? STAGE_ARTIFACTS[scope.stage] : undefined;
      if (ARTIFACT_DIRS.includes(top) && rel !== top && own) {
        const base = path.basename(rel);
        if (base !== 'meta.json' && !own.includes(base)) {
          return {
            allowed: false,
            reason:
              `на этапе «${scope.stage}» в папке артефактов пишется только ` +
              (own.length ? own.join(', ') + ' и meta.json' : 'meta.json') +
              `; «${base}» производит другой этап конвейера (запрошено: ${rel})`,
          };
        }
      }
    }
    return { allowed: true };
  }

  // Системный temp — в последнюю очередь: явные корни выше имеют приоритет,
  // даже если физически лежат внутри temp.
  if (isInside(target, os.tmpdir())) return { allowed: true };

  return { allowed: false, reason: 'путь вне разрешённых корней' };
}
