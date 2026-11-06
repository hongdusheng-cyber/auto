import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { waitForPageWithLogtoLogin } from './logto-login.mjs';
import { getPlaywrightSlowMo, runAndWaitForActivePage } from './playwright-utils.mjs';

const EQUIPMENT_URL = 'https://console.osase.net/admin/manage/equipment';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldDebugScreenshot = process.argv.includes('--debug-screenshot');
const QUICK_DELAY_MS = 300;
const CONFIRM_WAIT_MS = 5000;

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

function normalizeMac(value) {
  return String(value ?? '').trim().toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}

function readInputOptions() {
  const deviceMac = getArgValue('--device-mac') ?? getArgValue('--mac');
  if (!deviceMac) {
    throw new Error('请提供设备 MAC，例如：npm run device:upgrade -- --device-mac 04:0e:65:f6:76:1c');
  }

  return {
    deviceMac: normalizeMac(deviceMac),
  };
}

async function launchChrome() {
  await mkdir(USER_DATA_DIR, { recursive: true });

  try {
    return await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      slowMo: getPlaywrightSlowMo(),
    });
  } catch (error) {
    console.warn('没有通过 channel 找到 Chrome，改用 Playwright Chromium。');
    console.warn(error.message);

    return chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: null,
      slowMo: getPlaywrightSlowMo(),
    });
  }
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) return current;
  }

  return null;
}

async function waitForEquipmentPage(page) {
  await waitForPageWithLogtoLogin(page, {
    targetUrl: EQUIPMENT_URL,
    readyLocator: page.getByText('设备管理').first(),
    readyDescription: '设备管理列表',
    userDataDir: USER_DATA_DIR,
  });
}

async function clickSearchButton(page) {
  for (const name of ['搜索', '查询']) {
    const button = await firstVisible(page.getByRole('button', { name })).catch(() => null);
    if (button) {
      await button.click();
      return true;
    }
  }

  return false;
}

async function searchDeviceIfPossible(page, deviceMac) {
  const macPattern = new RegExp(escapeRegExp(deviceMac), 'i');
  if (await page.getByText(macPattern).first().isVisible().catch(() => false)) return;

  const searchInputs = [
    page.getByPlaceholder('请输入设备名称、MAC'),
    page.getByPlaceholder('请输入设备名称'),
    page.getByPlaceholder('请输入设备MAC'),
    page.getByPlaceholder('设备MAC'),
    page.getByPlaceholder('请输入关键字'),
    page.getByPlaceholder('请输入关键词'),
    page.getByPlaceholder('搜索'),
    page.locator('input').first(),
  ];

  for (const locator of searchInputs) {
    const inputBox = await firstVisible(locator).catch(() => null);
    if (!inputBox) continue;

    await inputBox.click({ force: true });
    await inputBox.fill(deviceMac);

    if (!(await clickSearchButton(page))) await inputBox.press('Enter');

    await page.waitForTimeout(2000);
    await page.getByText(macPattern).first().waitFor({ timeout: 10000 }).catch(() => null);
    return;
  }
}

async function findDeviceRow(page, deviceMac) {
  const macPattern = new RegExp(escapeRegExp(deviceMac), 'i');

  const tableRow = page.locator('tr', { hasText: macPattern }).first();
  if (await tableRow.isVisible().catch(() => false)) return tableRow;

  const lowerLiteral = xpathLiteral(deviceMac.toLowerCase());
  const row = page.locator(`xpath=//*[contains(translate(normalize-space(.), "ABCDEF", "abcdef"), ${lowerLiteral})]/ancestor::*[self::tr or contains(@class, "table-row") or contains(@class, "el-table__row") or contains(@class, "ant-table-row")][1]`).first();
  if (await row.isVisible().catch(() => false)) return row;

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-device-upgrade-row.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存设备行调试截图：${screenshotPath}`);
  }

  throw new Error(`没有在设备列表里找到 MAC：${deviceMac}`);
}

async function extractDeviceIdFromRow(row) {
  const text = await row.textContent().catch(() => '');
  const match = text.match(/ID[:：]\s*(\d+)/i);
  return match?.[1] ?? null;
}

async function extractDeviceManagementHref(row) {
  const link = await firstVisible(row.locator('a', { hasText: '进入设备管理界面' })).catch(() => null);
  if (!link) return null;

  const href = await link.getAttribute('href').catch(() => null);
  if (!href) return null;

  return href;
}

async function clickEnterDeviceManagement(row, deviceMac) {
  const candidates = [
    row.getByRole('button', { name: '进入设备管理界面' }),
    row.locator('button', { hasText: '进入设备管理界面' }),
    row.locator('a', { hasText: '进入设备管理界面' }),
    row.locator('text=进入设备管理界面'),
  ];

  for (const locator of candidates) {
    const button = await firstVisible(locator).catch(() => null);
    if (!button) continue;

    await button.scrollIntoViewIfNeeded();
    await button.click({ force: true });
    return;
  }

  throw new Error(`找到了设备 MAC“${deviceMac}”，但这一行里没有“进入设备管理界面”。`);
}

async function confirmDialogAndGetActivePage(context, page) {
  await page.waitForTimeout(200);

  const modal = page.locator('.ant-modal-wrap:visible .ant-modal-confirm, .ant-modal-wrap:visible').last();
  await modal.waitFor({ timeout: CONFIRM_WAIT_MS }).catch(() => null);

  const candidates = [
    modal.locator('.ant-modal-confirm-btns button.ant-btn-primary').last(),
    modal.getByRole('button', { name: /确\s*定/ }),
    page.getByRole('dialog').getByRole('button', { name: /确\s*定/ }),
    page.getByRole('button', { name: /确\s*定/ }),
    page.locator('button, [role="button"], span', { hasText: /^确\s*定$/ }),
  ];

  for (const locator of candidates) {
    const button = await firstVisible(locator).catch(() => null);
    if (!button) continue;

    const clickable = await button.locator('xpath=ancestor::button[1]').first().isVisible().catch(() => false)
      ? button.locator('xpath=ancestor::button[1]').first()
      : button;
    const activePage = await runAndWaitForActivePage(context, page, () => (
      clickable.click({ force: true }).catch(async () => {
        await clickable.evaluate((element) => element.click());
      })
    ), { timeoutMs: CONFIRM_WAIT_MS });
    await activePage.waitForURL(
      (url) => /\/\d+\/equipment\/\d+\/(dashboard|settings\/update)(?:[/?#]|$)/.test(url.pathname + url.search + url.hash),
      { timeout: CONFIRM_WAIT_MS },
    ).catch(() => null);
    return activePage;
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-device-upgrade-confirm.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存确认弹窗调试截图：${screenshotPath}`);
  }

  throw new Error('点击“进入设备管理界面”后，没有找到弹窗里的“确定”按钮。');
}

