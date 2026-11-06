import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_AUTH_STATE_FILE = path.resolve('.playwright-auth-state.json');
const AUTH_LOCK_SUFFIX = '.lock';
const AUTH_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;
let authStateCache = null;

function resolveAuthStateFile() {
  return path.resolve(process.env.PLAYWRIGHT_AUTH_STATE_FILE ?? DEFAULT_AUTH_STATE_FILE);
}

function isStorageState(value) {
  return Boolean(value)
    && Array.isArray(value.cookies)
    && Array.isArray(value.origins);
}

function hasStoredAuth(value) {
  if (!isStorageState(value)) return false;
  return value.cookies.length > 0
    || value.origins.some((origin) => (
      (Array.isArray(origin.localStorage) && origin.localStorage.length > 0)
      || (origin.indexedDB && Object.keys(origin.indexedDB).length > 0)
    ));
}

async function loadAuthStateRecord() {
  const filePath = resolveAuthStateFile();

  try {
    const fileStat = await stat(filePath);
    const signature = `${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
    if (authStateCache?.filePath === filePath && authStateCache.signature === signature) {
      return authStateCache.record;
    }

    let record = null;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (hasStoredAuth(parsed)) record = { state: parsed, signature, serialized: JSON.stringify(parsed) };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    authStateCache = { filePath, signature, record };
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') {
      authStateCache = null;
      return null;
    }
    throw error;
  }
}

export async function loadAuthState() {
  const state = (await loadAuthStateRecord())?.state;
  return state ? structuredClone(state) : null;
}

export function getAuthStateFile() {
  return resolveAuthStateFile();
}

export async function saveAuthState(context) {
  if (typeof context?.storageState !== 'function') return null;

  const state = await context.storageState({ indexedDB: true });
  if (!hasStoredAuth(state)) return null;

  const filePath = resolveAuthStateFile();
  await mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => null);
  }

  return filePath;
}

function mergeCookies(currentCookies, sharedCookies) {
  const cookies = new Map();
  for (const cookie of currentCookies ?? []) {
    cookies.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, cookie);
  }
  for (const cookie of sharedCookies ?? []) {
    cookies.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, cookie);
  }
  return [...cookies.values()];
}

function mergeOrigins(currentOrigins, sharedOrigins) {
  const origins = new Map();
  for (const origin of currentOrigins ?? []) origins.set(origin.origin, origin);

  for (const sharedOrigin of sharedOrigins ?? []) {
    const currentOrigin = origins.get(sharedOrigin.origin);
    if (!currentOrigin) {
      origins.set(sharedOrigin.origin, sharedOrigin);
      continue;
    }

    const localStorage = new Map();
    for (const entry of currentOrigin.localStorage ?? []) localStorage.set(entry.name, entry);
    for (const entry of sharedOrigin.localStorage ?? []) localStorage.set(entry.name, entry);
    origins.set(sharedOrigin.origin, {
      ...currentOrigin,
      ...sharedOrigin,
      localStorage: [...localStorage.values()],
    });
  }

  return [...origins.values()];
}

function canApplyStorageState(context) {
  return Boolean(
    typeof context?.setStorageState === 'function'
      || (
        typeof context?.clearCookies === 'function'
        && typeof context?.addCookies === 'function'
        && typeof context?.newPage === 'function'
      ),
  );
}

async function applyStorageState(context, state) {
  if (!isStorageState(state) || !canApplyStorageState(context)) return false;

  if (typeof context.setStorageState === 'function') {
    await context.setStorageState(state);
    return true;
  }

  await context.clearCookies();
  if (state.cookies.length > 0) await context.addCookies(state.cookies);

  for (const origin of state.origins) {
    if (!origin?.origin || !Array.isArray(origin.localStorage)) continue;

    const page = await context.newPage();
    try {
      await page.goto(origin.origin, { waitUntil: 'domcontentloaded' });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const { name, value } of entries) localStorage.setItem(name, value);
      }, origin.localStorage);
    } finally {
      await page.close().catch(() => null);
    }
  }

  return true;
}

export function canApplyAuthState(context) {
  return canApplyStorageState(context);
}

export async function snapshotAuthState(context) {
  if (typeof context?.storageState !== 'function') return null;

  const state = await context.storageState({ indexedDB: true });
  return isStorageState(state) ? state : null;
}

export async function restoreAuthState(context, state) {
  return applyStorageState(context, state);
}

/**
 * Merge a shared snapshot into the current persistent profile without
 * discarding cookies issued by the profile's own SSO domain.
 */
export async function mergeAuthState(context, sharedState) {
  if (!canApplyStorageState(context) || !isStorageState(sharedState)) return false;

  const currentState = typeof context.storageState === 'function'
    ? await context.storageState({ indexedDB: true }).catch(() => ({ cookies: [], origins: [] }))
    : { cookies: [], origins: [] };
  return applyStorageState(context, {
    ...sharedState,
    cookies: mergeCookies(currentState.cookies, sharedState.cookies),
    origins: mergeOrigins(currentState.origins, sharedState.origins),
  });
}

async function removeStaleAuthLock(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    let ownerAlive = true;
    try {
      const lockInfo = JSON.parse(await readFile(lockPath, 'utf8'));
      if (Number.isInteger(lockInfo.pid) && lockInfo.pid !== process.pid) {
        try {
          process.kill(lockInfo.pid, 0);
        } catch (error) {
          ownerAlive = error.code !== 'ESRCH';
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    if (ownerAlive && Date.now() - lockStat.mtimeMs <= AUTH_LOCK_STALE_AFTER_MS) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

/**
 * Elects one browser process to perform interactive authentication. Other
 * processes can wait for the shared storage state instead of opening another
 * login flow at the same time.
 */
export async function acquireAuthLock() {
  const lockPath = `${resolveAuthStateFile()}${AUTH_LOCK_SUFFIX}`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => null);
        await rm(lockPath, { force: true }).catch(() => null);
        throw error;
      }

      let released = false;
      return {
        lockPath,
        async release() {
          if (released) return;
          released = true;
          await rm(lockPath, { force: true }).catch(() => null);
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await removeStaleAuthLock(lockPath))) return null;
    }
  }

  return null;
}

export async function waitForAuthState({
  page,
  targetUrl,
  readyLocator,
  timeoutMs = 5 * 60 * 1000,
  initialState = null,
  isReady = null,
}) {
  if (typeof page?.context !== 'function' || typeof page?.goto !== 'function') return false;

  const context = page.context();
  if (!canApplyStorageState(context)) return false;

  const deadline = Date.now() + timeoutMs;
  const initialSerialized = initialState ? JSON.stringify(initialState) : null;
  const initialRecord = await loadAuthStateRecord();
  const initialSignature = initialRecord?.signature ?? null;
  let appliedSignature = null;

  while (Date.now() < deadline) {
    const record = await loadAuthStateRecord();
    const state = record?.state ?? null;
    const stateChanged = Boolean(state) && (
      !initialState
      || record.signature !== initialSignature
      || record.serialized !== initialSerialized
    );
    if (stateChanged && record.signature !== appliedSignature) {
      try {
        await mergeAuthState(context, state);
        appliedSignature = record.signature;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(10000, remainingMs),
        }).catch(() => null);
      } catch {
        // Retry a snapshot if applying it failed before navigation.
      }
    }

    // A stale snapshot must not consume the entire login deadline: keep
    // polling for newer state while allowing the current page to render.
    if (appliedSignature && Date.now() < deadline) {
      const ready = await readyLocator.waitFor({
        state: 'visible',
        timeout: Math.max(1, Math.min(1000, deadline - Date.now())),
      }).then(() => true).catch(() => false);
      if (ready && (!isReady || await isReady())) return true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await page.waitForTimeout(Math.min(400, remainingMs));
  }

  return false;
}
