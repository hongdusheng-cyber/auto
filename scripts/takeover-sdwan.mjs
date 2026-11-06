import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { restoreAuthState, snapshotAuthState } from './auth-state.mjs';
import { waitForPageWithLogtoLogin } from './logto-login.mjs';
import {
  getPlaywrightSlowMo,
  runAndWaitForActivePage,
  waitForPageFullyLoaded,
} from './playwright-utils.mjs';

const ADMIN_LIST_URL = 'https://console.osase.net/admin/manage/user/user-company-list';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldDebugScreenshot = process.argv.includes('--debug-screenshot');
const shouldCloseWhenDone = process.argv.includes('--close-when-done');

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

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';

  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function readInputText() {
  const companyArg = getArgValue('--company');
  const deviceNameArg = getArgValue('--device-name');
  const deviceMacArg = getArgValue('--device-mac');

  if (companyArg || deviceNameArg || deviceMacArg) {
    return [
      companyArg ? `公司名称：${companyArg}` : '',
      deviceNameArg ? `设备名称：${deviceNameArg}` : '',
      deviceMacArg ? `设备MAC：${deviceMacArg}` : '',
    ].filter(Boolean).join('\n');
  }

  const textArg = getArgValue('--text');
  if (textArg) return textArg;

  const fileArg = getArgValue('--file');
  if (fileArg) return readFile(path.resolve(fileArg), 'utf8');

  const stdinText = await readStdinIfAvailable();
  if (stdinText.trim()) return stdinText;

  return '';
}

function normalizeLine(line) {
  return line
    .trim()
    .replace(/：/g, ':')
    .replace(/\s+/g, ' ');
}

function parseInput(text) {
  const fields = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    const match = line.match(/^([^:]+):\s*(.+)$/);
    if (!match) continue;
    fields[match[1].trim()] = match[2].trim();
  }

  const companyName = fields['公司名称'];
  const deviceName = fields['设备名称'] ?? fields['CPE名称'] ?? fields['设备名'];
  const deviceMac = fields['设备MAC'] ?? fields['设备mac'] ?? fields.MAC ?? fields.mac ?? fields['设备 Mac'];

  if (!companyName) throw new Error('输入里缺少“公司名称”。');
  if (!deviceName) throw new Error('输入里缺少“设备名称”。');
  if (!deviceMac) throw new Error('输入里缺少“设备MAC”。');

  return {
    companyName,
    deviceName,
    deviceMac,
    branchName: '默认分公司',
  };
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}

function generateInternalIp() {
  const secondOctet = Math.floor(Math.random() * 254) + 1;
  const thirdOctet = Math.floor(Math.random() * 254) + 1;
  return `10.${secondOctet}.${thirdOctet}.1`;
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

async function firstVisibleWithRetry(page, locators, attempts = 8, delayMs = 500) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (const locator of locators) {
      const current = await firstVisible(locator).catch(() => null);
      if (current) return current;
    }

    if (attempt < attempts) {
      await page.waitForTimeout(delayMs);
    }
  }

  return null;
}

async function waitForRefresh(page, milliseconds = 2000) {
  await page.waitForTimeout(milliseconds);
}

