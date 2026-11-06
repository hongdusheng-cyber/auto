import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addRulesForCompany, openTrafficRules, parseRulesTarget } from '../scripts/add-rules.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(rootDir, 'scripts', 'add-rules.mjs');

test('adding rules reads the company and builds the complete rules URL', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    script,
    '--service-id',
    '8565',
    '--company',
    '测试客户有限公司',
    '--rules',
    '["office365","TikTok跨境电商"]',
    '--dry-run-parse',
  ], { cwd: rootDir });

  assert.match(stdout, /规则页：https:\/\/console\.osase\.net\/manage\/saas\/8565\/detail\/rules/);
  assert.match(stdout, /规则应用：office365、TikTok跨境电商/);
  assert.match(stdout, /公司名称：测试客户有限公司/);
  assert.match(stdout, /saas_rule_type=2&page=1&page_size=100&rule_page_2=1&rule_page_size_2=100/);
});

test('a company name cannot replace the required service ID', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      script,
      '--company',
      '测试客户有限公司',
      '--rules',
      'office365',
      '--dry-run-parse',
    ], { cwd: rootDir }),
    /请提供网络加速服务 ID/,
  );
});

test('adding rules requires a company before starting browser work', async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    script, '--service-id', '8685', '--rules', 'office365', '--dry-run-parse',
  ], { cwd: rootDir }), /请提供公司名称/);
});

test('ID and complete URL targets use the requested rule type and pagination', () => {
  const expected = 'https://console.osase.net/manage/saas/8685/detail/rules?saas_rule_type=2&page=1&page_size=100&rule_page_2=1&rule_page_size_2=100';
  for (const input of ['8685', expected, 'https://console.osase.net/manage/saas/8685/detail/rules?page_size=20']) {
    assert.deepEqual(parseRulesTarget(input), { serviceId: '8685', url: expected });
  }
  assert.throws(() => parseRulesTarget('https://unrelated.example/manage/saas/8685/detail/rules'), /规则页 URL/);
});

const TARGET = { serviceId: '8565', url: 'https://console.osase.net/manage/saas/8565/detail/rules' };
const LOGIN_URL = 'https://console.osase.net/admin/login/account';

function createRulesPage({ loginAt = null, promptAt = null, readyOnVisit = 1 } = {}) {
  const events = [];
  let currentUrl = TARGET.url;
  let visits = 0;
  let ready = false;
  let redirected = false;
  let loginPromptVisible = false;
  const redirect = (stage) => {
    if (!redirected && loginAt === stage) {
      currentUrl = LOGIN_URL;
      ready = false;
      redirected = true;
    }
    if (promptAt === stage) loginPromptVisible = true;
  };
  const locator = {
    first() { return this; },
    nth() { return this; },
    async count() { return ready ? 1 : 0; },
    async isVisible() { return ready; },
    async waitFor() {
      events.push('wait-tab');
      redirect('tab');
      if (!ready) throw new Error('not ready');
    },
    async click() { events.push('select-tab'); },
  };
  return {
    events,
    url() { return currentUrl; },
    getByText() { return locator; },
    getByRole(role, { name } = {}) {
      if (role !== 'button' || name !== '使用 Logto 登录') return locator;
      return {
        count: async () => (loginPromptVisible ? 1 : 0),
        nth() { return this; },
        isVisible: async () => loginPromptVisible,
      };
    },
    async goto() {
      events.push('goto');
      visits += 1;
      currentUrl = TARGET.url;
      ready = visits >= readyOnVisit;
      redirect('goto');
    },
    async waitForURL(predicate) {
      events.push('wait-url');
      redirect('url');
      assert.ok(predicate(new URL(currentUrl)));
    },
    async waitForTimeout(milliseconds) { events.push(`delay-${milliseconds}`); },
    authenticate() {
      events.push('authenticate');
      currentUrl = TARGET.url;
      ready = true;
    },
  };
}

