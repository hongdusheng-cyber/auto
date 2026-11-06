import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';
import { isLogtoLoginUrl, waitForPageWithLogtoLogin } from './logto-login.mjs';
import { enterCompanyBackend } from './company-backend.mjs';
import { parseCustomerProfile } from './customer-profile.mjs';
import { restoreAuthState } from './auth-state.mjs';

const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldDebugScreenshot = process.argv.includes('--debug-screenshot');
const shouldCloseWhenDone = process.argv.includes('--close-when-done');
const QUICK_DELAY_MS = 500;
const SWITCH_SETTLE_DELAY_MS = 1500;
const BETWEEN_RULES_DELAY_MS = 1200;
const SWITCH_WAIT_TIMEOUT_MS = 8000;
const SWITCH_RETRY_COUNT = 2;
const RULES_PAGE_RETRY_COUNT = 20;
const RULES_PAGE_RETRY_DELAY_MS = 3000;

function buildTrafficRulesUrl(serviceId) {
  const url = new URL(`https://console.osase.net/manage/saas/${serviceId}/detail/rules`);
  url.searchParams.set('saas_rule_type', '2');
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '100');
  url.searchParams.set('rule_page_2', '1');
  url.searchParams.set('rule_page_size_2', '100');
  return url.toString();
}

function extractServiceId(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const pathMatch = trimmed.match(/\/manage\/saas\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
  if (pathMatch) return pathMatch[1];

  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;

  throw new Error('网络加速服务 ID 格式错误，请填写纯 ID，或完整规则页 URL，例如：https://console.osase.net/manage/saas/8563/detail/rules');
}

export function parseRulesTarget(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.origin !== 'https://console.osase.net'
      || !/^\/manage\/saas\/[A-Za-z0-9_-]+\/detail\/rules\/?$/.test(url.pathname)) {
      throw new Error('请使用 console.osase.net 的网络加速规则页 URL。');
    }
    const serviceId = extractServiceId(url.toString());
    if (!serviceId) {
      throw new Error('规则页 URL 里没有识别到服务 ID，请使用形如 https://console.osase.net/manage/saas/8563/detail/rules 的地址。');
    }
    return { url: buildTrafficRulesUrl(serviceId), serviceId };
  }

  const serviceId = extractServiceId(trimmed);
  return {
    serviceId,
    url: buildTrafficRulesUrl(serviceId),
  };
}

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

function getRepeatedArgValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (value && !value.startsWith('--')) values.push(value);
  }

  return values;
}

function parseRuleNames(value) {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('--rules JSON 必须是数组。');
    return parsed.map((item) => String(item).trim()).filter(Boolean);
  }

  return trimmed
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readInputOptions() {
  const rulesTargetInput = getArgValue('--rules-url')
    ?? getArgValue('--url')
    ?? getArgValue('--service-id')
    ?? getArgValue('--id');
  const rulesTarget = parseRulesTarget(rulesTargetInput);
  if (!rulesTarget) throw new Error('请提供网络加速服务 ID。');

  let companyName = String(getArgValue('--company') ?? '').trim();
  if (!companyName && getArgValue('--file')) {
    const customerText = await readFile(path.resolve(getArgValue('--file')), 'utf8');
    companyName = parseCustomerProfile(customerText).companyName;
  }
  if (!companyName) throw new Error('请提供公司名称（--company），或通过 --file 读取客户资料。');

  const rules = [
    ...getRepeatedArgValues('--rule'),
    ...parseRuleNames(getArgValue('--rules')),
  ].map((item) => item.trim()).filter(Boolean);

  const uniqueRules = [...new Set(rules)];
  if (uniqueRules.length === 0) throw new Error('请至少选择一个规则应用。');

  return {
    companyName,
    rulesTarget,
    rules: uniqueRules,
  };
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
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
  if (typeof locator?.count !== 'function') return null;
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) return current;
  }

  return null;
}