async function waitForUserLogin(page) {
  await waitForPageWithLogtoLogin(page, {
    targetUrl: ADMIN_LIST_URL,
    readyLocator: page.getByRole('button', { name: '添加用户' }),
    readyDescription: '用户管理列表',
    userDataDir: USER_DATA_DIR,
  });
  await waitForPageFullyLoaded(page);
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

async function searchCompanyIfNeeded(page, companyName) {
  if (await page.getByText(companyName, { exact: true }).first().isVisible().catch(() => false)) return;

  const searchInputs = [
    page.getByPlaceholder('请输入公司名称'),
    page.getByPlaceholder('公司名称'),
    page.getByPlaceholder('请输入关键字'),
    page.getByPlaceholder('请输入关键词'),
    page.getByPlaceholder('搜索'),
    page.locator('input').first(),
  ];

  for (const locator of searchInputs) {
    const inputBox = await firstVisible(locator).catch(() => null);
    if (!inputBox) continue;

    await inputBox.click();
    await inputBox.fill(companyName);

    if (!(await clickSearchButton(page))) await inputBox.press('Enter');

    await waitForRefresh(page, 2000);
    await page.getByText(companyName, { exact: true }).first().waitFor({ timeout: 10000 }).catch(() => null);
    return;
  }
}

async function findCompanyRow(page, companyName) {
  const tableRow = page.locator('tr', { hasText: companyName }).first();
  if (await tableRow.isVisible().catch(() => false)) return tableRow;

  const literal = xpathLiteral(companyName);
  const row = page.locator(`xpath=//*[contains(normalize-space(.), ${literal})]/ancestor::*[self::tr or contains(@class, 'table-row') or contains(@class, 'el-table__row') or contains(@class, 'ant-table-row')][1]`).first();
  if (await row.isVisible().catch(() => false)) return row;

  throw new Error(`没有在列表里找到公司：${companyName}`);
}

async function clickEnterBackendInRow(row, companyName) {
  for (const locator of [
    row.getByRole('button', { name: '进入用户后台' }),
    row.locator('text=进入用户后台'),
  ]) {
    const button = await firstVisible(locator).catch(() => null);
    if (button) {
      await button.click();
      return;
    }
  }

  throw new Error(`找到了公司“${companyName}”，但这一行里没有“进入用户后台”。`);
}

async function confirmDialogAndGetActivePage(context, page) {
  await page.waitForTimeout(500);

  const dialogButton = await firstVisible(page.getByRole('dialog').getByRole('button', { name: '确定' })).catch(() => null);
  if (dialogButton) {
    return runAndWaitForActivePage(context, page, () => dialogButton.click());
  } else {
    const confirmButtons = page.getByRole('button', { name: '确定' });
    const count = await confirmButtons.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = confirmButtons.nth(index);
      if (await button.isVisible().catch(() => false)) {
        return runAndWaitForActivePage(context, page, () => button.click());
      }
    }
  }

  throw new Error('点击“进入用户后台”后，没有找到弹窗里的“确定”按钮。');
}

async function enterUserBackend(context, page, companyName) {
  await page.goto(ADMIN_LIST_URL, { waitUntil: 'domcontentloaded' });
  await waitForUserLogin(page);
  const adminLoginState = await snapshotAuthState(context);
  await searchCompanyIfNeeded(page, companyName);

  const row = await findCompanyRow(page, companyName);
  await clickEnterBackendInRow(row, companyName);
  const userPage = await confirmDialogAndGetActivePage(context, page);
  return { userPage, adminLoginState };
}

async function clickTakeoverSdwanCpe(page) {
  await page.waitForLoadState('networkidle').catch(() => null);
  await page.getByText('接管 SD-WAN CPE').waitFor({ timeout: 60000 });

  const candidates = [
    page.getByRole('button', { name: '接管 SD-WAN CPE' }),
    page.locator('button', { hasText: '接管 SD-WAN CPE' }),
    page.locator('text=接管 SD-WAN CPE'),
  ];

  for (const locator of candidates) {
    const button = await firstVisible(locator).catch(() => null);
    if (!button) continue;

    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.waitForTimeout(1000);
    return;
  }

  throw new Error('没有找到“接管 SD-WAN CPE”按钮。');
}

async function fillInputByLabelOrPlaceholder(page, label, value, placeholders = []) {
  const candidates = [
    page.getByLabel(label),
    page.locator(`input[placeholder="${label}"]`),
    page.locator(`input[placeholder*="${label}"]`),
    ...placeholders.map((placeholder) => page.getByPlaceholder(placeholder)),
    ...placeholders.map((placeholder) => page.locator(`input[placeholder="${placeholder}"]`)),
    ...placeholders.map((placeholder) => page.locator(`input[placeholder*="${placeholder}"]`)),
    page.locator(`xpath=//*[normalize-space(.)=${xpathLiteral(label)}]/following::input[1]`),
    page.locator(`xpath=//*[normalize-space(.)=${xpathLiteral(label)}]/ancestor::div[contains(@class, "tw-flex-row")][1]//input[1]`),
  ];

  const inputBox = await firstVisibleWithRetry(page, candidates);
  if (inputBox) {
    await inputBox.scrollIntoViewIfNeeded().catch(() => null);
    await inputBox.click({ force: true });
    await inputBox.fill('');
    await inputBox.fill(value);

    const currentValue = await inputBox.inputValue().catch(() => '');
    if (currentValue !== value) {
      await inputBox.evaluate((element, nextValue) => {
        const input = element;
        const proto = Object.getPrototypeOf(input);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
          ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        const setter = descriptor?.set;
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
      }, value);
    }

    await page.waitForTimeout(300);

    const finalValue = await inputBox.inputValue().catch(() => '');
    if (finalValue !== value) {
      throw new Error(`“${label}”已找到，但写入失败，当前值是：${finalValue || '空'}`);
    }

    return;
  }

  throw new Error(`没有找到“${label}”输入框。`);
}