function buildFirmwareUpdateUrl(deviceUrl) {
  try {
    const url = new URL(deviceUrl, 'https://console.osase.net');
    const match = url.pathname.match(/^\/(\d+)\/equipment\/(\d+)(?:\/.*)?$/);
    if (!match) return null;

    url.pathname = `/${match[1]}/equipment/${match[2]}/settings/update`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function openFirmwareUpdatePageDirectly(page, deviceUrl = null) {
  const updateUrl = buildFirmwareUpdateUrl(page.url()) ?? buildFirmwareUpdateUrl(deviceUrl);
  if (!updateUrl) {
    throw new Error('没有从设备管理页面 URL 里识别到组织 ID 和设备 ID，无法直接进入更新页。');
  }

  console.log(`正在直接进入设备更新页：${updateUrl}`);
  await page.goto(updateUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);

  await page.getByText('手动推送固件').waitFor({ timeout: 60000 });
}

async function goToFirmwareUpdatePage(page, deviceUrl = null) {
  await openFirmwareUpdatePageDirectly(page, deviceUrl);
}

async function clickFirmwareDropdown(page) {
  await page.getByText('手动推送固件').waitFor({ timeout: 60000 });

  const candidates = [
    page.locator('xpath=//*[normalize-space(.)="选择固件版本"]/following::*[self::input or self::button or @role="combobox" or contains(@class, "select")][1]'),
    page.locator('xpath=//*[normalize-space(.)="选择固件版本"]/following::*[contains(@class, "ant-select-selector") or contains(@class, "el-select") or contains(@class, "select")][1]'),
    page.locator('xpath=//*[normalize-space(.)="手动推送固件"]/following::*[contains(@class, "ant-select-selector") or contains(@class, "el-select") or @role="combobox"][1]'),
    page.locator('.ant-select-selector').first(),
  ];

  for (const locator of candidates) {
    const dropdown = await firstVisible(locator).catch(() => null);
    if (!dropdown) continue;

    await dropdown.scrollIntoViewIfNeeded();
    await dropdown.click({ force: true });
    await page.waitForTimeout(QUICK_DELAY_MS);
    return;
  }

  throw new Error('更新页面里没有找到固件版本下拉框。');
}

async function selectLatestFirmwareVersion(page) {
  await clickFirmwareDropdown(page);

  const optionLocators = [
    page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content'),
    page.locator('.ant-select-dropdown:visible .ant-select-item-option-content'),
    page.locator('.el-select-dropdown:visible .el-select-dropdown__item'),
    page.locator('[role="listbox"] [role="option"]'),
    page.locator('[role="option"]'),
    page.getByText(/^RELEASE/i),
  ];

  for (const locator of optionLocators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = locator.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;

      const text = (await option.textContent().catch(() => '')).trim();
      if (!/^RELEASE/i.test(text)) continue;

      await option.click({ force: true });
      await page.waitForTimeout(QUICK_DELAY_MS);
      console.log(`已选择顶部最新固件版本：${text}`);
      return text;
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-device-upgrade-version.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存固件版本选择调试截图：${screenshotPath}`);
  }

  throw new Error('打开固件版本下拉后，没有找到可选择的 RELEASE 固件版本。');
}

async function main() {
  const options = readInputOptions();

  console.log('本次设备升级参数：');
  console.log(`设备MAC：${options.deviceMac}`);

  if (shouldDryRunParse) return;

  const context = await launchChrome();
  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(EQUIPMENT_URL, { waitUntil: 'domcontentloaded' });
  await waitForEquipmentPage(page);
  await searchDeviceIfPossible(page, options.deviceMac);

  const row = await findDeviceRow(page, options.deviceMac);
  const deviceManagementHref = await extractDeviceManagementHref(row).catch(() => null);
  await clickEnterDeviceManagement(row, options.deviceMac);
  const devicePage = await confirmDialogAndGetActivePage(context, page);
  await goToFirmwareUpdatePage(devicePage, deviceManagementHref);
  await selectLatestFirmwareVersion(devicePage);

  console.log('已根据设备 MAC 进入设备管理界面，打开设备更新页，并选择顶部最新固件版本。');
  console.log('脚本不会点击“推送至设备”，请确认后手动推送。');
  console.log('浏览器将保持打开，请检查完成后手动关闭。');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
