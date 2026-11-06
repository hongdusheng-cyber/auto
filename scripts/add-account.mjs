import { chromium } from 'playwright';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { enterCompanyBackend } from './company-backend.mjs';
import { restoreAuthState } from './auth-state.mjs';
import { isLogtoLoginUrl } from './logto-login.mjs';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';

export const ACCOUNT_LIST_URL = 'https://console.osase.net/manage/user/user-list?page=1&page_size=20';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');
const COMPOUND_SURNAMES = new Set(('欧阳 太史 端木 上官 司马 东方 独孤 南宫 万俟 闻人 夏侯 诸葛 尉迟 公羊 赫连 澹台 皇甫 宗政 濮阳 公冶 太叔 申屠 公孙 慕容 仲孙 钟离 长孙 宇文 司徒 鲜于 司空 闾丘 子车 亓官 司寇 巫马 公西 颛孙 壤驷 公良 漆雕 乐正 宰父 谷梁 拓跋 夹谷 轩辕 令狐 段干 百里 呼延 东郭 南门 羊舌 微生 梁丘 左丘 东门 西门 第五').split(' '));
const PHONE_PREFIXES = ['130', '131', '132', '133', '135', '136', '137', '138', '139', '150', '151', '152', '155', '156', '157', '158', '159', '180', '181', '182', '183', '185', '186', '187', '188', '189', '198', '199'];

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}。`);
  const result = value.trim();
  if (result.length > maxLength || /[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${label}格式不正确。`);
  return result;
}

export function splitAccountName(value) {
  const fullName = requiredString(value, '姓名', 100).replace(/\s+/gu, ' ');
  const parts = fullName.split(' ');
  if (parts.length > 1) return { fullName, lastName: parts[0], firstName: parts.slice(1).join(' ') };
  if (!/^\p{Script=Han}+$/u.test(fullName)) throw new Error('请将姓名按“姓 名”用空格分开填写，例如“Smith John”。');
  const letters = Array.from(fullName);
  const surnameLength = COMPOUND_SURNAMES.has(letters.slice(0, 2).join('')) ? 2 : 1;
  if (letters.length <= surnameLength) throw new Error('姓名无法拆分为姓和名，请填写完整姓名，或按“姓 名”用空格分开填写。');
  return { fullName, lastName: letters.slice(0, surnameLength).join(''), firstName: letters.slice(surnameLength).join('') };
}

export function normalizeAccountOptions({ companyName, fullName, email } = {}) {
  const company = requiredString(companyName, '公司名称', 200);
  const parsedName = splitAccountName(fullName);
  const accountEmail = requiredString(email, '邮箱', 254);
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(accountEmail)) throw new Error('请输入有效的邮箱地址，例如 name@example.com。');
  return { companyName: company, ...parsedName, email: accountEmail };
}

export function createAccountCredentials() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'];
  const alphabet = groups.join('');
  const characters = groups.map((group) => group[randomInt(group.length)]);
  while (characters.length < 10) characters.push(alphabet[randomInt(alphabet.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  const phone = PHONE_PREFIXES[randomInt(PHONE_PREFIXES.length)]
    + Array.from({ length: 8 }, () => String(randomInt(10))).join('');
  return { password: characters.join(''), phone };
}

export function readAccountOptions(argv = process.argv.slice(2)) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (['--submit', '--dry-run-parse'].includes(flag)) continue;
    const property = { '--company': 'companyName', '--name': 'fullName', '--email': 'email' }[flag];
    if (!property) throw new Error(`不支持的参数：${flag}`);
    if (values[property] !== undefined) throw new Error(`参数 ${flag} 只能填写一次。`);
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`请提供 ${flag} 的值。`);
    values[property] = argv[++index];
  }
  return normalizeAccountOptions(values);
}

function requireAccountPage(page) {
  const value = page.url();
  if (isLogtoLoginUrl(value) || /\/login(?:\/|$)/i.test(new URL(value).pathname)) {
    throw new Error('公司用户后台已跳转到登录页，已停止添加账号，请重新进入该公司后台。');
  }
  const url = new URL(value);
  if (url.origin !== 'https://console.osase.net' || url.pathname !== '/manage/user/user-list') {
    throw new Error('当前页面不是公司用户管理页，已停止添加账号。');
  }
}

