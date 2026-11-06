import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { enterCompanyBackend } from '../scripts/company-backend.mjs';

const ADMIN_URL = 'https://console.osase.net/admin/manage/user/user-company-list';
const LOGIN_URL = 'https://console.osase.net/admin/login/account';
const BACKEND_URL = 'https://console.osase.net/manage/saas/index/application';
const COMPANY = '示例科技';
const ADMIN_STATE = { cookies: [], origins: [] };

class Locator {
  constructor(page, resolve) {
    this.page = page;
    this.resolve = resolve;
  }

  async count() { return this.resolve().length; }
  nth(index) { return new Locator(this.page, () => this.resolve().slice(index, index + 1)); }
  async isVisible() { return Boolean(this.resolve()[0]?.visible ?? this.resolve()[0]); }
  async click() { return this.resolve()[0].click(); }
  async fill(value) { this.page.searchText = value; }
  async press(key) { assert.equal(key, 'Enter'); this.page.search(); }

  getByRole(role, { name, exact } = {}) {
    assert.equal(exact, true);
    return new Locator(this.page, () => this.resolve().flatMap((node) => (node.children ?? [])
      .filter((child) => child.role === role && child.name === name)));
  }

  getByText(text, { exact }) {
    assert.equal(exact, true);
    return new Locator(this.page, () => this.resolve().flatMap((node) => (node.children ?? [])
      .filter((child) => child.name === text)));
  }

  filter({ has }) {
    return new Locator(this.page, () => this.resolve().filter((row) => row.company === has.text));
  }
}

class Page extends EventEmitter {
  constructor(context, { popup = false, rows = [COMPANY], foundRows, searchButton = true, destination = BACKEND_URL } = {}) {
    super();
    this.contextValue = context;
    this.options = { popup, foundRows, searchButton, destination };
    this.rows = rows.map((company) => this.row(company));
    this.currentUrl = 'about:blank';
    this.frame = {};
    this.events = context.events;
    this.dialogOpen = false;
    this.input = { role: 'input' };
    this.confirm = { role: 'button', name: '确定', click: () => this.confirmEntry() };
  }

  row(company) {
    return { company, children: [{ role: 'button', name: '进入用户后台', click: () => {
      this.events.push(['enter', company]);
      this.dialogOpen = true;
    } }] };
  }

  search() {
    this.events.push(['search', this.searchText]);
    if (this.options.foundRows) this.rows = this.options.foundRows.map((name) => this.row(name));
  }

  confirmEntry() {
    this.events.push(['confirm']);
    this.dialogOpen = false;
    if (this.options.confirmFailure) throw new Error('确认失败');
    if (this.options.popup) {
      const popup = new Page(this.contextValue);
      popup.currentUrl = this.options.destination;
      this.contextValue.emit('page', popup);
      this.popup = popup;
    } else {
      this.currentUrl = this.options.destination;
      this.emit('framenavigated', this.frame);
    }
  }

  locator(selector) {
    if (selector.startsWith('tr,')) return new Locator(this, () => this.rows);
    if (selector.startsWith('input:')) return new Locator(this, () => [this.input]);
    return new Locator(this, () => []);
  }

  getByText(text, { exact }) {
    assert.equal(exact, true);
    const locator = new Locator(this, () => this.rows.filter((row) => row.company === text));
    locator.text = text;
    return locator;
  }

  getByPlaceholder(placeholder) {
    return new Locator(this, () => placeholder === '请输入公司名称' ? [this.input] : []);
  }

  getByRole(role, { name } = {}) {
    return new Locator(this, () => {
      if (role === 'dialog') return this.dialogOpen ? [{ children: [this.confirm] }] : [];
      if (role === 'button' && name === '确定') return this.dialogOpen ? [this.confirm] : [];
      if (role === 'button' && name === '添加用户') return [{ role, name }];
      if (role === 'button' && name === '搜索' && this.options.searchButton) return [{ role, name, click: () => this.search() }];
      return [];
    });
  }

  async goto(url) { this.currentUrl = url; this.events.push(['goto', url]); }
  url() { return this.currentUrl; }
  mainFrame() { return this.frame; }
  async bringToFront() { this.events.push(['active', this]); }
  async waitForLoadState() {}
  async waitForTimeout() {}
}