async function selectDefaultBranch(page, branchName) {
  const candidates = [
    page.getByPlaceholder('请选择站点'),
    page.getByRole('combobox', { name: /选择站点|站点/ }),
    page.locator('xpath=//*[normalize-space(.)="选择站点"]/following::*[self::input or contains(@class, "select")][1]'),
    page.locator('xpath=//*[normalize-space(.)="选择站点"]/following::*[self::button or @role="combobox" or contains(@class, "select")][1]'),
  ];

  for (const locator of candidates) {
    const dropdown = await firstVisible(locator).catch(() => null);
    if (!dropdown) continue;

    await dropdown.click({ force: true });
    await page.waitForTimeout(600);

    const option = await firstVisible(page.getByText(branchName, { exact: true })).catch(() => null)
      ?? await firstVisible(page.locator(`[role="option"]`, { hasText: branchName })).catch(() => null)
      ?? await firstVisible(page.locator('li, div, span', { hasText: branchName })).catch(() => null);

    if (option) {
      await option.click({ force: true });
      await page.waitForTimeout(500);
      return;
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-sdwan-branch.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存站点选择调试截图：${screenshotPath}`);
  }

  throw new Error(`没有找到站点选项：${branchName}`);
}

async function clickNext(page) {
  const nextButton = await firstVisible(page.getByRole('button', { name: '下一步' })).catch(() => null)
    ?? await firstVisible(page.locator('button', { hasText: '下一步' })).catch(() => null);

  if (!nextButton) throw new Error('没有找到“下一步”按钮。');

  await nextButton.scrollIntoViewIfNeeded();
  await nextButton.click();
  await page.waitForTimeout(1000);
}

async function fillDeviceAccessForm(page, options) {
  await page.getByText('接管一台设备').waitFor({ timeout: 60000 });
  await fillInputByLabelOrPlaceholder(page, '为设备命名', options.deviceName, ['请输入设备名称']);
  await fillInputByLabelOrPlaceholder(page, '设备MAC', options.deviceMac, ['请查看设备标签']);
  await selectDefaultBranch(page, options.branchName);
  await clickNext(page);

  console.log('正在填写第 2 步的连接名称：WAN1');
  await page.getByText('互联网', { exact: true }).first().waitFor({ timeout: 60000 });
  await fillInputByLabelOrPlaceholder(page, '连接名称', options.connectionName, ['请输入连接名称']);
  await clickNext(page);

  console.log(`正在填写第 3 步的内网 IP：${options.internalIp}`);
  await page.getByText('内部网络', { exact: true }).first().waitFor({ timeout: 60000 });
  await fillInputByLabelOrPlaceholder(
    page,
    '网关 IP/子网',
    options.internalIp,
    ['请输入一个内网地址', '请输入内网地址'],
  );
  await clickNext(page);
}

async function main() {
  const inputText = await readInputText();
  const options = parseInput(inputText);
  const internalIp = generateInternalIp();

  console.log('本次接管 SD-WAN CPE 参数：');
  console.log(`公司名称：${options.companyName}`);
  console.log(`设备名称：${options.deviceName}`);
  console.log(`设备MAC：${options.deviceMac}`);
  console.log(`站点：${options.branchName}`);
  console.log(`连接名称：WAN1`);
  console.log(`内网IP：${internalIp}`);

  if (shouldDryRunParse) return;

  const context = await launchChrome();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const { userPage, adminLoginState } = await enterUserBackend(context, page, options.companyName);
    const takeoverOptions = {
      ...options,
      connectionName: 'WAN1',
      internalIp,
    };

    try {
      await clickTakeoverSdwanCpe(userPage);
      await fillDeviceAccessForm(userPage, takeoverOptions);

      console.log('已进入用户后台，点击“接管 SD-WAN CPE”，填写设备信息并点击“下一步”。');
    } finally {
      if (adminLoginState) {
        try {
          const restored = await restoreAuthState(context, adminLoginState);
          if (restored) console.log('已恢复管理员登录态，后续设备升级会继续使用该登录状态。');
          else console.warn('当前浏览器上下文不支持恢复管理员登录态。');
        } catch (error) {
          console.warn(`恢复管理员登录态失败：${error.message}`);
        }
      }
    }

    if (shouldCloseWhenDone) {
      console.log('接管步骤已完成，正在关闭当前浏览器连接并进入设备升级步骤。');
    } else {
      console.log('浏览器将保持打开，请检查完成后手动关闭。');
    }
  } finally {
    if (shouldCloseWhenDone) await context.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