export async function openTrafficRules(page, target, {
  closeWhenDone = shouldCloseWhenDone,
  waitForLogin = waitForPageWithLogtoLogin,
  reenterCompany = null,
} = {}) {
  const rulesUrl = target.url;
  console.log(`正在进入流量调度规则页：${rulesUrl}`);
  let rulesTab = page.getByText('预审批规则');
  const retryCount = closeWhenDone ? RULES_PAGE_RETRY_COUNT : 1;
  const isLoginPromptVisible = async () => {
    // A SPA can render the login shell before it redirects to /login. In a
    // company backend we must re-enter through the administrator page so the
    // company session is rebuilt; applying the shared administrator snapshot
    // directly here would overwrite that session.
    if (typeof page.getByRole !== 'function') return false;
    const candidates = [
      page.getByRole('button', { name: '使用 Logto 登录', exact: true }),
      page.locator?.('button', { hasText: /^\s*使用 Logto 登录\s*$/ }),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (await firstVisible(candidate)) return true;
    }
    return false;
  };

  const authenticateIfNeeded = async () => {
    const loginUrl = isLogtoLoginUrl(page.url());
    const loginPrompt = loginUrl || await isLoginPromptVisible();
    if (!loginPrompt) return;
    if (reenterCompany) {
      page = await reenterCompany(page);
      rulesTab = page.getByText('预审批规则');
      await page.goto(rulesUrl, { waitUntil: 'domcontentloaded' });
      return;
    }
    await waitForLogin(page, {
      targetUrl: rulesUrl,
      readyLocator: rulesTab.first(),
      readyDescription: '流量调度规则页',
      userDataDir: USER_DATA_DIR,
      initialTimeoutMs: 1000,
    });
  };

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    await page.goto(rulesUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await authenticateIfNeeded();
    await page.waitForURL(
      (url) => url.pathname === `/manage/saas/${target.serviceId}/detail/rules` || isLogtoLoginUrl(url.toString()),
      { timeout: 10000, waitUntil: 'domcontentloaded' },
    ).catch(() => null);
    await authenticateIfNeeded();
    await rulesTab.first().waitFor({ timeout: 5000 }).catch(() => null);
    await authenticateIfNeeded();
    if (await rulesTab.first().isVisible().catch(() => false)) break;

    if (attempt < retryCount) {
      console.log(`规则页尚未就绪，可能正在开通合约，${RULES_PAGE_RETRY_DELAY_MS / 1000} 秒后重试（${attempt}/${retryCount}）。`);
      await page.waitForTimeout(RULES_PAGE_RETRY_DELAY_MS);
    }
  }

  if (!(await rulesTab.first().isVisible().catch(() => false))) {
    if (closeWhenDone) {
      throw new Error(`合约开通期间规则页一直未就绪，已自动重试 ${RULES_PAGE_RETRY_COUNT} 次。`);
    }

    console.log('还没有看到“预审批规则”，可能需要先登录或等待页面加载。');
    console.log(`请在脚本打开的浏览器窗口里完成登录并确认已进入规则页，登录态会保存在：${USER_DATA_DIR}`);

    const rl = readline.createInterface({ input, output });
    await rl.question('完成后按 Enter 继续...');
    rl.close();

    await page.goto(rulesUrl, { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded();
    await rulesTab.first().waitFor({ timeout: 60000 });
  }

  const preApprovalTab = await firstVisible(page.getByText('预审批规则', { exact: true })).catch(() => null);
  if (preApprovalTab) {
    await preApprovalTab.click({ force: true }).catch(() => null);
    await page.waitForTimeout(QUICK_DELAY_MS);
  }
  return page;
}

async function findRuleRow(page, ruleName) {
  const exactText = page.getByText(ruleName, { exact: true }).first();
  await exactText.waitFor({ timeout: 20000 }).catch(() => null);
  const exactTextRow = exactText.locator('xpath=ancestor::*[self::tr or contains(@class, "table-row") or contains(@class, "ant-table-row")][1]').first();
  if (await exactTextRow.isVisible().catch(() => false)) return exactTextRow;

  const literal = xpathLiteral(ruleName);
  const row = page.locator(`xpath=//*[normalize-space(.)=${literal}]/ancestor::*[self::tr or contains(@class, "table-row") or contains(@class, "ant-table-row")][1]`).first();
  if (await row.isVisible().catch(() => false)) return row;

  const tableRow = page.locator('tr', { hasText: ruleName }).first();
  if (await tableRow.isVisible().catch(() => false)) return tableRow;

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve(`debug-add-rules-${ruleName.replaceAll(/[^\w\u4e00-\u9fa5-]+/g, '_')}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存规则行调试截图：${screenshotPath}`);
  }

  throw new Error(`没有在预审批规则里找到应用：${ruleName}`);
}

async function isRuleSelected(control) {
  const ariaChecked = await control.getAttribute('aria-checked').catch(() => null);
  if (ariaChecked) return ariaChecked === 'true';

  const checkedByClass = await control.evaluate((element) => {
    if (element instanceof HTMLInputElement) return element.checked;
    const controlRoot = element.closest('.el-switch, .ant-switch, .el-checkbox, .ant-checkbox-wrapper, .ant-checkbox') ?? element;
    const input = controlRoot.querySelector('input[type="checkbox"], [role="checkbox"], [role="switch"]');
    if (input instanceof HTMLInputElement) return input.checked || input.getAttribute('aria-checked') === 'true';
    if (input?.getAttribute('aria-checked')) return input.getAttribute('aria-checked') === 'true';
    return [...controlRoot.classList].some((name) => name.includes('checked'));
  }).catch(() => false);

  return checkedByClass;
}

async function waitForRuleSelected(page, control, timeoutMs = SWITCH_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isRuleSelected(control)) return true;
    await page.waitForTimeout(250);
  }

  return await isRuleSelected(control);
}

