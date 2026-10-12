// 設定驗證、原子寫入、跨程序鎖。
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  windows: ['five_hour', 'seven_day'],
  thresholds: { warn: 75, wind_down: 85, stop: 92 },
  poll_interval_seconds: 120,
  stale_after_seconds: 600,
  prompt_timeout_seconds: 90,
  snooze_step: 4,
  stop_grace_denials: 3,
  resume_file: 'RESUME.md',
  plan_files: [],
  notify: { desktop: true, webhook_url: null },
  chain_statusline: null,
});

export const WINDOWS = ['five_hour', 'seven_day'];

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isInteger = (v) => Number.isInteger(v);

// 回傳錯誤訊息清單；空陣列代表合法（§5）。
export function validateConfig(c) {
  const errors = [];
  const check = (ok, message) => {
    if (!ok) errors.push(message);
  };

  check(typeof c.enabled === 'boolean', 'enabled 必須是 true 或 false');
  check(
    Array.isArray(c.windows) &&
      c.windows.length > 0 &&
      c.windows.every((w) => WINDOWS.includes(w)) &&
      new Set(c.windows).size === c.windows.length,
    `windows 必須是 ${WINDOWS.join('／')} 的非空子集`,
  );

  const t = c.thresholds ?? {};
  check(
    [t.warn, t.wind_down, t.stop].every(isNumber) && t.warn > 0 && t.warn < t.wind_down && t.wind_down < t.stop && t.stop < 99,
    '門檻必須滿足 0 < warn < wind_down < stop < 99',
  );

  check(
    isInteger(c.poll_interval_seconds) && isInteger(c.stale_after_seconds) && c.poll_interval_seconds >= 60 && c.poll_interval_seconds <= c.stale_after_seconds,
    '必須滿足 60 ≤ poll_interval_seconds ≤ stale_after_seconds（皆為整數）',
  );
  check(
    isInteger(c.prompt_timeout_seconds) && c.prompt_timeout_seconds >= 10 && c.prompt_timeout_seconds <= 110,
    'prompt_timeout_seconds 必須是 10–110 的整數',
  );
  check(isNumber(c.snooze_step) && c.snooze_step >= 1 && c.snooze_step <= 10, 'snooze_step 必須介於 1 與 10');
  check(isInteger(c.stop_grace_denials) && c.stop_grace_denials >= 1, 'stop_grace_denials 必須是 ≥ 1 的整數');
  check(typeof c.resume_file === 'string' && c.resume_file.trim() !== '', 'resume_file 必須是非空字串');
  check(Array.isArray(c.plan_files) && c.plan_files.every((p) => typeof p === 'string'), 'plan_files 必須是字串陣列');

  const n = c.notify ?? {};
  check(typeof n.desktop === 'boolean', 'notify.desktop 必須是 true 或 false');
  check(n.webhook_url === null || (typeof n.webhook_url === 'string' && /^https?:\/\//.test(n.webhook_url)), 'notify.webhook_url 必須是 null 或 http(s) URL');
  check(c.chain_statusline === null || typeof c.chain_statusline === 'string', 'chain_statusline 必須是 null 或字串');

  return errors;
}

export function mergeConfig(partial) {
  const base = structuredClone(DEFAULT_CONFIG);
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) return base;
  return {
    ...base,
    ...partial,
    thresholds: { ...base.thresholds, ...(partial.thresholds ?? {}) },
    notify: { ...base.notify, ...(partial.notify ?? {}) },
  };
}

// 讀取設定並驗證。檔案不存在用預設值；壞掉或不合法時退回預設值並回報錯誤（fail-open）。
export function loadConfig(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, 'config.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { config: structuredClone(DEFAULT_CONFIG), errors: [] };
    return { config: structuredClone(DEFAULT_CONFIG), errors: [`無法讀取 config.json：${error.code}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: structuredClone(DEFAULT_CONFIG), errors: ['config.json 不是合法 JSON'] };
  }
  const config = mergeConfig(parsed);
  const errors = validateConfig(config);
  return errors.length ? { config: structuredClone(DEFAULT_CONFIG), errors } : { config, errors };
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRYABLE = new Set(['EPERM', 'EBUSY']);
const RETRIES = 5;

// 寫暫存檔再 rename。Windows 上讀者開著檔案時 rename 常回 EPERM（A15），
// 所以重試 5 次、間隔 20–50ms；仍失敗就放棄這次寫入，回傳 false。
export function atomicWrite(path, content, { rename = renameSync, sleep = sleepMs, random = Math.random } = {}) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content);
  } catch {
    return false;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, path);
      return true;
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= RETRIES) break;
      sleep(20 + Math.floor(random() * 31));
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // 暫存檔刪不掉也不影響正確性
  }
  return false;
}

export function writeJson(path, value, options) {
  return atomicWrite(path, JSON.stringify(value, null, 2) + '\n', options);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// 鎖的建立時間：優先看 owner.json，沒有（剛建立或寫入失敗）就看資料夾修改時間。
function lockCreatedAt(lockPath) {
  const owner = readJson(join(lockPath, 'owner.json'));
  if (owner && isNumber(owner.at)) return owner.at;
  try {
    return statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function tryMkdirLock(lockPath, token, now) {
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: now, token }));
  return true;
}

// 以 mkdir 當跨程序鎖（A16）。成功回傳 token，失敗立即回傳 null，不等待。
// 超過 ttlSeconds 的鎖視為死鎖：先 rename 成唯一名稱再刪除，避免兩個程序同時回收時互相刪掉對方的新鎖。
export function acquireLock(dir, name, { ttlSeconds, now = Date.now } = {}) {
  const lockPath = join(dir, name);
  const token = randomBytes(8).toString('hex');
  if (tryMkdirLock(lockPath, token, now())) return token;

  const createdAt = lockCreatedAt(lockPath);
  if (createdAt === null || now() - createdAt <= ttlSeconds * 1000) return null;

  const graveyard = `${lockPath}.stale.${token}`;
  try {
    renameSync(lockPath, graveyard);
  } catch {
    return null; // 別的程序已經先回收了
  }
  rmSync(graveyard, { recursive: true, force: true });
  return tryMkdirLock(lockPath, token, now()) ? token : null;
}

// 每個 session 在每個分段只注入一次（FR-2）。以「建立檔案時若已存在就失敗」的方式，
// 讓同一則訊息裡平行的 PreToolUse 也只有一個搶到。回傳 true 代表這次該注入。
export function claimInjection(dir, sessionId, key) {
  const safeSession = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  const injectedDir = join(dir, 'injected');
  mkdirSync(injectedDir, { recursive: true });
  try {
    writeFileSync(join(injectedDir, `${safeSession}.${key}`), '', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function releaseLock(dir, name, token) {
  const lockPath = join(dir, name);
  const owner = readJson(join(lockPath, 'owner.json'));
  if (!owner || owner.token !== token) return false;
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}