function fixture(pageOptions = {}) {
  const context = new EventEmitter();
  context.events = [];
  const page = new Page(context, pageOptions);
  const options = {
    timeoutMs: 5,
    pollIntervalMs: 1,
    userDataDir: '/tmp/company-backend-test',
    async waitForLogin(_page, loginOptions) {
      assert.equal(loginOptions.targetUrl, ADMIN_URL);
      assert.equal(loginOptions.userDataDir, '/tmp/company-backend-test');
      context.events.push(['login']);
    },
    async waitForPageReady(readyPage) { context.events.push(['ready', readyPage.url()]); },
    async captureAuthState() { context.events.push(['snapshot']); return ADMIN_STATE; },
    async restoreAdminAuthState(_context, state) {
      assert.equal(state, ADMIN_STATE);
      context.events.push(['restore']);
      return true;
    },
  };
  return { context, page, options };
}

for (const popup of [false, true]) {
  test(`enters the exact company before returning the ${popup ? 'popup' : 'same'} page and administrator snapshot`, async () => {
    const { context, page, options } = fixture({ popup, rows: [`${COMPANY}分公司`, COMPANY] });
    const result = await enterCompanyBackend(context, page, COMPANY, options);
    assert.equal(result.userPage, popup ? page.popup : page);
    assert.equal(result.userPage.url(), BACKEND_URL);
    assert.equal(result.adminLoginState, ADMIN_STATE);
    assert.deepEqual(context.events.filter(([event]) => !['ready', 'active'].includes(event)), [
      ['goto', ADMIN_URL], ['login'], ['snapshot'], ['enter', COMPANY], ['confirm'],
    ]);
    assert.equal(context.listenerCount('page'), 0);
    assert.equal(page.listenerCount('framenavigated'), 0);
  });
}

test('searches for a missing company and uses Enter when no search button is available', async () => {
  const { context, page, options } = fixture({ rows: [`${COMPANY}分公司`], foundRows: [COMPANY], searchButton: false });
  await enterCompanyBackend(context, page, COMPANY, options);
  assert.deepEqual(context.events.filter(([event]) => ['search', 'enter'].includes(event)), [
    ['search', COMPANY], ['enter', COMPANY],
  ]);
});

for (const expiredDuring of ['loading', 'search']) {
  test(`renews authentication once when list ${expiredDuring} redirects to login, then searches the same exact company`, async () => {
    const { context, page, options } = fixture({ rows: [`${COMPANY}分公司`], foundRows: [COMPANY] });
    const renewedState = { cookies: [{ name: 'session', value: 'renewed-admin' }], origins: [] };
    let loginCalls = 0;
    let expired = false;
    let searchCalls = 0;
    let snapshotCalls = 0;
    let pollWaits = 0;
    const waitForLogin = options.waitForLogin;
    options.waitForLogin = async (activePage, loginOptions) => {
      loginCalls += 1;
      if (loginCalls === 2) {
        assert.equal(loginOptions.reuseSharedAuth, false);
        assert.equal(loginOptions.restoreSharedAuthOnStart, false);
      }
      await waitForLogin(activePage, loginOptions);
    };
    const waitForPageReady = options.waitForPageReady;
    options.waitForPageReady = async (activePage) => {
      await waitForPageReady(activePage);
      if (expiredDuring === 'loading' && !expired) {
        expired = true;
        page.currentUrl = LOGIN_URL;
      }
    };
    options.captureAuthState = async () => {
      snapshotCalls += 1;
      return loginCalls === 1 ? ADMIN_STATE : renewedState;
    };
    const search = page.search.bind(page);
    page.search = () => {
      searchCalls += 1;
      if (expiredDuring === 'search' && !expired) {
        expired = true;
        context.events.push(['search', page.searchText]);
        page.currentUrl = LOGIN_URL;
        return;
      }
      search();
    };
    page.waitForTimeout = async () => { pollWaits += 1; };

    const result = await enterCompanyBackend(context, page, COMPANY, options);

    assert.equal(loginCalls, 2);
    assert.equal(result.adminLoginState, renewedState);
    assert.equal(result.userPage.url(), BACKEND_URL);
    assert.equal(searchCalls, expiredDuring === 'search' ? 2 : 1);
    assert.equal(snapshotCalls, expiredDuring === 'search' ? 2 : 1);
    assert.equal(pollWaits, 0, 'a known login redirect must not wait for the company-search timeout');
    assert.deepEqual(context.events.filter(([event]) => event === 'search').map(([, name]) => name),
      Array(searchCalls).fill(COMPANY));
    assert.equal(context.events.filter(([event]) => event === 'enter').length, 1);
    assert.equal(context.events.filter(([event]) => event === 'confirm').length, 1);
    assert.equal(context.events.filter(([event]) => event === 'goto').length, 2);
    assert.equal(context.events.some(([event]) => event === 'restore'), false);
  });
}

