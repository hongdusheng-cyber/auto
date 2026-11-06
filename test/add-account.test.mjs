import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import {
  ACCOUNT_LIST_URL, addAccountForCompany, createAccountCredentials, normalizeAccountOptions,
  prepareAccountForm, readAccountOptions, splitAccountName, submitAccountForm,
} from '../scripts/add-account.mjs';

const INPUT = { companyName: '示例科技有限公司', fullName: '欧阳明', email: 'person@example.com' };
const CREDENTIALS = { password: 'SafeTest29Z', phone: '13812345678' };
const ADMIN_STATE = { cookies: [], origins: [] };

test('normalizes account input and splits Chinese, compound and explicitly spaced names', () => {
  assert.deepEqual(normalizeAccountOptions({ companyName: ' 示例科技有限公司 ', fullName: ' 欧阳明 ', email: ' person@example.com ' }), {
    ...INPUT, lastName: '欧阳', firstName: '明',
  });
  assert.deepEqual(splitAccountName('张三丰'), { fullName: '张三丰', lastName: '张', firstName: '三丰' });
  assert.deepEqual(splitAccountName('Smith   John Paul'), { fullName: 'Smith John Paul', lastName: 'Smith', firstName: 'John Paul' });
  assert.deepEqual(splitAccountName('王  小明'), { fullName: '王 小明', lastName: '王', firstName: '小明' });
});

test('rejects missing fields, invalid email and names that cannot be safely split', () => {
  for (const field of ['companyName', 'fullName', 'email']) assert.throws(() => normalizeAccountOptions({ ...INPUT, [field]: ' ' }), /请填写/u);
  for (const email of ['not-email', 'a@@example.com', 'a@.example.com', 'a@example..com', 'a b@example.com']) {
    assert.throws(() => normalizeAccountOptions({ ...INPUT, email }), /有效的邮箱/u);
  }
  for (const name of ['王', '欧阳', 'Alice']) assert.throws(() => splitAccountName(name), /空格分开/u);
  assert.throws(() => normalizeAccountOptions({ ...INPUT, companyName: '甲\n乙' }), /格式/u);
});

test('creates independent 10-character passwords and valid mainland mobile numbers', () => {
  const passwords = new Set();
  const phones = new Set();
  for (let index = 0; index < 100; index += 1) {
    const { password, phone } = createAccountCredentials();
    assert.match(password, /^[A-Za-z0-9]{10}$/u);
    assert.match(password, /[A-Z]/u);
    assert.match(password, /[a-z]/u);
    assert.match(password, /[0-9]/u);
    assert.match(phone, /^1[3-9][0-9]{9}$/u);
    passwords.add(password);
    phones.add(phone);
  }
  assert.ok(passwords.size > 90);
  assert.ok(phones.size > 90);
});

test('CLI parses only explicit account arguments and dry-run never emits credentials', () => {
  const argv = ['--company', INPUT.companyName, '--name', INPUT.fullName, '--email', INPUT.email];
  assert.deepEqual(readAccountOptions([...argv, '--submit']), normalizeAccountOptions(INPUT));
  assert.throws(() => readAccountOptions([...argv, '--name', '张三']), /只能填写一次/u);
  assert.throws(() => readAccountOptions(['--company', '--name']), /请提供 --company/u);
  const result = spawnSync(process.execPath, ['scripts/add-account.mjs', ...argv, '--dry-run-parse'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), normalizeAccountOptions(INPUT));
  assert.doesNotMatch(result.stdout, /password|phone|ACCOUNT_RESULT/u);
});

function workflowFixture() {
  const events = [];
  const context = {};
  const page = {};
  const userPage = {};
  const drawer = {};
  const dependencies = {
    credentials: CREDENTIALS,
    submit: true,
    async enterBackend(actualContext, actualPage, companyName) {
      assert.equal(actualContext, context);
      assert.equal(actualPage, page);
      assert.equal(companyName, INPUT.companyName);
      events.push('enter');
      return { userPage, adminLoginState: ADMIN_STATE };
    },
    async prepare(actualPage, options, credentials) {
      assert.equal(actualPage, userPage);
      assert.equal(options.email, INPUT.email);
      assert.equal(credentials, CREDENTIALS);
      events.push('prepare');
      return drawer;
    },
    async submitForm(actualPage, actualDrawer, credentials, { parameters }) {
      assert.equal(actualPage, userPage);
      assert.equal(actualDrawer, drawer);
      assert.equal(credentials, CREDENTIALS);
      assert.equal(parameters.lastName, '欧阳');
      events.push('submit');
      return { submitted: true };
    },
    async restoreAdminState(actualContext, state) {
      assert.equal(actualContext, context);
      assert.equal(state, ADMIN_STATE);
      events.push('restore');
      return true;
    },
  };
  return { events, context, page, dependencies };
}

