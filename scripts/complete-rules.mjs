import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCustomerProfile } from './customer-profile.mjs';
import { isLogtoLoginUrl, waitForPageWithLogtoLogin } from './logto-login.mjs';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';
import { findHiddenRuleMatches, normalizeHiddenRuleName } from './hidden-rule-matching.mjs';

export const HIDDEN_RULES_URL = 'https://console.osase.net/admin/manage/utility/hidden-rules-group';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

function getArgValues(argv, name) {
  const matches = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const parts = [];
    for (let offset = index + 1; offset < argv.length && !argv[offset].startsWith('--'); offset += 1) {
      parts.push(argv[offset]);
    }
    matches.push(parts.join(' '));
  }
  return matches;
}

function normalizeOptions({ companyName, rules }) {
  const company = String(companyName ?? '').trim();
  if (!company) throw new Error('请提供公司名称（--company），或通过 --file 读取客户资料。');
  if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string')) {
    throw new Error('规则应用必须是名称字符串数组。');
  }
  const names = [...new Set(rules.map((rule) => rule.trim()).filter(Boolean))];
  if (!names.length) throw new Error('请至少选择一个规则应用。');
  return { companyName: company, rules: names };
}

export async function readCompleteRulesOptions(argv = process.argv.slice(2)) {
  let companyName = getArgValues(argv, '--company')[0] ?? '';
  const file = getArgValues(argv, '--file')[0];
  if (!companyName.trim() && file) {
    companyName = parseCustomerProfile(await readFile(path.resolve(file), 'utf8')).companyName;
  }
  const rules = getArgValues(argv, '--rule');
  for (const value of getArgValues(argv, '--rules')) {
    if (value.trim().startsWith('[')) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error('--rules 必须使用有效的 JSON 数组。'); }
      if (!Array.isArray(parsed) || parsed.some((rule) => typeof rule !== 'string')) {
        throw new Error('--rules JSON 必须是名称字符串数组。');
      }
      rules.push(...parsed);
    } else {
      rules.push(...value.split(/[,，\n]/));
    }
  }
  return normalizeOptions({ companyName, rules });
}

async function launchChrome() {
  await mkdir(USER_DATA_DIR, { recursive: true });
  const options = { headless: false, viewport: null, slowMo: getPlaywrightSlowMo() };
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, { ...options, channel: 'chrome' });
  } catch (error) {
    console.warn('没有通过 channel 找到 Chrome，改用 Playwright Chromium。');
    console.warn(error.message);
    return chromium.launchPersistentContext(USER_DATA_DIR, options);
  }
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}

function selectField(drawer, label) {
  return drawer.locator(`xpath=.//p[normalize-space(.)=${xpathLiteral(label)}]/following-sibling::div[1]`).first();
}

async function openOptions(page, field, timeoutMs) {
  const input = field.locator('input[role="combobox"]').first();
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  // Element Plus places its placeholder and selected tags over the narrow
  // search input. Open the select via its wrapper; fill() can still edit the
  // input directly without a pointer click through those overlays.
  if (await input.getAttribute('aria-expanded') !== 'true') {
    await field.locator('.el-select__wrapper').first().click({ timeout: timeoutMs });
  }
  const listId = await input.getAttribute('aria-controls');
  if (!listId) throw new Error('搜索框没有关联的候选列表，已停止选择。');
  const listbox = page.locator(`xpath=//*[@id=${xpathLiteral(listId)}]`);
  await listbox.waitFor({ state: 'visible', timeout: timeoutMs });
  return { input, listbox, options: listbox.locator('[role="option"]') };
}

async function waitForValue(page, predicate, { timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (isLogtoLoginUrl(page.url())) throw new Error('页面已跳转到登录页。');
    if (await predicate(Math.max(1, deadline - Date.now()))) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(pollIntervalMs, remainingMs));
  } while (Date.now() < deadline);
  return false;
}