test('stops after a second search login redirect without entering the company or restoring rejected auth', async () => {
  const { context, page, options } = fixture({ rows: [] });
  let loginCalls = 0;
  const waitForLogin = options.waitForLogin;
  options.waitForLogin = async (...args) => { loginCalls += 1; await waitForLogin(...args); };
  page.search = () => {
    context.events.push(['search', page.searchText]);
    page.currentUrl = LOGIN_URL;
  };

  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /重新认证后管理员列表仍跳回登录页/);

  assert.equal(loginCalls, 2);
  assert.equal(context.events.filter(([event]) => event === 'search').length, 2);
  assert.equal(context.events.some(([event]) => ['enter', 'confirm', 'restore'].includes(event)), false);
});

test('a failed renewed auth snapshot stops before retrying company search or entry', async () => {
  const { context, page, options } = fixture({ rows: [] });
  let snapshots = 0;
  options.captureAuthState = async () => (++snapshots === 1 ? ADMIN_STATE : null);
  page.search = () => {
    context.events.push(['search', page.searchText]);
    page.currentUrl = LOGIN_URL;
  };

  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /无法保存管理员登录态/);

  assert.equal(snapshots, 2);
  assert.equal(context.events.filter(([event]) => event === 'login').length, 2);
  assert.equal(context.events.filter(([event]) => event === 'search').length, 1);
  assert.equal(context.events.some(([event]) => ['enter', 'confirm', 'restore'].includes(event)), false);
});

test('never enters a company whose name only contains the requested name', async () => {
  const { context, page, options } = fixture({ rows: [`${COMPANY}分公司`] });
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /名称完全匹配/);
  assert.equal(context.events.some(([event]) => event === 'enter'), false);
  assert.equal(context.events.filter(([event]) => event === 'login').length, 1);
  assert.equal(context.events.at(-1)[0], 'restore');
});

test('refuses ambiguous companies with identical names', async () => {
  const { context, page, options } = fixture({ rows: [COMPANY, COMPANY] });
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /多个完全同名/);
  assert.equal(context.events.some(([event]) => event === 'enter'), false);
  assert.equal(context.events.at(-1)[0], 'restore');
});

test('refuses to switch companies when the administrator state cannot be captured', async () => {
  const { context, page, options } = fixture();
  options.captureAuthState = async () => null;
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /无法保存管理员登录态/);
  assert.equal(context.events.some(([event]) => event === 'enter'), false);
});

test('restores administrator state when confirmation fails', async () => {
  const { context, page, options } = fixture();
  page.options.confirmFailure = true;
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /确认失败/);
  assert.equal(context.events.at(-1)[0], 'restore');
  assert.equal(context.listenerCount('page'), 0);
});

test('does not report success when confirmation leaves the administrator page active', async () => {
  const { context, page, options } = fixture({ destination: ADMIN_URL });
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /没有跳转到公司用户后台/);
  assert.equal(context.events.at(-1)[0], 'restore');
});

test('a login redirect after confirming company entry does not replay the entry operation', async () => {
  const { context, page, options } = fixture({ destination: LOGIN_URL });

  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), /跳转到登录页/);

  assert.equal(context.events.filter(([event]) => event === 'login').length, 1);
  assert.equal(context.events.filter(([event]) => event === 'enter').length, 1);
  assert.equal(context.events.filter(([event]) => event === 'confirm').length, 1);
});

test('reports both entry and restoration failures', async () => {
  const { context, page, options } = fixture({ rows: [COMPANY, COMPANY] });
  options.restoreAdminAuthState = async () => { throw new Error('浏览器已关闭'); };
  await assert.rejects(enterCompanyBackend(context, page, COMPANY, options), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /多个完全同名/);
    assert.match(error.message, /恢复管理员登录态失败：浏览器已关闭/);
    return true;
  });
});

test('requires a company name before opening the administrator page', async () => {
  const { context, page, options } = fixture();
  await assert.rejects(enterCompanyBackend(context, page, ' ', options), /必须提供“公司名称”/);
  assert.deepEqual(context.events, []);
});
