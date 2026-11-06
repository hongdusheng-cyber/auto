import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { waitForPageWithLogtoLogin } from './logto-login.mjs';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';

const WAREHOUSE_URL = 'https://console.osase.net/admin/manage/utility/device-warehouse';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');
const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldCloseWhenDone = process.argv.includes('--close-when-done');
const shouldWaitForManualSubmit = process.argv.includes('--manual-submit');

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const values = [];
  for (let current = index + 1; current < process.argv.length; current += 1) {
    const value = process.argv[current];
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values.join(' ');
}

function readInputOptions() {
  const mac = String(getArgValue('--device-mac') ?? getArgValue('--mac') ?? '').trim();
  const deviceName = String(getArgValue('--device-name') ?? '').trim();
  const companyName = String(getArgValue('--company') ?? getArgValue('--company-name') ?? '').trim();
  if (!mac) throw new Error('请提供设备 MAC，例如：npm run device:warehouse-outbound -- --device-mac 11:22:77:07:93:41');
  if (!deviceName) throw new Error('请提供设备名称。');
  if (!companyName) throw new Error('请提供公司名称，用于填写设备备注。');
  return { mac, deviceName, companyName };
}

async function launchChrome() {
  await mkdir(USER_DATA_DIR, { recursive: true });
  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome', headless: false, viewport: null, slowMo: getPlaywrightSlowMo(),
    });
  } catch (error) {
    console.warn('没有通过 channel 找到 Chrome，改用 Playwright Chromium。');
    console.warn(error.message);
    return chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false, viewport: null, slowMo: getPlaywrightSlowMo(),
    });
  }
}

async function waitForWarehousePage(page) {
  await waitForPageWithLogtoLogin(page, {
    targetUrl: WAREHOUSE_URL,
    readyLocator: page.getByText('设备列表').first(),
    readyDescription: '设备仓库列表',
    userDataDir: USER_DATA_DIR,
  });
}

async function findSearchInput(page) {
  const input = page.getByPlaceholder('请输入关键字以搜索').first();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  return input;
}

async function findDeviceRow(page, mac) {
  const escaped = mac.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = page.locator('tr').filter({ hasText: new RegExp(escaped, 'i') }).first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  return row;
}

function fieldInput(drawer, label) {
  return drawer.locator(`xpath=.//p[normalize-space(.)="${label}"]/following-sibling::div[1]//input`).first();
}

async function selectValue(page, drawer, label, value) {
  const field = drawer.locator(`xpath=.//p[normalize-space(.)="${label}"]/following-sibling::div[1]`).first();
  const current = (await field.textContent().catch(() => '')).trim();
  if (current.includes(value)) return;
  await field.locator('.el-select__wrapper').click({ force: true });
  const option = page.locator('.el-select-dropdown:visible .el-select-dropdown__item').filter({ hasText: value }).first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.click({ force: true });
}

async function validateSubmitButton(button, activate = false) {
  await button.evaluate((element, shouldActivate) => {
    if (element.matches(':disabled')
      || element.closest('[aria-disabled="true"], [aria-busy="true"]')
      || element.classList.contains('ant-btn-loading')) {
      throw new Error('“修改记录”按钮已禁用或正在提交，未重复提交。');
    }
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!element.isConnected || style.display === 'none' || style.visibility !== 'visible'
      || !element.getClientRects().length || rect.width <= 0 || rect.height <= 0) {
      throw new Error('“修改记录”按钮已隐藏，无法提交。');
    }
    if (shouldActivate) element.click();
  }, activate);
}

export async function submitWarehouseRecord(drawer, { timeoutMs = 10000 } = {}) {
  const button = drawer.getByRole('button', { name: '修改记录', exact: true });
  await button.waitFor({ state: 'visible', timeout: timeoutMs });
  await validateSubmitButton(button);

  let outsideViewport = false;
  try {
    // Trial waits for drawer animations and scrolls, but never dispatches a click.
    await button.click({ trial: true, timeout: timeoutMs });
  } catch (error) {
    const message = String(error.message ?? '');
    const firstLine = message.split('\n')[0];
    outsideViewport = /^locator\.click: Element is outside of the viewport$/i.test(firstLine)
      || (error.name === 'TimeoutError' && /element is outside of the viewport/i.test(message));
    if (!outsideViewport) throw error;
  }

  // A fixed drawer footer can remain beyond the window even after scrolling.
  // Only the trial may fall back to DOM activation; errors after a real click
  // must propagate so a slow/failed response can never cause a second submit.
  await validateSubmitButton(button, outsideViewport);
  if (!outsideViewport) await button.click({ timeout: timeoutMs });
}

async function updateDevice(page, row, options) {
  const cells = row.locator('td');
  const rowMac = (await cells.nth(2).textContent().catch(() => '')).trim();
  const mac = options.mac || rowMac;
  if (!mac) throw new Error('设备记录没有可用 MAC。');

  await row.getByRole('button', { name: /编\s*辑/ }).click({ force: true });
  // This page renders the drawer content under `.ant-drawer-content-wrapper`;
  // the outer `.ant-drawer` node is not present in all builds.
  const drawer = page.locator('.ant-drawer-content-wrapper:visible').last();
  await drawer.getByText('修改设备记录').waitFor({ state: 'visible', timeout: 10000 });

  await fieldInput(drawer, 'MAC').fill(mac);
  await fieldInput(drawer, '入网许可').fill(mac);
  await selectValue(page, drawer, '设备类型', 'P227');
  await selectValue(page, drawer, '发货状态', '已发货');

  const switchInput = drawer.locator('input[type="checkbox"][role="switch"]').first();
  if (!(await switchInput.isChecked().catch(() => false))) {
    const switchCore = drawer.locator('.el-switch__core').first();
    try {
      await switchCore.click({ force: true });
    } catch {
      await switchInput.evaluate((element) => element.click());
    }
    await page.waitForTimeout(250);
    if (!(await switchInput.isChecked().catch(() => false))) {
      await switchInput.evaluate((element) => element.click());
    }
  }
  await fieldInput(drawer, '备注').fill(options.companyName);

  if (shouldWaitForManualSubmit) {
    console.log('出库字段已填写，请在浏览器抽屉中手动点击“修改记录”；提交完成后将继续后续步骤。');
  } else {
    await submitWarehouseRecord(drawer);
  }
  await page.waitForTimeout(800);
  await drawer.waitFor({ state: 'hidden', timeout: shouldWaitForManualSubmit ? 1_800_000 : 15_000 });
  return { mac };
}

async function main() {
  const options = readInputOptions();
  console.log(`本次设备出库参数：公司名称 ${options.companyName}，设备名称 ${options.deviceName}，设备 MAC ${options.mac}`);
  if (shouldDryRunParse) return;

  const context = await launchChrome();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(WAREHOUSE_URL, { waitUntil: 'domcontentloaded' });
    await waitForWarehousePage(page);

    const search = await findSearchInput(page);
    await search.fill(options.mac);
    await search.press('Enter');
    await page.waitForTimeout(1000);
    const row = await findDeviceRow(page, options.mac);
    const result = await updateDevice(page, row, options);
    console.log(`设备 MAC ${result.mac} 已完成出库：型号 P227，发货状态已发货，入库状态已入库。`);
  } finally {
    if (shouldCloseWhenDone) await context.close().catch(() => null);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { readInputOptions };
