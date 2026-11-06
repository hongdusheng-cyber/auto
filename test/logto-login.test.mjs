import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { acquireAuthLock, loadAuthState } from '../scripts/auth-state.mjs';
import { verifyAdminSession, waitForPageWithLogtoLogin } from '../scripts/logto-login.mjs';

const TARGET_URL = 'https://console.osase.net/admin/manage/user/user-company-list';
const ADMIN_LOGIN_URL = 'https://console.osase.net/admin/login/account';
const LOGTO_URL = 'https://id.internal.osase.net/sign-in?app_id=test';

function authState(token) {
  return {
    cookies: [{ name: 'session', value: token, domain: 'console.osase.net', path: '/' }],
    origins: [],
  };
}

async function withSharedAuth(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'logto-login-test-'));
  const filePath = path.join(directory, 'auth-state.json');
  const previous = process.env.PLAYWRIGHT_AUTH_STATE_FILE;
  process.env.PLAYWRIGHT_AUTH_STATE_FILE = filePath;
  const writeState = (token) => writeFile(filePath, JSON.stringify(authState(token)));
  try {
    await callback(writeState);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_AUTH_STATE_FILE;
    else process.env.PLAYWRIGHT_AUTH_STATE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeLocator {
  constructor(page, name) {
    this.page = page;
    this.name = name;
  }

  async count() {
    return this.page.isVisible(this.name) ? 1 : 0;
  }

  nth() {
    return this;
  }

  first() {
    return this;
  }

  async isVisible() {
    return this.page.isVisible(this.name);
  }

  async waitFor() {
    this.page.readyWaits += 1;
    if (!this.page.isVisible(this.name)) throw new Error('not visible');
  }

  async click() {
    this.page.click(this.name);
  }
}

class FakePage {
  constructor({ authenticated = false } = {}) {
    this.authenticated = authenticated;
    this.state = authenticated ? 'target' : 'consumerLogin';
    this.logtoClicks = 0;
    this.loginClicks = 0;
    this.readyWaits = 0;
  }

  getByRole(_role, { name }) {
    return new FakeLocator(this, name);
  }

  locator(_selector, { hasText } = {}) {
    const label = hasText?.source.includes('使用 Logto 登录') ? '使用 Logto 登录' : '登录';
    return new FakeLocator(this, label);
  }

  isVisible(name) {
    if (name === '添加用户') return this.state === 'target';
    if (name === '使用 Logto 登录') return this.state === 'login';
    if (name === '登录') return this.state === 'logto';
    return false;
  }

  click(name) {
    if (name === '使用 Logto 登录' && this.state === 'login') {
      this.logtoClicks += 1;
      this.state = 'logto';
      return;
    }

    if (name === '登录' && this.state === 'logto') {
      this.loginClicks += 1;
      this.authenticated = true;
      this.state = 'home';
      return;
    }

    throw new Error(`cannot click ${name} in ${this.state}`);
  }

  url() {
    if (this.state === 'target') return TARGET_URL;
    if (this.state === 'login') return ADMIN_LOGIN_URL;
    if (this.state === 'consumerLogin') return 'https://console.osase.net/login/account';
    if (this.state === 'logto') return LOGTO_URL;
    return 'https://console.osase.net/admin';
  }

  async goto(url) {
    if (url === TARGET_URL) {
      this.state = this.authenticated ? 'target' : 'login';
      return;
    }

    if (url === ADMIN_LOGIN_URL) this.state = 'login';
  }

  async waitForTimeout() {}

  async evaluate() {
    return { authenticated: this.authenticated };
  }
}

class AuthFakePage extends FakePage {
  constructor() {
    super();
    this.appliedTokens = [];
    this.gotoCalls = [];
    this.savedState = authState('expired');
    this.browserContext = {
      storageState: async () => structuredClone(this.savedState),
      setStorageState: async (state) => {
        this.savedState = structuredClone(state);
        const token = state.cookies.find(({ name }) => name === 'session')?.value;
        this.appliedTokens.push(token);
        this.authenticated = token === 'fresh';
      },
    };
  }

  context() {
    return this.browserContext;
  }

  async goto(url) {
    this.gotoCalls.push(url);
    await super.goto(url);
  }

  click(name) {
    super.click(name);
    if (name === '登录' && this.authenticated) this.savedState = authState('fresh');
  }
}

function authOptions(page, overrides = {}) {
  return {
    targetUrl: TARGET_URL,
    readyLocator: page.getByRole('button', { name: '添加用户' }),
    readyDescription: '用户管理列表',
    userDataDir: '/tmp/test-profile',
    initialTimeoutMs: 1,
    manualLoginTimeoutMs: 1000,
    ...overrides,
  };
}

test('uses Logto and clicks login before returning to the target page', async () => {
  const page = new FakePage();

  await waitForPageWithLogtoLogin(page, {
    targetUrl: TARGET_URL,
    readyLocator: page.getByRole('button', { name: '添加用户' }),
    readyDescription: '用户管理列表',
    userDataDir: '/tmp/test-profile',
    initialTimeoutMs: 1,
    manualLoginTimeoutMs: 100,
  });

  assert.equal(page.url(), TARGET_URL);
  assert.equal(page.logtoClicks, 1);
  assert.equal(page.loginClicks, 1);
  assert.equal(page.readyWaits, 0, 'an identified login page should not wait for the target UI');
  assert.equal(await page.getByRole('button', { name: '添加用户' }).isVisible(), true);
});

test('continues immediately when the target page is already authenticated', async () => {
  const page = new FakePage({ authenticated: true });

  await waitForPageWithLogtoLogin(page, {
    targetUrl: TARGET_URL,
    readyLocator: page.getByRole('button', { name: '添加用户' }),
    readyDescription: '用户管理列表',
    userDataDir: '/tmp/test-profile',
    initialTimeoutMs: 1,
  });

  assert.equal(page.logtoClicks, 0);
  assert.equal(page.loginClicks, 0);
  assert.equal(page.readyWaits, 0);
});

test('stops waiting for the target UI as soon as navigation reaches login', async () => {
  const page = new FakePage();
  page.state = 'loading';
  const readyLocator = page.getByRole('button', { name: '添加用户' });
  const timeouts = [];
  readyLocator.waitFor = async ({ timeout }) => {
    timeouts.push(timeout);
    page.state = 'consumerLogin';
    throw new Error('redirected to login');
  };

  await waitForPageWithLogtoLogin(page, {
    targetUrl: TARGET_URL,
    readyLocator,
    readyDescription: '用户管理列表',
    userDataDir: '/tmp/test-profile',
    initialTimeoutMs: 15000,
    manualLoginTimeoutMs: 100,
  });

  assert.deepEqual(timeouts, [250]);
  assert.equal(page.url(), TARGET_URL);
});

test('fresh authentication skips the rejected shared snapshot and saves the new login', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const page = new AuthFakePage();

    await waitForPageWithLogtoLogin(page, authOptions(page, { reuseSharedAuth: false }));

    assert.deepEqual(page.appliedTokens, []);
    assert.equal(page.logtoClicks, 1);
    assert.equal(page.loginClicks, 1);
    assert.equal(page.url(), TARGET_URL);
    assert.deepEqual(await loadAuthState(), authState('fresh'));
  });
});