async function selectCompany(page, field, companyName, timing) {
  const input = field.locator('input[role="combobox"]').first();
  await input.waitFor({ state: 'visible', timeout: timing.timeoutMs });
  // The mounted selector already requests the full company list. Typing opens
  // the remote results; opening an empty dropdown first would issue a second
  // full-list request. Neither full-list request is needed to search by name.
  await input.fill(companyName, { timeout: timing.timeoutMs });
  console.log(`已输入公司名称：${companyName}，正在等待并选择同名搜索结果。`);
  // Search results can arrive asynchronously or reorder. Keep the click bound
  // to the visible company name, never to an index from an earlier snapshot.
  const clicked = await waitForValue(page, async (remainingMs) => {
    // A remote search can replace the listbox together with aria-controls.
    const listId = await input.getAttribute('aria-controls');
    if (!listId) return false;
    const listbox = page.locator(`xpath=//*[@id=${xpathLiteral(listId)}]`);
    const companyOption = listbox.getByRole('option', { name: companyName, exact: true }).filter({ visible: true });
    const count = await companyOption.count();
    if (count > 1) throw new Error(`搜索结果存在多个完全同名的公司“${companyName}”，无法确定应选择哪一家。`);
    if (count !== 1) return false;
    try {
      await companyOption.click({ timeout: Math.min(1000, remainingMs) });
      return true;
    } catch (error) {
      // A result may be replaced during rendering. Re-read aria-controls on
      // the next attempt rather than waiting on a superseded listbox.
      if (error.name !== 'TimeoutError') throw error;
      return false;
    }
  }, timing);
  if (!clicked) throw new Error(`没有找到或无法点击名称完全匹配的公司：${companyName}`);

  const selected = await waitForValue(page, async () => {
    const text = await field.locator('.el-select__placeholder:visible').allTextContents();
    return text.some((value) => value.trim() === companyName)
      && await input.getAttribute('aria-expanded') === 'false'
      && await input.inputValue() === '';
  }, timing);
  if (!selected) throw new Error(`公司“${companyName}”未成功选中，已停止填写规则。`);
  console.log(`已选择公司：${companyName}`);
}

async function selectHiddenRules(page, field, rules, timing) {
  const { input, options } = await openOptions(page, field, timing.timeoutMs);
  // The administrator selector loads its full rule catalog when opened. Read
  // every option before choosing any rule so missing/ambiguous names fail early.
  await input.fill('');
  await options.first().waitFor({ state: 'visible', timeout: timing.timeoutMs });
  if (timing.settleMs) await page.waitForTimeout(timing.settleMs);
  const labels = await options.allTextContents();
  const resolved = rules.map((rule) => {
    const matches = findHiddenRuleMatches(rule, labels);
    if (!matches.length) throw new Error(`没有找到对应的隐藏规则包：${rule}。请核对网页中配置的规则名称。`);
    if (matches.length > 1) throw new Error(`隐藏规则“${rule}”存在多个精确匹配：${matches.map((match) => match.label).join('、')}，请使用完整规则包名称。`);
    return { requestedName: rule, ...matches[0] };
  });
  const uniqueRules = [...new Map(resolved.map((rule) => [rule.label, rule])).values()];

  for (const rule of uniqueRules) {
    const hasSelectedTag = async () => (await field.locator('.el-select__tags-text').allTextContents())
      .some((text) => normalizeHiddenRuleName(text) === normalizeHiddenRuleName(rule.label));
    if (await hasSelectedTag()) continue;
    if (await input.getAttribute('aria-expanded') !== 'true') await openOptions(page, field, timing.timeoutMs);
    const clicked = await waitForValue(page, async (remainingMs) => {
      const listId = await input.getAttribute('aria-controls');
      if (!listId) return false;
      const listbox = page.locator(`xpath=//*[@id=${xpathLiteral(listId)}]`);
      const option = listbox.getByRole('option', { name: rule.label.trim(), exact: true }).filter({ visible: true });
      const count = await option.count();
      if (count > 1) throw new Error(`隐藏规则“${rule.label}”存在多个同名候选，已停止选择。`);
      if (count !== 1) return false;
      if (await option.getAttribute('aria-selected') === 'true') return true;
      try {
        await option.click({ timeout: Math.min(1000, remainingMs) });
        return true;
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        return false;
      }
    }, timing);
    const selected = clicked && await waitForValue(page, hasSelectedTag, timing);
    if (!selected) throw new Error(`规则包“${rule.label}”未成功选中，已停止；请检查侧栏。`);
    console.log(`已选择隐藏规则包：${rule.requestedName} → ${rule.label}`);
  }

  // Dismiss only the dropdown; clicking the drawer title cannot submit the form.
  return uniqueRules.map(({ requestedName, label, backend, display }) => ({ requestedName, label, backend, display }));
}