for (const loginAt of ['goto', 'url', 'tab']) {
  test(`authenticates immediately when ${loginAt} reveals an expired session`, async () => {
    const page = createRulesPage({ loginAt });
    await openTrafficRules(page, TARGET, {
      closeWhenDone: true,
      async waitForLogin(activePage, options) {
        assert.equal(activePage, page);
        assert.equal(options.targetUrl, TARGET.url);
        assert.equal(options.readyDescription, '流量调度规则页');
        page.authenticate();
      },
    });

    assert.equal(page.events.filter((event) => event === 'goto').length, 1);
    assert.equal(page.events.filter((event) => event === 'authenticate').length, 1);
    assert.ok(!page.events.includes('delay-3000'), 'authentication must precede contract-sync retries');
    assert.ok(page.events.includes('select-tab'), 'login success must still select the preapproval tab');
    if (loginAt === 'goto') assert.deepEqual(page.events.slice(0, 2), ['goto', 'authenticate']);
  });
}

test('keeps retrying when the authenticated contract rules have not synced yet', async () => {
  const page = createRulesPage({ readyOnVisit: 3 });
  let loginAttempts = 0;
  await openTrafficRules(page, TARGET, {
    closeWhenDone: true,
    async waitForLogin() { loginAttempts += 1; },
  });

  assert.equal(loginAttempts, 0);
  assert.equal(page.events.filter((event) => event === 'goto').length, 3);
  assert.equal(page.events.filter((event) => event === 'delay-3000').length, 2);
  assert.ok(page.events.includes('select-tab'));
});

test('expired rule sessions reenter the company and continue on its new page', async () => {
  const oldPage = createRulesPage({ loginAt: 'goto' });
  const companyPage = createRulesPage();
  let reentries = 0;
  const activePage = await openTrafficRules(oldPage, TARGET, {
    closeWhenDone: true,
    async reenterCompany(page) {
      assert.equal(page, oldPage);
      reentries += 1;
      return companyPage;
    },
    async waitForLogin() { assert.fail('admin login alone does not establish the company session'); },
  });
  assert.equal(activePage, companyPage);
  assert.equal(reentries, 1);
  assert.ok(!oldPage.events.includes('select-tab'));
  assert.ok(companyPage.events.includes('select-tab'));
});

test('SPA login shell reenters the company without applying administrator auth state', async () => {
  const stalePage = createRulesPage({ promptAt: 'goto' });
  const companyPage = createRulesPage();
  let reentries = 0;
  const activePage = await openTrafficRules(stalePage, TARGET, {
    closeWhenDone: true,
    async reenterCompany(page) {
      assert.equal(page, stalePage);
      reentries += 1;
      return companyPage;
    },
    async waitForLogin() {
      assert.fail('company SPA login shell must be rebuilt through administrator entry');
    },
  });
  assert.equal(activePage, companyPage);
  assert.equal(reentries, 1);
  assert.ok(companyPage.events.includes('select-tab'));
});

test('rules run on the company page after entry and restore admin state afterwards', async () => {
  const steps = [];
  const context = {};
  const adminPage = {};
  const companyPage = {};
  const adminState = { cookies: [], origins: [] };
  await addRulesForCompany(context, adminPage, { companyName: '示例公司', rulesTarget: TARGET, rules: ['office365', 'TikTok'] }, {
    betweenRulesMs: 0,
    async enterBackend(actualContext, page, company) {
      assert.equal(actualContext, context);
      assert.equal(page, adminPage);
      assert.equal(company, '示例公司');
      steps.push('enter-company');
      return { userPage: companyPage, adminLoginState: adminState };
    },
    async openRules(page, target) {
      assert.equal(page, companyPage);
      assert.equal(target, TARGET);
      steps.push('open-rules');
      return page;
    },
    async select(page, rule) { assert.equal(page, companyPage); steps.push(rule); },
    async restoreAdminState(actualContext, state) {
      assert.equal(actualContext, context);
      assert.equal(state, adminState);
      steps.push('restore-admin');
      return true;
    },
  });
  assert.deepEqual(steps, ['enter-company', 'open-rules', 'office365', 'TikTok', 'restore-admin']);
});