async function uniqueVisible(locator, description) {
  const matches = [];
  for (let index = 0, count = await locator.count(); index < count; index += 1) {
    const match = locator.nth(index);
    if (await match.isVisible()) matches.push(match);
  }
  if (matches.length > 1) throw new Error(`找到多个${description}，无法确定应使用哪一个。`);
  return matches[0] ?? null;
}

function drawerLocator(page) {
  return page.locator('.ant-drawer-content').filter({ has: page.getByText(/^\s*添加用[户戶]\s*$/u) });
}

function smsCheckboxLocator(drawer) {
  return drawer.getByRole('checkbox', { name: /是否发送短信/u, includeHidden: true });
}

async function disableAccountSms(drawer, timeoutMs) {
  const checkbox = smsCheckboxLocator(drawer);
  // Element UI keeps its native checkbox hidden; its checked state is still
  // readable, while user interaction belongs on the surrounding visible label.
  await checkbox.waitFor({ state: 'attached', timeout: timeoutMs });
  if (!(await checkbox.isChecked())) return;
  if (!(await checkbox.isEnabled())) throw new Error('无法取消“是否发送短信”，已停止添加账号。');
  if (await checkbox.isVisible()) {
    await checkbox.setChecked(false, { timeout: timeoutMs });
  } else {
    const label = await uniqueVisible(checkbox.locator('xpath=ancestor::label[1]'), '“是否发送短信”控件');
    if (!label) throw new Error('没有找到可操作的“是否发送短信”控件，已停止添加账号。');
    await label.click({ timeout: timeoutMs });
  }
  if (await checkbox.isChecked()) throw new Error('无法取消“是否发送短信”，已停止添加账号。');
}

async function fillAccountField(drawer, label, value, timeoutMs) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = [
    drawer.getByLabel(new RegExp(`^\\s*${escaped}\\s*\\*?\\s*$`, 'u')),
    label === '手机号码'
      ? drawer.locator(`xpath=.//p[normalize-space(translate(., '*', ''))='手机号码']/parent::div/following-sibling::div[1]//input[not(@role='combobox')]`)
      : drawer.locator(`xpath=.//p[normalize-space(translate(., '*', ''))='${label}']/parent::div//input`),
  ];
  for (const candidate of candidates) {
    const input = await uniqueVisible(candidate, `“${label}”输入框`);
    if (!input) continue;
    await input.fill(value, { timeout: timeoutMs });
    return;
  }
  throw new Error(`添加用户表单中没有找到“${label}”输入框。`);
}

export async function prepareAccountForm(page, parameters, credentials, { timeoutMs = 15000 } = {}) {
  const options = normalizeAccountOptions(parameters);
  await page.goto(ACCOUNT_LIST_URL, { waitUntil: 'domcontentloaded' });
  requireAccountPage(page);
  const addButton = page.getByRole('button', { name: /^添加用[户戶]$/u });
  await addButton.waitFor({ state: 'visible', timeout: timeoutMs });
  requireAccountPage(page);
  await addButton.click({ timeout: timeoutMs });
  const drawer = drawerLocator(page);
  await drawer.waitFor({ state: 'visible', timeout: timeoutMs });
  for (const [label, value] of [
    ['姓', options.lastName], ['名', options.firstName], ['工作Email', options.email],
    ['个人Email', options.email], ['密码', credentials.password], ['手机号码', credentials.phone],
  ]) {
    requireAccountPage(page);
    await fillAccountField(drawer, label, value, timeoutMs);
  }
  await disableAccountSms(drawer, timeoutMs);
  requireAccountPage(page);
  return drawer;
}

function accountError(message, phone) {
  const text = String(message || '账号添加失败。');
  const mentionsPhone = /(手机|号码|phone|mobile)/iu.test(text);
  const mentionsDuplicate = /(重复|已(?:经)?(?:存在|被|使用|注册|绑定|占用)|唯一|duplicate|already|exist|used|taken|in use)/iu.test(text);
  return new Error(mentionsPhone && mentionsDuplicate ? `【手机号重复】${phone}：${text}；已停止，请检查后重新操作。` : text);
}