/** Fill the administrator drawer and return without submitting or closing it. */
export async function prepareHiddenRules(page, parameters, {
  waitForLogin = waitForPageWithLogtoLogin,
  timeoutMs = 15000,
  pollIntervalMs = 200,
  settleMs = 600,
} = {}) {
  const options = normalizeOptions(parameters);
  const timing = { timeoutMs, pollIntervalMs, settleMs };
  await page.goto(HIDDEN_RULES_URL, { waitUntil: 'domcontentloaded' });
  const addButton = page.getByRole('button', { name: '添加企业隐藏规则包', exact: true });
  const loginOptions = {
    targetUrl: HIDDEN_RULES_URL,
    readyLocator: addButton,
    readyDescription: '隐藏规则包设置',
    userDataDir: USER_DATA_DIR,
    restoreSharedAuthOnStart: false,
  };
  await waitForLogin(page, loginOptions);
  let loginRecovered = false;
  while (true) {
    try {
      await addButton.click();
      const drawer = page.locator('.ant-drawer-content-wrapper:visible').filter({
        has: page.locator('.ant-drawer-title', { hasText: /^新建企业隐藏规则包$/ }),
      });
      await drawer.waitFor({ state: 'visible', timeout: timeoutMs });
      await selectCompany(page, selectField(drawer, '企业'), options.companyName, timing);
      const rules = await selectHiddenRules(page, selectField(drawer, '隐藏规则包'), options.rules, timing);
      await drawer.locator('.ant-drawer-title').click();
      const submit = drawer.getByRole('button', { name: /^添\s*加$/ });
      await submit.waitFor({ state: 'visible', timeout: timeoutMs });
      if (!(await submit.isEnabled())) throw new Error('公司和规则已选择，但“添加”按钮仍不可用，请检查侧栏。');
      console.log(`完善规程已准备：公司 ${options.companyName}，共 ${rules.length} 个规则包。`);
      return { companyName: options.companyName, rules, pendingManualSubmit: true };
    } catch (error) {
      if (!isLogtoLoginUrl(page.url())) throw error;
      if (loginRecovered) {
        throw new Error('重新认证后仍跳回登录页，已停止完善规程；请检查账号登录状态。', { cause: error });
      }
      loginRecovered = true;
      console.log('完善规程填写过程中登录已失效，正在重新认证；完成后会重新打开侧栏并继续填写。');
      // The current state has just been rejected. Do not re-import the same
      // shared snapshot and mistake the briefly visible SPA for a valid login.
      await waitForLogin(page, { ...loginOptions, reuseSharedAuth: false });
    }
  }
}

function watchHiddenRuleAddition(page, timeoutMs) {
  let settle;
  let timer;
  let finished = false;
  const result = new Promise((resolve) => { settle = resolve; });
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    page.off('response', onResponse);
    settle(outcome);
  };
  const onResponse = async (response) => {
    if (response.request().method() !== 'POST'
      || new URL(response.url()).pathname !== '/admin/tools/hide-saas-rule-package-add') return;
    try {
      if (!response.ok()) throw new Error(`自动添加请求失败（HTTP ${response.status()}）。`);
      const body = await response.json();
      if (body.code !== 0) throw new Error(`自动添加失败：${body.message || `错误码 ${body.code ?? '未知'}`}。`);
      finish({ success: true });
    } catch (error) {
      finish({ error });
    }
  };
  page.on('response', onResponse);
  timer = setTimeout(() => finish({ error: new Error('等待添加结果超时，尚未确认是否成功。') }), timeoutMs);
  return { result, dispose: () => finish({ cancelled: true }) };
}

/** Select the company/rules, submit once, and confirm the server and drawer result. */
export async function completeHiddenRules(page, parameters, {
  submitTimeoutMs = 15000,
  ...prepareOptions
} = {}) {
  const prepared = await prepareHiddenRules(page, parameters, prepareOptions);
  const drawer = page.locator('.ant-drawer-content-wrapper:visible').filter({
    has: page.locator('.ant-drawer-title', { hasText: /^新建企业隐藏规则包$/ }),
  });
  const submission = watchHiddenRuleAddition(page, submitTimeoutMs);
  try {
    console.log('正在自动点击“添加”并确认结果。');
    // Keep submission outside the preparation/login retry loop. An uncertain
    // response must never cause another click that could create duplicates.
    await drawer.getByRole('button', { name: /^添\s*加$/ }).click({ timeout: submitTimeoutMs });
    const outcome = await submission.result;
    if (outcome.error) throw outcome.error;
    await drawer.waitFor({ state: 'hidden', timeout: submitTimeoutMs });
  } catch (error) {
    throw new Error(`${error.message} 已停止自动操作，请检查页面或列表中的结果；不会重复点击“添加”。`, { cause: error });
  } finally {
    submission.dispose();
  }
  console.log(`完善规程添加成功：公司 ${prepared.companyName}，共 ${prepared.rules.length} 个规则包，已确认侧栏关闭。`);
  return { ...prepared, pendingManualSubmit: false, submitted: true };
}

async function main() {
  const options = await readCompleteRulesOptions();
  console.log('本次完善规程参数：');
  console.log(`公司名称：${options.companyName}`);
  console.log(`规则应用：${options.rules.join('、')}`);
  console.log(`规则页：${HIDDEN_RULES_URL}`);
  if (process.argv.includes('--dry-run-parse')) return;
  const context = await launchChrome();
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await completeHiddenRules(page, options);
  } catch (error) {
    console.error(isLogtoLoginUrl(page.url())
      ? '完善规程已停止，请检查浏览器中的登录页及上方操作日志。'
      : '完善规程未完成，请检查浏览器页面及上方操作日志。');
    throw error;
  }
  console.log('已自动添加并确认成功。浏览器将保持打开供检查，关闭窗口即可结束任务。');
  await new Promise((resolve) => context.once('close', resolve));
  console.log('浏览器已关闭，完善规程任务结束。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
