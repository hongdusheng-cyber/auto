import path from 'node:path';
import { restoreAuthState, snapshotAuthState } from './auth-state.mjs';
import { isLogtoLoginUrl, waitForPageWithLogtoLogin } from './logto-login.mjs';
import { runAndWaitForActivePage, waitForPageFullyLoaded } from './playwright-utils.mjs';

const ADMIN_LIST_URL = 'https://console.osase.net/admin/manage/user/user-company-list';
const COMPANY_ROWS = 'tr, .table-row, .el-table__row, .ant-table-row, [role="row"]';

async function visibleLocators(locator) {
  const matches = [];
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible()) matches.push(current);
  }
  return matches;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const [visible] = await visibleLocators(locator);
    if (visible) return visible;
  }
  return null;
}

async function exactCompanyRow(page, companyName) {
  const rows = await visibleLocators(page.locator(COMPANY_ROWS).filter({
    has: page.getByText(companyName, { exact: true }),
  }));
  if (rows.length > 1) throw new Error(`列表里有多个完全同名的公司“${companyName}”，无法确定应进入哪个后台。`);
  return rows[0] ?? null;
}

async function waitForResult(page, find, { timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  do {
    requireNonLoginPage(page);
    const result = await find();
    requireNonLoginPage(page);
    if (result) return result;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    await page.waitForTimeout(Math.min(pollIntervalMs, remainingMs));
  } while (Date.now() < deadline);
  return null;
}

function requireNonLoginPage(page) {
  if (isLogtoLoginUrl(page.url())) throw new Error('管理员列表已跳转到登录页。');
}

async function findOrSearchCompany(page, companyName, timing) {
  const existingRow = await exactCompanyRow(page, companyName);
  if (existingRow) return existingRow;

  const input = await firstVisible([
    ...['请输入公司名称', '公司名称', '请输入关键字', '请输入关键词', '搜索']
      .map((placeholder) => page.getByPlaceholder(placeholder, { exact: true })),
    page.locator('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'),
  ]);
  if (!input) throw new Error(`没有在列表里找到公司：${companyName}，也没有找到公司搜索框。`);

  await input.fill(companyName);
  const searchButton = await firstVisible(['搜索', '查询'].map((name) => page.getByRole('button', { name, exact: true })));
  if (searchButton) await searchButton.click();
  else await input.press('Enter');

  const row = await waitForResult(page, () => exactCompanyRow(page, companyName), timing);
  if (!row) throw new Error(`没有在列表里找到名称完全匹配的公司：${companyName}`);
  return row;
}

function isCompanyBackendUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://console.osase.net' && /^\/manage(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

/** Enter the selected company's backend, retaining the administrator state for the caller's finally block. */
export async function enterCompanyBackend(context, page, companyName, {
  userDataDir = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile'),
  waitForLogin = waitForPageWithLogtoLogin,
  waitForPageReady = waitForPageFullyLoaded,
  captureAuthState = snapshotAuthState,
  restoreAdminAuthState = restoreAuthState,
  activatePage = runAndWaitForActivePage,
  timeoutMs = 10000,
  pollIntervalMs = 200,
} = {}) {
  const name = String(companyName ?? '').trim();
  if (!name) throw new Error('进入公司用户后台前必须提供“公司名称”。');
  const timing = { timeoutMs, pollIntervalMs };

  const loginOptions = {
    targetUrl: ADMIN_LIST_URL,
    readyLocator: page.getByRole('button', { name: '添加用户', exact: true }),
    readyDescription: '用户管理列表',
    userDataDir,
  };
  let adminLoginState = null;
  let loginRecovered = false;
  const recoverAdminLogin = async (error) => {
    if (!isLogtoLoginUrl(page.url())) throw error;
    // A rejected snapshot must not overwrite credentials issued by recovery.
    adminLoginState = null;
    if (loginRecovered) {
      throw new Error('重新认证后管理员列表仍跳回登录页，已停止进入公司用户后台。', { cause: error });
    }
    loginRecovered = true;
    console.log('管理员列表查询期间登录已失效，正在重新认证并重新查找公司。');
    await page.goto(ADMIN_LIST_URL, { waitUntil: 'domcontentloaded' });
    await waitForLogin(page, { ...loginOptions, reuseSharedAuth: false, restoreSharedAuthOnStart: false });
  };

  try {
    await page.goto(ADMIN_LIST_URL, { waitUntil: 'domcontentloaded' });
    await waitForLogin(page, loginOptions);
    let row;
    while (true) {
      try {
        await waitForPageReady(page);
        requireNonLoginPage(page);
      } catch (error) {
        await recoverAdminLogin(error);
        continue;
      }

      // Snapshot failures are fatal; only a login redirect can retry loading or
      // searching the list, before any company-entry operation is clicked.
      adminLoginState = await captureAuthState(context);
      if (!adminLoginState) throw new Error('无法保存管理员登录态，已停止进入公司用户后台。');
      try {
        row = await findOrSearchCompany(page, name, timing);
        requireNonLoginPage(page);
        break;
      } catch (error) {
        await recoverAdminLogin(error);
      }
    }

    const enterButton = await firstVisible([
      row.getByRole('button', { name: '进入用户后台', exact: true }),
      row.getByText('进入用户后台', { exact: true }),
    ]);
    if (!enterButton) throw new Error(`找到了公司“${name}”，但这一行里没有“进入用户后台”。`);
    await enterButton.click();

    const confirmButton = await waitForResult(page, async () => {
      const scoped = await firstVisible([
        page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }),
        page.getByRole('alertdialog').getByRole('button', { name: '确定', exact: true }),
        page.locator('.el-message-box, .ant-modal').getByRole('button', { name: '确定', exact: true }),
      ]);
      if (scoped) return scoped;
      const buttons = await visibleLocators(page.getByRole('button', { name: '确定', exact: true }));
      if (buttons.length > 1) throw new Error('页面上有多个“确定”按钮，无法确定进入用户后台的确认操作。');
      return buttons[0] ?? null;
    }, timing);
    if (!confirmButton) throw new Error('点击“进入用户后台”后，没有找到弹窗里的“确定”按钮。');

    const userPage = await activatePage(context, page, () => confirmButton.click(), { timeoutMs });
    const entered = await waitForResult(userPage, () => isCompanyBackendUrl(userPage.url()), timing);
    if (!entered) throw new Error(`确认进入公司“${name}”后，页面没有跳转到公司用户后台。`);
    await waitForPageReady(userPage);
    return { userPage, adminLoginState };
  } catch (error) {
    if (!adminLoginState) throw error;
    try {
      if (!(await restoreAdminAuthState(context, adminLoginState))) throw new Error('当前浏览器不支持恢复登录态。');
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `${error.message}；恢复管理员登录态失败：${restoreError.message}`);
    }
    throw error;
  }
}
