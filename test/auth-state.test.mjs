import assert from 'node:assert/strict';
import { access, mkdtemp, open, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireAuthLock,
  loadAuthState,
  mergeAuthState,
  restoreAuthState,
  saveAuthState,
  snapshotAuthState,
  waitForAuthState,
} from '../scripts/auth-state.mjs';

const AUTH_STATE = {
  cookies: [{
    name: 'session',
    value: 'token',
    domain: '.example.test',
    path: '/',
  }],
  origins: [{
    origin: 'https://example.test',
    localStorage: [{ name: 'user', value: 'admin' }],
  }],
};

async function withAuthStateFile(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playwright-auth-'));
  const filePath = path.join(directory, 'auth-state.json');
  const previous = process.env.PLAYWRIGHT_AUTH_STATE_FILE;
  process.env.PLAYWRIGHT_AUTH_STATE_FILE = filePath;

  try {
    return await callback(filePath);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_AUTH_STATE_FILE;
    else process.env.PLAYWRIGHT_AUTH_STATE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('saves and reloads a non-empty shared storage state atomically', async () => {
  await withAuthStateFile(async (filePath) => {
    await saveAuthState({ async storageState() { return AUTH_STATE; } });
    assert.deepEqual(await loadAuthState(), AUTH_STATE);
    assert.equal(await saveAuthState({ async storageState() { return { cookies: [], origins: [] }; } }), null);
    await access(filePath);
  });
});

test('cached state stays isolated from callers and detects atomic replacements with the same timestamp', async () => {
  await withAuthStateFile(async (filePath) => {
    await saveAuthState({ async storageState() { return AUTH_STATE; } });
    const originalStat = await stat(filePath);
    const state = await loadAuthState();
    state.cookies[0].value = 'mutated';
    assert.deepEqual(await loadAuthState(), AUTH_STATE);

    const replacement = structuredClone(AUTH_STATE);
    replacement.cookies[0].value = 'fresh';
    await writeFile(`${filePath}.replacement`, JSON.stringify(replacement));
    await utimes(`${filePath}.replacement`, originalStat.atime, originalStat.mtime);
    await rename(`${filePath}.replacement`, filePath);
    assert.deepEqual(await loadAuthState(), replacement);

    await writeFile(filePath, '{invalid');
    assert.equal(await loadAuthState(), null);
    assert.equal(await loadAuthState(), null);
    await writeFile(filePath, JSON.stringify(AUTH_STATE));
    assert.deepEqual(await loadAuthState(), AUTH_STATE);
    await rm(filePath);
    assert.equal(await loadAuthState(), null);
  });
});

test('concurrent saves in the same millisecond use separate temporary files', async (t) => {
  await withAuthStateFile(async (filePath) => {
    const instant = Date.now();
    t.mock.method(Date, 'now', () => instant);
    try {
      await Promise.all(Array.from({ length: 8 }, () => (
        saveAuthState({ async storageState() { return AUTH_STATE; } })
      )));
      assert.deepEqual(await loadAuthState(), AUTH_STATE);
      assert.deepEqual(await readdir(path.dirname(filePath)), [path.basename(filePath)]);
    } finally {
      t.mock.restoreAll();
    }
  });
});

test('snapshots and restores storage state through the browser context', async () => {
  let restoredState = null;
  const context = {
    async storageState(options) {
      assert.deepEqual(options, { indexedDB: true });
      return AUTH_STATE;
    },
    async setStorageState(state) {
      restoredState = state;
    },
  };

  assert.deepEqual(await snapshotAuthState(context), AUTH_STATE);
  assert.equal(await restoreAuthState(context, AUTH_STATE), true);
  assert.deepEqual(restoredState, AUTH_STATE);
});

test('restores storage state with cookie and localStorage APIs when needed', async () => {
  let clearedCookies = false;
  let addedCookies = null;
  const pages = [];
  const context = {
    async clearCookies() {
      clearedCookies = true;
    },
    async addCookies(cookies) {
      addedCookies = cookies;
    },
    async newPage() {
      const page = {
        gotoCalls: [],
        entries: null,
        closed: false,
        async goto(url, options) {
          this.gotoCalls.push({ url, options });
        },
        async evaluate(_callback, entries) {
          this.entries = entries;
        },
        async close() {
          this.closed = true;
        },
      };
      pages.push(page);
      return page;
    },
  };

  assert.equal(await restoreAuthState(context, AUTH_STATE), true);
  assert.equal(clearedCookies, true);
  assert.deepEqual(addedCookies, AUTH_STATE.cookies);
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].gotoCalls, [{
    url: 'https://example.test',
    options: { waitUntil: 'domcontentloaded' },
  }]);
  assert.deepEqual(pages[0].entries, AUTH_STATE.origins[0].localStorage);
  assert.equal(pages[0].closed, true);
});

test('merges shared state without discarding the profile SSO cookie', async () => {
  let mergedState;
  const context = {
    async storageState() {
      return {
        cookies: [{ name: 'sso', value: 'keep', domain: 'id.internal.osase.net', path: '/' }],
        origins: [{
          origin: 'https://console.osase.net',
          localStorage: [{ name: 'existing', value: 'keep' }],
        }],
      };
    },
    async setStorageState(state) {
      mergedState = state;
    },
  };

  assert.equal(await mergeAuthState(context, AUTH_STATE), true);
  assert.deepEqual(mergedState.cookies.map(({ name }) => name), ['sso', 'session']);
  assert.deepEqual(mergedState.origins.find(({ origin }) => origin === 'https://console.osase.net').localStorage, [
    { name: 'existing', value: 'keep' },
  ]);
  assert.deepEqual(mergedState.origins.find(({ origin }) => origin === 'https://example.test').localStorage, [
    { name: 'user', value: 'admin' },
  ]);
});