test('returns credentials only after submission succeeds and restores administrator auth', async () => {
  const { events, context, page, dependencies } = workflowFixture();
  const result = await addAccountForCompany(context, page, INPUT, dependencies);
  assert.deepEqual(events, ['enter', 'prepare', 'submit', 'restore']);
  assert.deepEqual(result, { status: 'success', companyName: INPUT.companyName, fullName: INPUT.fullName, account: INPUT.email, ...CREDENTIALS, message: '账号添加成功' });
});

test('preparation mode does not click submit or return the generated password', async () => {
  const { events, context, page, dependencies } = workflowFixture();
  const result = await addAccountForCompany(context, page, INPUT, { ...dependencies, submit: false });
  assert.deepEqual(events, ['enter', 'prepare', 'restore']);
  assert.equal(result.status, 'prepared');
  assert.equal('password' in result, false);
});

for (const failure of ['prepare', 'submitForm']) {
  test(`restores administrator auth after ${failure} fails, without retrying`, async () => {
    const { events, context, page, dependencies } = workflowFixture();
    dependencies[failure] = async () => { events.push('failure'); throw new Error('页面已跳转到登录页'); };
    await assert.rejects(addAccountForCompany(context, page, INPUT, dependencies), /登录页/u);
    assert.equal(events.filter((event) => event === 'enter').length, 1);
    assert.equal(events.at(-1), 'restore');
  });
}

test('preserves confirmed credentials when restoring admin auth fails after account creation', async () => {
  const { context, page, dependencies } = workflowFixture();
  dependencies.restoreAdminState = async () => { throw new Error('恢复失败'); };
  await assert.rejects(addAccountForCompany(context, page, INPUT, dependencies), (error) => {
    assert.equal(error.confirmedResult.status, 'success');
    assert.equal(error.confirmedResult.password, CREDENTIALS.password);
    assert.match(error.confirmedResult.message, /账号已创建；恢复管理员登录态失败/u);
    return true;
  });
});

test('does not restore a stale administrator snapshot when company entry fails', async () => {
  const { events, context, page, dependencies } = workflowFixture();
  dependencies.enterBackend = async () => { throw new Error('公司名称重复'); };
  await assert.rejects(addAccountForCompany(context, page, INPUT, dependencies), /公司名称重复/u);
  assert.deepEqual(events, []);
});

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
});
after(async () => { await browser?.close(); });