test('default login coordination restores a valid shared snapshot', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('fresh');
    const page = new AuthFakePage();

    await waitForPageWithLogtoLogin(page, authOptions(page));

    assert.deepEqual(page.appliedTokens, ['fresh']);
    assert.equal(page.logtoClicks, 0);
    assert.equal(page.loginClicks, 0);
    assert.equal(page.url(), TARGET_URL);
  });
});

test('default login preserves a healthy profile despite an expired shared snapshot', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const page = new AuthFakePage();
    page.authenticated = true;
    page.state = 'target';
    page.savedState = authState('fresh');

    await waitForPageWithLogtoLogin(page, authOptions(page));

    assert.deepEqual(page.appliedTokens, []);
    assert.deepEqual(page.gotoCalls, []);
    assert.equal(page.loginClicks, 0);
    assert.equal(page.url(), TARGET_URL);
    assert.deepEqual(page.savedState, authState('fresh'));
    assert.deepEqual(await loadAuthState(), authState('fresh'));
  });
});

test('disabling startup restoration still restores a signed-out profile from valid shared state', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('fresh');
    const page = new AuthFakePage();

    await waitForPageWithLogtoLogin(page, authOptions(page, { restoreSharedAuthOnStart: false }));

    assert.deepEqual(page.appliedTokens, ['fresh']);
    assert.deepEqual(page.gotoCalls, [TARGET_URL]);
    assert.equal(page.logtoClicks, 0);
    assert.equal(page.loginClicks, 0);
    assert.equal(page.url(), TARGET_URL);
  });
});

