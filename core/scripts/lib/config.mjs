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
// через эти два хелпера.
export function parseJsonText(text) {
  const str = String(text);
  return JSON.parse(str.charCodeAt(0) === 0xfeff ? str.slice(1) : str);
}

export function readJsonFile(file) {
  return parseJsonText(fs.readFileSync(file, 'utf8'));
}

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
  const text = fs.readFileSync(envPath, 'utf8');
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

// Read + resolve. Returns a rich object; never throws for the common cases.
//   { found:false }                              — no settings.json
//   { found:true, error:'...' }                  — settings.json unparseable
//   { found:true, workspaceRoot, config,         — success
//     fastMode, links, missingLinks, urlLinks }
//
// links[key] = { value, isGitUrl, path, inside, mainBranch }
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
    const value = (((config.repos && config.repos[key] && config.repos[key].link) || '') + '').trim();
    const mainBranch =
      (((config.repos && config.repos[key] && config.repos[key].mainBranch) || '') + '').trim() || 'main';
    // Нормализованные значения пишем обратно в config: stage-файлы отсылают
    // модель к config.repos.<ключ>.link, ядро считает по links[key].value —
    // два написания одного значения расходились бы на пробелах.
    if (config.repos && config.repos[key]) {
      config.repos[key].link = value;
      config.repos[key].mainBranch = mainBranch;
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
  const scope = scopeState.state === 'active' ? scopeState.scope : null;
  const scopedKeys = scope ? scope.writeRepos : null; // null = no scope
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
      if (!scopedKeys || scopedKeys.includes(hit.key)) return { allowed: true };
      return {
        allowed: false,
        reason:
          `рабочая копия «${hit.key}» вне рабочей области текущего этапа` +
          (scope && scope.stage
            ? ` (${scope.stage}: запись — ${scopedKeys.length ? scopedKeys.join(', ') : 'только артефакты задачи'}; ${CLEAR_HINT})`
            : ''),
      };
    }

    // При активном этапе workspace — только артефакты: tasks/, intents/ и
    // файлы конфигурации. Пробные/временные файлы в корне (test-write.txt
    // и т.п.) запрещены — временное пишите в системный temp. `repos` в списке
    // намеренно нет: настроенная рабочая копия сюда не доходит (она матчится
    // выше как kind:'repo'), а всё прочее в repos/ — чужой клон.
    if (scopedKeys || corrupt) {
      const rel = path.relative(wsRoot, target);
      const top = rel.split(path.sep)[0];
      const allowedTop = ['tasks', 'intents', 'settings.json', '.env', '.env.example', '.gitignore'];
      if (rel !== '' && !allowedTop.includes(top)) {
        return {
          allowed: false,
          reason:
            `при активном этапе в рабочем репозитории запись разрешена только в tasks/ и intents/ ` +
            `(запрошено: ${rel}); рабочие копии — только те, что в области этапа; ` +
            `временные файлы — в системный temp`,
        };
      }
      // В tasks/ и intents/ — только артефакты (*.md, meta.json). Исходники
      // кладутся в рабочую копию кодовой базы, а не в папку артефактов
      // фасадного репо.
      if ((top === 'tasks' || top === 'intents') && rel !== top && !isTaskArtifactFile(rel)) {
        const hint =
          top === 'tasks'
            ? 'в папке задачи разрешены только артефакты (*.md, meta.json); ' +
              'исходники пиши в рабочую копию кодовой базы'
            : 'в папке интента разрешены только артефакты (*.md, meta.json); ' +
              'интент — документ, исходникам в нём не место';
        return { allowed: false, reason: `${hint} (запрошено: ${rel})` };
      }
    }
    return { allowed: true };
  }

  // Системный temp — в последнюю очередь: явные корни выше имеют приоритет,
  // даже если физически лежат внутри temp.
  if (isInside(target, os.tmpdir())) return { allowed: true };

  return { allowed: false, reason: 'путь вне разрешённых корней' };
}