async function localForm(t, { mode = 'success', status = 200, code = 0, message = '', smsChecked = false, smsHidden = false, smsDisabled = false, login = false } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const requests = [];
  const fields = [['姓', 'lastName'], ['名', 'firstName'], ['工作Email', 'email'], ['个人Email', 'memberEmail'], ['密码', 'password']];
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <button id="open">添加用户</button>
    <div class="ant-message-notice"><div class="ant-message-success">编辑成功</div></div>
    <div class="ant-drawer-content" style="display:none">
      <div class="ant-drawer-title"><h3> 添加用戶 </h3></div>
      ${fields.map(([label, field]) => `<div><p>${label}*</p><div class="custom-input"><input data-field="${field}" type="${field === 'password' ? 'password' : 'text'}"></div></div>`).join('')}
      <div><div><p>手机号码*</p><div class="custom-select"><input role="combobox" value="中国 (+86)"></div></div><div><p></p><div class="custom-input"><input data-field="phone"></div></div></div>
      <label class="el-checkbox"><span class="el-checkbox__input"><span class="el-checkbox__inner"></span><input type="checkbox" class="el-checkbox__original" ${smsChecked ? 'checked' : ''} ${smsDisabled ? 'disabled' : ''} ${smsHidden ? 'style="opacity:0;position:absolute;width:0;height:0;margin:0"' : ''}></span><span class="el-checkbox__label">是否发送短信</span></label>
      <div><p>头衔</p><input data-field="memberTitle" value="默认头衔"></div>
      <button id="submit">新 建</button>
    </div>
    <script>
      const mode = ${JSON.stringify(mode)};
      window.submits = 0;
      window.smsClicks = 0;
      document.querySelector('.el-checkbox').addEventListener('click', () => window.smsClicks++);
      document.getElementById('open').onclick = () => document.querySelector('.ant-drawer-content').style.display = 'block';
      document.getElementById('submit').onclick = async () => {
        window.submits++;
        if (mode === 'login') { location.href = '/admin/login/account'; return; }
        if (mode === 'validation') { document.body.insertAdjacentHTML('beforeend', '<div class="ant-message-notice"><div class="ant-message-error">请填写正确的手机号</div></div>'); return; }
        if (mode === 'close-only') { document.querySelector('.ant-drawer-content').style.display = 'none'; return; }
        const payload = Object.fromEntries([...document.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value]));
        Object.assign(payload, { userId: '0', type: mode === 'wrong-request' ? 1 : 2, phoneCc: '+86', registerSms: document.querySelector('input[type=checkbox]').checked ? 1 : 0 });
        const response = await fetch('/api/organize/user/detail-edit-or-add', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
        const result = await response.json();
        if (result.code === 0 && mode !== 'keep-open') document.querySelector('.ant-drawer-content').style.display = 'none';
        document.body.insertAdjacentHTML('beforeend', '<div class="ant-message-notice"><div class="ant-message-success">编辑成功</div></div>');
      };
    </script></body></html>`;
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/organize/user/detail-edit-or-add')) {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code, message }) });
    } else if (login && new URL(route.request().url()).pathname === '/manage/user/user-list') {
      await route.fulfill({ status: 302, headers: { location: '/admin/login/account' } });
    } else await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  return { page, requests };
}

test('fills the observed unlabeled drawer fields, preserves country/work defaults and disables SMS', async (t) => {
  const { page, requests } = await localForm(t, { smsChecked: true });
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  assert.equal(page.url(), ACCOUNT_LIST_URL);
  const values = await drawer.locator('[data-field]').evaluateAll((inputs) => Object.fromEntries(inputs.map((input) => [input.dataset.field, input.value])));
  assert.deepEqual(values, { lastName: '欧阳', firstName: '明', email: INPUT.email, memberEmail: INPUT.email, password: CREDENTIALS.password, phone: CREDENTIALS.phone, memberTitle: '默认头衔' });
  assert.equal(await drawer.getByRole('combobox').inputValue(), '中国 (+86)');
  assert.equal(await drawer.getByRole('checkbox').isChecked(), false);
  assert.equal(requests.length, 0);
});

test('confirms matching successful server response plus a closed drawer, despite the edit-success toast', async (t) => {
  const { page, requests } = await localForm(t);
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  await submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 1000 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, 2);
  assert.equal(requests[0].registerSms, 0);
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('requestfailed'), 0);
});

for (const smsChecked of [false, true]) {
  test(`submits with SMS disabled when the Element UI input is hidden and initially ${smsChecked ? 'checked' : 'unchecked'}`, async (t) => {
    const { page, requests } = await localForm(t, { smsHidden: true, smsChecked });
    const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS, { timeoutMs: 1000 });
    const checkbox = drawer.getByRole('checkbox', { name: /是否发送短信/u, includeHidden: true });
    assert.equal(await checkbox.isVisible(), false);
    assert.equal(await checkbox.isChecked(), false);
    const smsClicks = await page.evaluate(() => window.smsClicks);
    assert.equal(smsChecked ? smsClicks > 0 : smsClicks === 0, true);
    await submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 1000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].registerSms, 0);
    assert.equal(await page.evaluate(() => window.submits), 1);
  });
}

test('stops before submission when the hidden SMS checkbox cannot be unchecked', async (t) => {
  const { page, requests } = await localForm(t, { smsHidden: true, smsChecked: true, smsDisabled: true });
  await assert.rejects(prepareAccountForm(page, INPUT, CREDENTIALS, { timeoutMs: 1000 }), /无法取消“是否发送短信”/u);
  assert.equal(requests.length, 0);
  assert.equal(await page.evaluate(() => window.submits), 0);
});

test('warns with the duplicated phone and does not retry a rejected create request', async (t) => {
  const { page, requests } = await localForm(t, { code: 409, message: '手机号已存在' });
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  await assert.rejects(submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 1000 }), /【手机号重复】13812345678/u);
  assert.equal(requests.length, 1);
  assert.equal(await page.evaluate(() => window.submits), 1);
});

test('keeps the duplicate-phone message from an HTTP 409 response', async (t) => {
  const { page, requests } = await localForm(t, { status: 409, code: 409, message: '手机号已经存在' });
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  await assert.rejects(submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 1000 }), (error) => {
    assert.match(error.message, /【手机号重复】13812345678/u);
    assert.match(error.message, /HTTP 409/u);
    return true;
  });
  assert.equal(requests.length, 1);
});

for (const mode of ['close-only', 'keep-open', 'wrong-request', 'validation']) {
  test(`does not report success for ${mode}`, async (t) => {
    const { page } = await localForm(t, { mode });
    const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
    await assert.rejects(submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 300, pollIntervalMs: 20 }));
    assert.equal(await page.evaluate(() => window.submits), 1);
    assert.equal(page.listenerCount('response'), 0);
  });
}

test('stops at a login redirect before opening or submitting an account form', async (t) => {
  const { page, requests } = await localForm(t, { login: true });
  await assert.rejects(prepareAccountForm(page, INPUT, CREDENTIALS), /登录页/u);
  assert.equal(requests.length, 0);
});

test('stops without replaying submission when the company page redirects to login', async (t) => {
  const { page, requests } = await localForm(t, { mode: 'login' });
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  await assert.rejects(submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT, timeoutMs: 1000 }), /登录页/u);
  assert.equal(requests.length, 0);
});

test('refuses submission if SMS is re-enabled after preparation', async (t) => {
  const { page, requests } = await localForm(t);
  const drawer = await prepareAccountForm(page, INPUT, CREDENTIALS);
  await drawer.getByRole('checkbox').setChecked(true);
  await assert.rejects(submitAccountForm(page, drawer, CREDENTIALS, { parameters: INPUT }), /是否发送短信/u);
  assert.equal(requests.length, 0);
  assert.equal(await page.evaluate(() => window.submits), 0);
});
