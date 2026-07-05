// Shared configuration reader for the conveyor plugin.
//
// This module is the ONLY place that reads settings.json + .env and resolves
// ${VAR} placeholders (spec 4.1). resolve-config / validate-config / guard-*
// / git-ops all build on it. No platform APIs — only node:fs / node:path /
// node:os, so the core stays free of platform-specific dependencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VAR_RE = /\$\{([A-Za-z0-9_]+)\}/g;

// The four repositories, in the order they appear in settings.json.
export const REPO_KEYS = ['systemsAnalysis', 'frontend', 'backend', 'autoTest'];

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

// A link is treated as a git URL (needs cache clone) when it looks like
// ssh/https/git syntax rather than a filesystem path.
export function isGitUrl(value) {
  if (!value) return false;
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || // https://, ssh://, git://
    /^git@/.test(value) ||                     // git@host:group/repo.git
    /^[\w.-]+@[\w.-]+:/.test(value)            // user@host:path (scp-like)
  );
}

// Read + resolve. Returns a rich object; never throws for the common cases.
//   { found:false }                              — no settings.json
//   { found:true, error:'...' }                  — settings.json unparseable
//   { found:true, workspaceRoot, config,         — success
//     repoCacheEnabled, links, missingVars }
//
// links[key] = { varName|null, value, isGitUrl, resolved(bool), mainBranch }
// missingVars = referenced env var names that resolved to empty AND are not
//               the repoCache flag (empty repoCache is intentional = off).
export function readConfig(startDir = process.cwd()) {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) return { found: false };

  const settingsPath = path.join(workspaceRoot, 'settings.json');
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { found: true, workspaceRoot, error: `settings.json: ${e.message}` };
  }

  const env = {
    ...parseEnvFile(path.join(workspaceRoot, '.env')),
    ...process.env, // process environment wins over .env
  };

  const referenced = new Map(); // varName -> resolved value ('' if unresolved)
  const resolveStr = (str) =>
    str.replace(VAR_RE, (_, name) => {
      const v = env[name];
      const value = v === undefined ? '' : v;
      referenced.set(name, value);
      return value;
    });

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
  const repoCacheEnabled = normalizeBool(config.repoCache);
  // reviewRounds comes from env (${VAR}); empty/invalid -> default 2.
  config.reviewRounds = normalizeReviewRounds(config.reviewRounds);

  // Per-repo link details, tracing each link back to its ${VAR}.
  const links = {};
  const rawRepos = settings.repos || {};
  const mainBranchVars = []; // ${VAR} names behind repos.*.mainBranch
  for (const key of REPO_KEYS) {
    const rawLink = rawRepos[key] && rawRepos[key].link;
    const value = (config.repos && config.repos[key] && config.repos[key].link) || '';
    const m = typeof rawLink === 'string' ? rawLink.match(/^\$\{([A-Za-z0-9_]+)\}$/) : null;

    // mainBranch also comes from env (${VAR}); empty -> default 'main'.
    const rawBranch = rawRepos[key] && rawRepos[key].mainBranch;
    const bm = typeof rawBranch === 'string' ? rawBranch.match(/^\$\{([A-Za-z0-9_]+)\}$/) : null;
    if (bm) mainBranchVars.push(bm[1]);
    const mainBranch =
      (((config.repos && config.repos[key] && config.repos[key].mainBranch) || '') + '').trim() ||
      'main';
    if (config.repos && config.repos[key]) config.repos[key].mainBranch = mainBranch;

    links[key] = {
      varName: m ? m[1] : null,
      value,
      isGitUrl: isGitUrl(value),
      resolved: value !== '',
      mainBranch,
    };
  }

  // Optional vars whose empty value is intentional (a default applies) and
  // therefore must never be reported as "missing": repoCache, reviewRounds,
  // and every repos.*.mainBranch (empty -> 'main').
  const optionalVars = new Set(
    [settings.repoCache, settings.reviewRounds]
      .map((raw) => (typeof raw === 'string' ? (raw.match(/^\$\{([A-Za-z0-9_]+)\}$/) || [])[1] : null))
      .filter(Boolean)
      .concat(mainBranchVars),
  );

  const missingVars = [];
  for (const [name, value] of referenced) {
    if (value === '' && !optionalVars.has(name)) missingVars.push(name);
  }

  return {
    found: true,
    workspaceRoot,
    config,
    repoCacheEnabled,
    links,
    missingVars,
  };
}

// Which repos a stage needs (spec 4.4). taskType is 'FE' | 'BE' | undefined.
export function requiredRepoKeys(stage, taskType) {
  const code = taskType === 'BE' ? 'backend' : 'frontend';
  switch (stage) {
    case 'setup':
    case 'task-status':
      return [];
    case 'create-feature':
    case 'create-specification':
      return ['systemsAnalysis'];
    case 'create-plan':
    case 'implement-plan':
    case 'create-requirements-auto-test':
      return [code];
    case 'implement-auto-test':
      return ['autoTest', code];
    default:
      return [];
  }
}

// Directories writes are allowed into (guard-writes / guard-bash), spec 8.1.
export function allowedRoots(cfg) {
  const roots = [cfg.workspaceRoot, path.join(cfg.workspaceRoot, '.cache'), os.tmpdir()];
  for (const key of REPO_KEYS) {
    const l = cfg.links[key];
    if (l.resolved && !l.isGitUrl) roots.push(path.resolve(l.value));
  }
  return roots.map((r) => path.resolve(r));
}

// True when childPath is the same as, or nested inside, parentDir.
export function isInside(childPath, parentDir) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPathAllowed(targetPath, cfg) {
  return allowedRoots(cfg).some((root) => isInside(targetPath, root));
}