// Capture field validation and error messages even when they disappear before
// the next poll. Confirmation comes from the matching server response.
async function observeAccountFeedback(page, key) {
  await page.evaluate((stateKey) => {
    const selector = '.ant-message-notice, .el-message, .ant-notification-notice, [role="alert"], .ant-form-item-explain-error, .el-form-item__error';
    const initial = new WeakMap([...document.querySelectorAll(selector)].map((node) => [node, node.textContent]));
    const state = { error: '', observer: null };
    const inspect = () => {
      for (const node of document.querySelectorAll(selector)) {
        if (!node.getClientRects().length || initial.get(node) === node.textContent) continue;
        const text = node.textContent?.trim() ?? '';
        if (!text) continue;
        if (node.matches('.ant-form-item-explain-error, .el-form-item__error')
          || node.querySelector('.ant-message-error, .anticon-close-circle')
          || node.matches('.el-message--error')
          || /(失败|已存在|已被使用|已注册|重复|error|duplicate|already\s+(exists|used|registered))/iu.test(text)) state.error = text;
      }
    };
    state.observer = new MutationObserver(inspect);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    window[stateKey] = state;
  }, key);
}

function accountRequestParameters(request) {
  if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/organize/user/detail-edit-or-add')) return null;
  try { return request.postDataJSON(); } catch {
    const body = request.postData();
    if (!body) return {};
    try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); }
  }
}

function matchesAccountRequest(payload, parameters, credentials) {
  return payload && String(payload.type) === '2' && String(payload.userId) === '0'
    && ['lastName', 'firstName'].every((key) => payload[key] === parameters[key])
    && payload.email === parameters.email && payload.memberEmail === parameters.email
    && payload.password === credentials.password && payload.phone === credentials.phone
    && payload.phoneCc === '+86'
    && [undefined, null, 0, '0', false].includes(payload.registerSms);
}

export async function submitAccountForm(page, drawer, credentials, {
  parameters,
  timeoutMs = 15000,
  actionTimeoutMs = 15000,
  pollIntervalMs = 100,
} = {}) {
  const options = normalizeAccountOptions(parameters);
  requireAccountPage(page);
  const smsCheckbox = smsCheckboxLocator(drawer);
  if (await smsCheckbox.isChecked()) throw new Error('“是否发送短信”已勾选，已停止添加账号。');
  const key = `__accountFeedback_${randomUUID().replaceAll('-', '')}`;
  await observeAccountFeedback(page, key);
  let serverResult = null;
  const onResponse = async (response) => {
    const payload = accountRequestParameters(response.request());
    if (!payload) return;
    if (!matchesAccountRequest(payload, options, credentials)) {
      serverResult = { error: new Error('新建用户请求与本次账号参数不一致，无法确认结果，请检查用户列表。') };
      return;
    }
    try {
      const data = await response.json().catch(() => null);
      if (!response.ok()) {
        serverResult = { error: accountError(`${data?.message || '添加账号请求失败'}（HTTP ${response.status()}）。`, credentials.phone) };
        return;
      }
      serverResult = data?.code === 0
        ? { success: true }
        : { error: accountError(data?.message || '服务器未确认账号添加成功。', credentials.phone) };
    } catch (error) {
      serverResult = { error: new Error(`无法确认添加账号响应：${error.message}`) };
    }
  };
  const onRequestFailed = (request) => {
    if (accountRequestParameters(request)) serverResult = { error: new Error('添加账号请求中断，请检查用户列表确认结果；不会重复提交。') };
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  try {
    await drawer.getByRole('button', { name: /^新\s*建$/u }).click({ timeout: actionTimeoutMs });
    const deadline = Date.now() + timeoutMs;
    do {
      requireAccountPage(page);
      const feedback = await page.evaluate((stateKey) => {
        const state = window[stateKey];
        return state ? { error: state.error } : null;
      }, key);
      if (serverResult?.error) throw serverResult.error;
      if (feedback?.error) throw accountError(feedback.error, credentials.phone);
      if (serverResult?.success && !(await drawer.isVisible())) return { submitted: true };
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await page.waitForTimeout(Math.min(pollIntervalMs, remainingMs));
    } while (Date.now() < deadline);
    throw new Error('未能确认账号添加成功（需服务器确认及表单关闭）。请检查用户列表；已停止，不会重复点击“新建”。');
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    await page.evaluate((stateKey) => {
      window[stateKey]?.observer.disconnect();
      delete window[stateKey];
    }, key).catch(() => null);
  }
}

export async function addAccountForCompany(context, page, parameters, {
  credentials = createAccountCredentials(),
  submit = false,
  enterBackend = enterCompanyBackend,
  prepare = prepareAccountForm,
  submitForm = submitAccountForm,
  restoreAdminState = restoreAuthState,
  userDataDir = USER_DATA_DIR,
} = {}) {
  const options = normalizeAccountOptions(parameters);
  let adminLoginState = null;
  let workflowError = null;
  let confirmedResult = null;
  try {
    const entered = await enterBackend(context, page, options.companyName, { userDataDir });
    adminLoginState = entered.adminLoginState;
    const drawer = await prepare(entered.userPage, options, credentials);
    if (!submit) return { status: 'prepared', companyName: options.companyName, fullName: options.fullName, account: options.email, phone: credentials.phone };
    const outcome = await submitForm(entered.userPage, drawer, credentials, { parameters: options });
    if (outcome?.submitted !== true) throw new Error('未收到账号新建成功的确认结果，请检查用户列表；不会重复提交。');
    confirmedResult = { status: 'success', companyName: options.companyName, fullName: options.fullName, account: options.email, ...credentials, message: '账号添加成功' };
    return confirmedResult;
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    if (adminLoginState) {
      try {
        if (!(await restoreAdminState(context, adminLoginState))) throw new Error('当前浏览器不支持恢复登录态。');
      } catch (restoreError) {
        const message = `${workflowError?.message ?? (confirmedResult ? '账号已创建' : '账号表单已填写')}；恢复管理员登录态失败：${restoreError.message}`;
        const error = new Error(message, { cause: workflowError ?? restoreError });
        if (confirmedResult) error.confirmedResult = { ...confirmedResult, message };
        throw error;
      }
    }
  }
}

async function launchChrome() {
  await mkdir(USER_DATA_DIR, { recursive: true });
  const options = { headless: false, viewport: null, slowMo: getPlaywrightSlowMo() };
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, { ...options, channel: 'chrome' });
  } catch (error) {
    console.warn(`无法启动 Chrome，尝试 Playwright Chromium：${error.message}`);
    return chromium.launchPersistentContext(USER_DATA_DIR, options);
  }
}