test('allows only one browser process to own the interactive auth lock', async () => {
  await withAuthStateFile(async () => {
    const first = await acquireAuthLock();
    const second = await acquireAuthLock();
    assert.ok(first);
    assert.equal(second, null);

    await first.release();
    const third = await acquireAuthLock();
    assert.ok(third);
    await third.release();
  });
});

test('reclaims a lock whose owner process no longer exists', async () => {
  await withAuthStateFile(async (filePath) => {
    await writeFile(`${filePath}.lock`, JSON.stringify({ pid: 2147483647 }));
    const lock = await acquireAuthLock();
    assert.ok(lock);
    await lock.release();
  });
});

test('a failed lock write closes the file and allows a later caller to acquire the lock', async (t) => {
  await withAuthStateFile(async (filePath) => {
    const probe = await open(`${filePath}.probe`, 'w');
    const handlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const failure = new Error('disk full');
    failure.code = 'ENOSPC';
    let failedHandle;
    t.mock.method(handlePrototype, 'writeFile', async function failWrite() {
      failedHandle = this;
      throw failure;
    });
    try {
      await assert.rejects(acquireAuthLock(), failure);
      assert.equal(failedHandle.fd, -1);
      await assert.rejects(access(`${filePath}.lock`), { code: 'ENOENT' });
    } finally {
      t.mock.restoreAll();
    }
    const lock = await acquireAuthLock();
    assert.ok(lock);
    await lock.release();
  });
});

test('applies a newly written state to a browser that was already waiting', async () => {
  await withAuthStateFile(async () => {
    let ready = false;
    let appliedState = null;
    const page = {
      context() {
        return {
          async setStorageState(state) {
            appliedState = state;
            ready = true;
          },
        };
      },
      async goto(url) {
        assert.equal(url, 'https://example.test/admin');
      },
      async waitForTimeout(milliseconds) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 10)));
      },
    };
    const readyLocator = {
      async waitFor() {
        if (!ready) throw new Error('not ready');
      },
    };

    setTimeout(() => saveAuthState({ async storageState() { return AUTH_STATE; } }), 20);
    assert.equal(await waitForAuthState({
      page,
      targetUrl: 'https://example.test/admin',
      readyLocator,
      timeoutMs: 500,
    }), true);
    assert.deepEqual(appliedState, AUTH_STATE);
  });
});

test('keeps rendering the same snapshot without repeatedly restoring state or navigating', async () => {
  await withAuthStateFile(async () => {
    await saveAuthState({ async storageState() { return AUTH_STATE; } });
    let restores = 0;
    let navigations = 0;
    let readyChecks = 0;
    const context = { async setStorageState() { restores += 1; } };
    const page = {
      context() { return context; },
      async goto() { navigations += 1; },
      async waitForTimeout() {},
    };
    const readyLocator = {
      async waitFor() {
        readyChecks += 1;
        if (readyChecks < 3) throw new Error('still rendering');
      },
    };

    assert.equal(await waitForAuthState({
      page,
      targetUrl: 'https://example.test/admin',
      readyLocator,
      timeoutMs: 500,
    }), true);
    assert.equal(restores, 1);
    assert.equal(navigations, 1);
    assert.equal(readyChecks, 3);
  });
});

test('an invalid shared snapshot does not prevent a later valid snapshot from being applied', async () => {
  await withAuthStateFile(async () => {
    await saveAuthState({ async storageState() { return AUTH_STATE; } });
    const replacement = structuredClone(AUTH_STATE);
    replacement.cookies[0].value = 'fresh';
    const appliedTokens = [];
    const readyTimeouts = [];
    const context = {
      async setStorageState(state) { appliedTokens.push(state.cookies[0].value); },
    };
    const page = {
      context() { return context; },
      async goto() {},
      async waitForTimeout() {
        await saveAuthState({ async storageState() { return replacement; } });
      },
    };
    const readyLocator = {
      async waitFor({ timeout }) {
        readyTimeouts.push(timeout);
        if (appliedTokens.at(-1) !== 'fresh') throw new Error('expired snapshot');
      },
    };

    assert.equal(await waitForAuthState({
      page,
      targetUrl: 'https://example.test/admin',
      readyLocator,
      timeoutMs: 5000,
    }), true);
    assert.deepEqual(appliedTokens, ['token', 'fresh']);
    assert.ok(readyTimeouts.every((timeout) => timeout > 0 && timeout <= 1000));
  });
});

test('waiting browsers reject a visible shell until the shared session passes server verification', async () => {
  await withAuthStateFile(async () => {
    await saveAuthState({ async storageState() { return AUTH_STATE; } });
    const fresh = structuredClone(AUTH_STATE);
    fresh.cookies[0].value = 'fresh';
    const appliedTokens = [];
    let verified = 0;
    const page = {
      context() { return { async setStorageState(state) { appliedTokens.push(state.cookies[0].value); } }; },
      async goto() {},
      async waitForTimeout() { await saveAuthState({ async storageState() { return fresh; } }); },
    };
    assert.equal(await waitForAuthState({
      page, targetUrl: 'https://example.test/admin',
      readyLocator: { async waitFor() {} }, // The shell is always visible.
      async isReady() { verified += 1; return appliedTokens.at(-1) === 'fresh'; },
      timeoutMs: 1000,
    }), true);
    assert.deepEqual(appliedTokens, ['token', 'fresh']);
    assert.equal(verified, 2);
  });
});