test('an unchanged rejected snapshot is applied only once before Logto authentication', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const page = new AuthFakePage();

    await waitForPageWithLogtoLogin(page, authOptions(page));

    assert.deepEqual(page.appliedTokens, ['expired']);
    assert.equal(page.loginClicks, 1);
    assert.equal(page.url(), TARGET_URL);
    assert.deepEqual(await loadAuthState(), authState('fresh'));
  });
});

test('the second shared recovery reads a newly refreshed snapshot', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const page = new AuthFakePage();
    const goto = page.goto.bind(page);
    page.goto = async (url) => {
      await goto(url);
      if (page.appliedTokens.at(-1) === 'expired') await writeState('fresh');
    };

    await waitForPageWithLogtoLogin(page, authOptions(page, { restoreSharedAuthOnStart: true }));

    assert.deepEqual(page.appliedTokens, ['expired', 'fresh']);
    assert.equal(page.loginClicks, 0);
    assert.equal(page.url(), TARGET_URL);
  });
});

test('a visible administrator shell cannot overwrite a valid shared state with a rejected token', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('fresh');
    const page = new AuthFakePage();
    page.state = 'target';
    // The button is visible, but the server rejects the profile's token.
    assert.equal(page.authenticated, false);
    await waitForPageWithLogtoLogin(page, authOptions(page));
    assert.deepEqual(page.appliedTokens, ['fresh']);
    assert.equal(page.loginClicks, 0);
    assert.deepEqual(await loadAuthState(), authState('fresh'));
  });
});

test('a rejected shared token in a visible shell starts real authentication instead of reporting success', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const page = new AuthFakePage();
    page.state = 'target';
    const goto = page.goto.bind(page);
    page.goto = async (url) => {
      await goto(url);
      if (url === TARGET_URL) page.state = 'target';
    };
    await waitForPageWithLogtoLogin(page, authOptions(page));
    assert.equal(page.loginClicks, 1);
    assert.ok(page.gotoCalls.includes(ADMIN_LOGIN_URL));
    assert.deepEqual(await loadAuthState(), authState('fresh'));
  });
});

test('administrator verification checks HTTP and business status, not just a rendered button', async () => {
  for (const response of [
    { status: 200, body: { code: 401 } },
    { status: 401, body: {} },
    { status: 200, body: { code: 0, data: { id: 7 } } },
    { status: 503, body: { code: 500 } },
  ]) {
    const page = {
      async evaluate(callback) {
        return runInNewContext(`(${callback.toString()})()`, {
          location: { origin: 'https://console.osase.net' },
          localStorage: { getItem: () => 'test-admin-token' },
          AbortController, setTimeout, clearTimeout,
          async fetch(url, options) {
            assert.equal(url, 'https://api.osase.net/admin/user/info');
            assert.equal(options.headers['LOGIN-TOKEN'], 'test-admin-token');
            return { status: response.status, ok: response.status === 200, json: async () => response.body };
          },
        });
      },
    };
    if (response.status === 503) await assert.rejects(verifyAdminSession(page, { targetUrl: TARGET_URL }), /无法验证管理员登录态/);
    else assert.equal(await verifyAdminSession(page, { targetUrl: TARGET_URL }), response.body.code === 0);
  }
});

test('fresh authentication still waits for another browser to publish a new snapshot', async () => {
  await withSharedAuth(async (writeState) => {
    await writeState('expired');
    const otherBrowserLock = await acquireAuthLock();
    assert.ok(otherBrowserLock);
    const page = new AuthFakePage();
    let published = false;
    page.waitForTimeout = async () => {
      if (!published) {
        published = true;
        assert.deepEqual(page.appliedTokens, [], 'the rejected baseline must not be restored while waiting');
        await writeState('fresh');
      }
    };
    try {
      await waitForPageWithLogtoLogin(page, authOptions(page, { reuseSharedAuth: false }));
    } finally {
      await otherBrowserLock.release();
    }

    assert.equal(published, true);
    assert.deepEqual(page.appliedTokens, ['fresh']);
    assert.equal(page.loginClicks, 0);
    assert.equal(page.url(), TARGET_URL);
  });
});