test('company reentry restores the renewed administrator snapshot after selecting rules', async () => {
  const context = {};
  const adminPage = {};
  const firstCompanyPage = {};
  const renewedCompanyPage = {};
  const firstAdminState = { cookies: [{ name: 'session', value: 'first-admin' }], origins: [] };
  const renewedAdminState = { cookies: [{ name: 'session', value: 'renewed-admin' }], origins: [] };
  let entries = 0;
  let selected = false;
  let restoredState = null;

  await addRulesForCompany(context, adminPage, {
    companyName: '示例公司', rulesTarget: TARGET, rules: ['office365'],
  }, {
    betweenRulesMs: 0,
    async enterBackend(actualContext, page, company) {
      assert.equal(actualContext, context);
      assert.equal(company, '示例公司');
      entries += 1;
      assert.equal(page, entries === 1 ? adminPage : firstCompanyPage);
      return entries === 1
        ? { userPage: firstCompanyPage, adminLoginState: firstAdminState }
        : { userPage: renewedCompanyPage, adminLoginState: renewedAdminState };
    },
    async openRules(page, target, { reenterCompany }) {
      assert.equal(page, firstCompanyPage);
      assert.equal(target, TARGET);
      return reenterCompany(page);
    },
    async select(page, rule) {
      assert.equal(page, renewedCompanyPage);
      assert.equal(rule, 'office365');
      selected = true;
    },
    async restoreAdminState(actualContext, state) {
      assert.equal(actualContext, context);
      assert.equal(selected, true);
      restoredState = state;
      return true;
    },
  });

  assert.equal(entries, 2);
  assert.equal(restoredState, renewedAdminState);
});

test('failed company reentry preserves the renewed session restored by entry cleanup', async () => {
  const firstAdminState = { cookies: [{ name: 'session', value: 'first-admin' }], origins: [] };
  const renewedAdminState = { cookies: [{ name: 'session', value: 'renewed-admin' }], origins: [] };
  const context = { state: firstAdminState };
  const companyPage = {};
  const entryError = new Error('重新登录后没有找到公司');
  let entries = 0;
  let outerRestores = 0;

  await assert.rejects(addRulesForCompany(context, {}, {
    companyName: '示例公司', rulesTarget: TARGET, rules: ['office365'],
  }, {
    betweenRulesMs: 0,
    async enterBackend(actualContext) {
      assert.equal(actualContext, context);
      entries += 1;
      if (entries === 1) return { userPage: companyPage, adminLoginState: firstAdminState };
      // enterCompanyBackend restores its newly captured administrator state
      // when company search or confirmation fails after reauthentication.
      context.state = renewedAdminState;
      throw entryError;
    },
    async openRules(page, target, { reenterCompany }) {
      assert.equal(page, companyPage);
      assert.equal(target, TARGET);
      return reenterCompany(page);
    },
    async select() { assert.fail('failed reentry must not mutate rules'); },
    async restoreAdminState(actualContext, state) {
      outerRestores += 1;
      actualContext.state = state;
      return true;
    },
  }), (error) => error === entryError);

  assert.equal(entries, 2);
  assert.equal(outerRestores, 0);
  assert.equal(context.state, renewedAdminState);
});

test('company entry failure prevents rule navigation and mutations', async () => {
  await assert.rejects(addRulesForCompany({}, {}, { companyName: '不存在的公司', rulesTarget: TARGET, rules: ['office365'] }, {
    async enterBackend() { throw new Error('没有找到公司'); },
    async openRules() { assert.fail('must not navigate'); },
    async select() { assert.fail('must not mutate rules'); },
  }), /没有找到公司/);
});

test('rule navigation failure still restores the administrator session', async () => {
  let restored = false;
  await assert.rejects(addRulesForCompany({}, {}, { companyName: '示例公司', rulesTarget: TARGET, rules: ['office365'] }, {
    async enterBackend() { return { userPage: {}, adminLoginState: { cookies: [], origins: [] } }; },
    async openRules() { throw new Error('规则页不可用'); },
    async select() { assert.fail('must not mutate rules'); },
    async restoreAdminState() { restored = true; return true; },
  }), /规则页不可用/);
  assert.equal(restored, true);
});
