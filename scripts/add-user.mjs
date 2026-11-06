import { chromium } from 'playwright';
import { randomInt } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCustomerProfile } from './customer-profile.mjs';
import { waitForPageWithLogtoLogin } from './logto-login.mjs';
import { getPlaywrightSlowMo, waitForPageFullyLoaded } from './playwright-utils.mjs';

const TARGET_URL = 'https://console.osase.net/admin/manage/user/user-company-list';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

const DEFAULT_INPUT = `
公司名称：贵州万三钧润新媒体直播培训有限公司
应用场景：英国10M 家宽ip tiktok直播 主流社媒包
邮箱：15519187121@qq.com
部署方式：CPE设备
`;

const shouldSubmit = process.argv.includes('--submit') || process.env.SUBMIT === 'true';
const shouldDryRunParse = process.argv.includes('--dry-run-parse');

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? '';
}

async function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';

  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }

  return text;
}

async function readInputText() {
  const textArg = getArgValue('--text');
  if (textArg) return textArg;

  const fileArg = getArgValue('--file');
  if (fileArg) {
    return readFile(path.resolve(fileArg), 'utf8');
  }

  const stdinText = await readStdinIfAvailable();
  if (stdinText.trim()) return stdinText;

  return DEFAULT_INPUT;
}

function parseInput(text) {
  const {
    companyName,
    applicationScene,
    email,
    deploymentMode,
  } = parseCustomerProfile(text);

  if (!companyName) throw new Error('输入里缺少“公司名称”。');
  if (!email) throw new Error('输入里缺少“邮箱”。');

  return buildUser({
    companyName,
    applicationScene,
    email,
    deploymentMode,
    password: getArgValue('--password'),
  });
}

function createRandomPassword() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const allCharacters = letters + digits;
  const characters = [
    letters[randomInt(letters.length)],
    digits[randomInt(digits.length)],
  ];

  while (characters.length < 10) characters.push(allCharacters[randomInt(allCharacters.length)]);
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const targetIndex = randomInt(index + 1);
    [characters[index], characters[targetIndex]] = [characters[targetIndex], characters[index]];
  }
  return characters.join('');
}

function buildUser({ companyName, applicationScene, email, deploymentMode, password }) {
  return {
    companyName,
    applicationScene,
    email,
    deploymentMode,
    lastName: companyName.replace(/有限公司$/, ''),
    firstName: '公司',
    password: String(password || '').trim() || createRandomPassword(),
    companyAddress: companyName,
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
    if (await current.isVisible().catch(() => false)) {
      return current;
    }
  }

  return null;
}

function exactTextXpath(text) {
  const escaped = text.replaceAll("'", `", "'", "`);
  return `xpath=//*[normalize-space(.)='${escaped}' or normalize-space(.)='${escaped}*'][string-length(normalize-space(.)) <= ${text.length + 2}]`;
}

async function fillField(page, fieldName, value, placeholders = []) {
  const candidates = [
    ...placeholders.map((placeholder) => page.getByPlaceholder(placeholder)),
    page.getByLabel(fieldName, { exact: false }),
    page.locator(`${exactTextXpath(fieldName)}/following::input[1]`),
    page.locator(`${exactTextXpath(fieldName)}/following::textarea[1]`),
  ];

  for (const locator of candidates) {
    const target = await firstVisible(locator).catch(() => null);
    if (!target) continue;

    await target.click();
    await target.fill(value);
    return;
  }

  throw new Error(`没有找到字段：${fieldName}`);
}

async function clickButton(page, name) {
  const candidates = [
    page.getByRole('button', { name }),
    page.locator(`text=${name}`),
  ];

  for (const locator of candidates) {
    const target = await firstVisible(locator).catch(() => null);
    if (!target) continue;

    await target.click();
    return;
  }

  throw new Error(`没有找到按钮：${name}`);
}

async function clickSearchButton(page) {
  for (const name of ['搜索', '查询']) {
    const button = await firstVisible(page.getByRole('button', { name })).catch(() => null);
    if (!button) continue;

    await button.click();
    return true;
  }

  return false;
}