async function selectRule(page, ruleName) {
  const row = await findRuleRow(page, ruleName);
  const controlCandidates = [
    row.getByRole('checkbox').first(),
    row.locator('.el-checkbox:not(.is-disabled)').first(),
    row.locator('.ant-checkbox-wrapper:not(.ant-checkbox-wrapper-disabled)').first(),
    row.locator('.el-switch:not(.is-disabled)').first(),
    row.locator('.el-switch__core').first(),
    row.locator('[role="switch"]').first(),
    row.locator('button[class*="switch"]').first(),
    row.locator('.ant-switch').first(),
    row.locator('input[type="checkbox"]').first(),
  ];

  let control = null;
  for (const locator of controlCandidates) {
    if (await locator.isVisible().catch(() => false)) {
      control = locator;
      break;
    }
  }

  if (!control) throw new Error(`找到了应用“${ruleName}”，但没有找到可勾选的规则控件。`);

  if (await isRuleSelected(control)) {
    console.log(`规则已勾选，跳过：${ruleName}`);
    return;
  }

  await control.scrollIntoViewIfNeeded().catch(() => null);

  for (let attempt = 1; attempt <= SWITCH_RETRY_COUNT; attempt += 1) {
    await control.click({ force: true });
    await page.waitForTimeout(QUICK_DELAY_MS);
    const selected = await waitForRuleSelected(page, control);

    if (selected) {
      console.log(`已勾选规则：${ruleName}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}`);
      await page.waitForTimeout(SWITCH_SETTLE_DELAY_MS);
      return;
    }

    console.log(`规则还没真正勾选，准备重试：${ruleName}${attempt < SWITCH_RETRY_COUNT ? '，继续再点一次' : ''}`);
    await page.waitForTimeout(SWITCH_SETTLE_DELAY_MS);
  }

  throw new Error(`已尝试勾选应用“${ruleName}”多次，但规则状态仍未变成已选中。`);
}

export async function addRulesForCompany(context, page, options, {
  enterBackend = enterCompanyBackend,
  openRules = openTrafficRules,
  select = selectRule,
  restoreAdminState = restoreAuthState,
  betweenRulesMs = BETWEEN_RULES_DELAY_MS,
} = {}) {
  let adminLoginState = null;
  let workflowError = null;
  const enter = async (currentPage) => {
    // Entry handles its own failure cleanup. Do not let an earlier snapshot
    // overwrite a renewed session if this entry authenticates and then fails.
    adminLoginState = null;
    const result = await enterBackend(context, currentPage, options.companyName, { userDataDir: USER_DATA_DIR });
    adminLoginState = result.adminLoginState;
    return result.userPage;
  };
  try {
    page = await enter(page);
    page = await openRules(page, options.rulesTarget, { reenterCompany: enter });
    const failedRules = [];
    for (const ruleName of options.rules) {
      try {
        await select(page, ruleName);
      } catch (error) {
        failedRules.push({ ruleName, error });
        console.error(`勾选规则失败：${ruleName}`);
        console.error(error);
      } finally {
        if (betweenRulesMs > 0) await page.waitForTimeout(betweenRulesMs);
      }
    }

    if (failedRules.length > 0) {
      const failedRuleNames = failedRules.map(({ ruleName }) => ruleName).join('、');
      throw new AggregateError(
        failedRules.map(({ error }) => error),
        `已尝试完成所有规则，其中 ${failedRules.length} 条启用失败：${failedRuleNames}`,
      );
    }
  } catch (error) {
    workflowError = error;
    throw error;
  } finally {
    if (adminLoginState) {
      try {
        if (!(await restoreAdminState(context, adminLoginState))) throw new Error('浏览器不支持恢复管理员登录态。');
        console.log('已恢复管理员登录态，后续任务可继续使用管理员后台。');
      } catch (error) {
        if (workflowError) throw new AggregateError([workflowError, error], `${workflowError.message}；恢复管理员登录态失败：${error.message}`);
        throw new Error(`规则已处理，但恢复管理员登录态失败：${error.message}`, { cause: error });
      }
    }
  }
}

async function main() {
  const options = await readInputOptions();

  console.log('本次添加规则参数：');
  console.log(`公司名称：${options.companyName}`);
  console.log(`规则页：${options.rulesTarget.url}`);
  console.log(`规则应用：${options.rules.join('、')}`);

  if (shouldDryRunParse) return;

  const context = await launchChrome();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await addRulesForCompany(context, page, options);
  } finally {
    if (shouldCloseWhenDone) await context.close().catch(() => null);
  }

  console.log('添加规则完成：已按所选应用勾选预审批规则。');
  if (shouldCloseWhenDone) {
    console.log('添加规则步骤已完成，浏览器已关闭。');
  } else {
    console.log('浏览器将保持打开；请检查完成后手动关闭。');
    await new Promise((resolve) => context.once('close', resolve));
    console.log('已检测到浏览器关闭，添加规则步骤结束。');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