async function waitUntilClosed(context) {
  if (!context.pages().some((page) => !page.isClosed())) return;
  await new Promise((resolve) => context.once('close', resolve));
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  let credentials;
  let context;
  let confirmedResult;
  try {
    options = readAccountOptions(argv);
    if (argv.includes('--dry-run-parse')) {
      console.log(JSON.stringify(options, null, 2));
      return;
    }
    credentials = createAccountCredentials();
    console.log(`正在为公司“${options.companyName}”添加账号：${options.fullName}（${options.email}）。`);
    context = await launchChrome();
    const result = await addAccountForCompany(context, context.pages()[0] ?? await context.newPage(), options, {
      credentials,
      submit: argv.includes('--submit'),
    });
    if (result.status === 'success') {
      confirmedResult = result;
      console.log(`ACCOUNT_RESULT ${JSON.stringify(result)}`);
      await context.close();
    } else {
      console.log('表单已填写，未点击“新建”。请检查页面，关闭窗口即可结束任务。');
      await waitUntilClosed(context);
    }
  } catch (error) {
    const message = String(error.message ?? error).replaceAll(credentials?.password || '\u0000', '[已隐藏]');
    const completed = error.confirmedResult ?? confirmedResult;
    if (completed) console.log(`ACCOUNT_RESULT ${JSON.stringify({ ...completed, message: error.confirmedResult ? message : `账号已创建；${message}` })}`);
    else console.log(`ACCOUNT_RESULT ${JSON.stringify({ status: 'error', companyName: options?.companyName ?? '', fullName: options?.fullName ?? '', account: options?.email ?? '', ...(credentials ? { phone: credentials.phone } : {}), message })}`);
    console.error(message);
    process.exitCode = 1;
    if (context) {
      console.error('添加账号任务已停止。浏览器保持打开供检查，关闭窗口即可结束任务。');
      await waitUntilClosed(context);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