async function clickSubmitAddUser(page) {
  const buttons = page.getByRole('button', { name: '添加用户' });
  const count = await buttons.count();

  for (let index = count - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }

  throw new Error('没有找到弹窗底部的“添加用户”提交按钮');
}

async function waitForUserLogin(page) {
  await waitForPageWithLogtoLogin(page, {
    targetUrl: TARGET_URL,
    readyLocator: page.getByRole('button', { name: '添加用户' }),
    readyDescription: '用户管理列表',
    userDataDir: USER_DATA_DIR,
  });
  await waitForPageFullyLoaded(page);
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

    await inputBox.click({ force: true });
    await inputBox.fill(companyName);

    if (!(await clickSearchButton(page))) await inputBox.press('Enter');

    await page.waitForTimeout(2000);
    await page.getByText(companyName, { exact: true }).first().waitFor({ timeout: 10000 }).catch(() => null);
    return;
  }
}

async function findCompanyRow(page, companyName) {
  const tableRow = page.locator('tr', { hasText: companyName }).first();
  if (await tableRow.isVisible().catch(() => false)) return tableRow;

  const row = page
    .locator(`xpath=//*[contains(normalize-space(.), ${xpathLiteral(companyName)})]/ancestor::*[self::tr or contains(@class, "table-row") or contains(@class, "el-table__row") or contains(@class, "ant-table-row")][1]`)
    .first();
  if (await row.isVisible().catch(() => false)) return row;

  throw new Error(`添加后没有在列表里找到公司：${companyName}`);
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}

async function clickSetAgentInRow(page, row, companyName) {
  const candidates = [
    row.getByRole('button', { name: '设置代理商' }),
    row.getByRole('link', { name: '设置代理商' }),
    row.getByText('设置代理商', { exact: true }),
    row.locator('button, a, span, div', { hasText: /^设置代理商$/ }),
  ];

  for (const locator of candidates) {
    const button = await firstVisible(locator).catch(() => null);
    if (!button) continue;

    await button.scrollIntoViewIfNeeded().catch(() => null);
    await button.click({ force: true });
    await page.waitForTimeout(800);
    return;
  }

  throw new Error(`找到了公司“${companyName}”，但这一行里没有“设置代理商”。`);
}

async function clickSetAgentForCompany(page, companyName) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await waitForUserLogin(page);
  await searchCompanyIfNeeded(page, companyName);

  const row = await findCompanyRow(page, companyName);
  await clickSetAgentInRow(page, row, companyName);
  console.log('已点击：设置代理商');
}

async function main() {
  const inputText = await readInputText();
  const user = parseInput(inputText);

  console.log('本次添加用户参数：');
  console.log(`公司名称：${user.companyName}`);
  console.log(`应用场景：${user.applicationScene || '(未填写到当前弹窗)'}`);
  console.log(`邮箱：${user.email}`);
  console.log(`部署方式：${user.deploymentMode || '(未填写到当前弹窗)'}`);
  console.log(`姓：${user.lastName}`);
  console.log(`名：${user.firstName}`);

  if (shouldDryRunParse) {
    return;
  }

  const context = await launchChrome();
  const page = context.pages()[0] ?? await context.newPage();

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await waitForUserLogin(page);

  await clickButton(page, '添加用户');
  await page.locator('text=通用').waitFor({ timeout: 30000 });

  await fillField(page, '姓', user.lastName, ['请输入姓']);
  await fillField(page, '名', user.firstName, ['请输入名']);
  await fillField(page, 'Email', user.email, ['请输入Email', '请输入邮箱']);
  await fillField(page, '密码', user.password, ['请输入密码']);
  await fillField(page, '公司名称', user.companyName, ['请输入公司名称']);
  await fillField(page, '公司地址', user.companyAddress, ['请输入公司地址']);

  if (shouldSubmit) {
    await clickSubmitAddUser(page);
    console.log('已点击提交：添加用户');
    await page.waitForTimeout(2000);
    console.log(`用户凭据：账号=${user.email} 密码=${user.password}`);
    await clickSetAgentForCompany(page, user.companyName);
  } else {
    console.log('已填写完成，当前为测试模式，未点击底部提交按钮。');
    console.log('确认无误后可运行：npm run add:user -- --submit');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
