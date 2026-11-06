import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitForPageWithLogtoLogin } from './logto-login.mjs';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';
import { contractIdTextPattern, normalizeContractId, parseProxyValue, renderMagicConfig } from './magic-config.mjs';

const CONTRACT_URL = 'https://console.osase.net/admin/manage/contract/cross';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');
const CONTROL_PANEL_DIR = path.resolve('.control-panel');

const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldDryRunConfig = process.argv.includes('--dry-run-config');
const shouldDebugScreenshot = process.argv.includes('--debug-screenshot');
const shouldCloseWhenDone = process.argv.includes('--close-when-done');
const CONTRACT_ID_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const CONTRACT_SYNC_RETRY_ATTEMPTS = 20;
const CONTRACT_SYNC_RETRY_DELAY_MS = 3000;

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
  const contractIdArg = getArgValue('--contract-id');
  const contractIdFileArg = getArgValue('--contract-id-file');
  if (!contractIdArg && !contractIdFileArg) {
    throw new Error('请提供合约 ID，或使用 --contract-id-file 等待网络加速结果。');
  }

  const proxyArg = getArgValue('--ip');
  return {
    contractId: contractIdArg ? normalizeContractId(contractIdArg) : null,
    contractIdFile: contractIdFileArg ? path.resolve(contractIdFileArg) : null,
    proxy: proxyArg ? parseProxyValue(proxyArg) : null,
  };
}

async function waitForContractIdFile(resultFile) {
  const deadline = Date.now() + CONTRACT_ID_WAIT_TIMEOUT_MS;
  console.log(`合约后台已就绪，正在等待网络加速 ID：${resultFile}`);

  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(resultFile, 'utf8'));
      if (result.status === 'failed') {
        throw new Error(`网络加速失败，合约开通已取消：${result.error || '未知错误'}`);
      }
      if (result.status === 'success') {
        return normalizeContractId(result.serviceId);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`等待网络加速 ID 超时：${resultFile}`);
}

async function buildMagicConfig(proxy) {
  if (!proxy) return null;

  const template = await readFile(path.resolve('examples/模板.txt'), 'utf8');
  return renderMagicConfig(template, proxy);
}

async function saveMagicConfigBackup(configText, contractId) {
  await mkdir(CONTROL_PANEL_DIR, { recursive: true });

  const contractConfigPath = path.join(CONTROL_PANEL_DIR, `magic-config-${contractId}.txt`);
  const latestConfigPath = path.join(CONTROL_PANEL_DIR, 'magic-config-latest.txt');
  await writeFile(contractConfigPath, configText, 'utf8');
  await writeFile(latestConfigPath, configText, 'utf8');

  return { contractConfigPath, latestConfigPath };
}

async function outputMagicConfigFallback(configText, contractId, reason, backupPaths = null) {
  if (!configText) return;

  const paths = backupPaths ?? await saveMagicConfigBackup(configText, contractId);

  console.warn('\nMagic 配置自动填写失败，已启用手动填写兜底。');
  console.warn(`失败原因：${reason}`);
  console.warn(`已保存配置文件：${paths.contractConfigPath}`);
  console.warn(`最新配置副本：${paths.latestConfigPath}`);
  console.warn('请打开已保存的配置文件，将内容粘贴到当前浏览器的 Magic 配置编辑器。');
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
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await current.isVisible().catch(() => false)) return current;
  }

  return null;
}

async function waitForLoginOrContractPage(page) {
  await waitForPageWithLogtoLogin(page, {
    targetUrl: CONTRACT_URL,
    readyLocator: page.getByText('加速合约列表'),
    readyDescription: '加速合约列表',
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

async function searchContractIfPossible(page, { contractId }) {
  const keyword = contractId;
  if (!keyword) return;
  if (await page.getByText(keyword, { exact: true }).first().isVisible().catch(() => false)) return;

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
    await inputBox.fill(keyword);

    if (!(await clickSearchButton(page))) await inputBox.press('Enter');

    await page.waitForTimeout(2000);
    await page.getByText(keyword, { exact: true }).first().waitFor({ timeout: 10000 }).catch(() => null);
    return;
  }
}

async function findContractRow(page, { contractId }) {
  if (contractId) {
    const idText = page.getByText(contractIdTextPattern(contractId));
    const rows = idText.locator('xpath=ancestor::*[self::tr or contains(@class, "table-row") or contains(@class, "el-table__row") or contains(@class, "ant-table-row")][1]');
    const row = await firstVisible(rows);
    if (row) return row;
  }

  throw new Error(`没有在加速合约列表里找到合约 ID：${contractId}`);
}

async function waitForContractRow(page, options) {
  for (let attempt = 1; attempt <= CONTRACT_SYNC_RETRY_ATTEMPTS; attempt += 1) {
    await searchContractIfPossible(page, options);
    const row = await findContractRow(page, options).catch(() => null);
    if (row) return row;

    if (attempt < CONTRACT_SYNC_RETRY_ATTEMPTS) {
      console.log(`合约 ${options.contractId} 暂未同步到列表，${CONTRACT_SYNC_RETRY_DELAY_MS / 1000} 秒后重试（${attempt}/${CONTRACT_SYNC_RETRY_ATTEMPTS}）。`);
      await page.waitForTimeout(CONTRACT_SYNC_RETRY_DELAY_MS);
    }
  }

  throw new Error(`等待合约 ${options.contractId} 同步到合约列表超时。`);
}

async function enableAppGlobalAcceleration(row) {
  const switchLabel = row.getByText('App 全局加速开关', { exact: true }).first();
  await switchLabel.waitFor({ timeout: 30000 });

  const switchInput = row.locator('xpath=.//*[normalize-space(.)="App 全局加速开关"]/following::input[@type="checkbox"][1]').first();
  if (await switchInput.isVisible().catch(() => false)) {
    if (!(await switchInput.isChecked().catch(() => false))) {
      await switchInput.click({ force: true });
      await row.page().waitForTimeout(800);
    }
    return;
  }

  const switchButton = row.locator('xpath=.//*[normalize-space(.)="App 全局加速开关"]/following::*[@role="switch" or contains(@class, "switch")][1]').first();
  if (await switchButton.isVisible().catch(() => false)) {
    const checked = await switchButton.getAttribute('aria-checked');
    if (checked !== 'true') await switchButton.click({ force: true });
    await row.page().waitForTimeout(800);
    return;
  }

  const labelBox = await switchLabel.boundingBox();
  if (labelBox) {
    await row.page().mouse.click(labelBox.x + labelBox.width + 35, labelBox.y + labelBox.height / 2);
    await row.page().waitForTimeout(800);
    return;
  }

  throw new Error('没有找到“App 全局加速开关”的开关元素。');
}

async function clickOpenContract(row) {
  const openButton = await firstVisible(row.getByRole('button', { name: '开通' })).catch(() => null)
    ?? await firstVisible(row.locator('text=开通')).catch(() => null);

  if (!openButton) return false;

  await openButton.click();
  return true;
}

async function confirmAntModal(page, { required = true } = {}) {
  await page.waitForTimeout(1000);
  const modal = page.locator('.ant-modal-wrap:visible .ant-modal-confirm').last();
  await modal.waitFor({ timeout: 10000 }).catch(() => null);

  const copiedConfirmSpan = page.locator('body > div:nth-child(3) > div > div.ant-modal-wrap > div > div:nth-child(1) > div > div > div > div.ant-modal-confirm-btns > button.css-7g4oe7.ant-btn.ant-btn-primary > span');
  if (await copiedConfirmSpan.isVisible().catch(() => false)) {
    await copiedConfirmSpan.locator('xpath=ancestor::button[1]').click({ force: true });
    await page.waitForTimeout(500);
    return true;
  }

  const antConfirmButton = modal.locator('.ant-modal-confirm-btns button.ant-btn-primary').last();
  if (await antConfirmButton.isVisible().catch(() => false)) {
    await antConfirmButton.click({ force: true }).catch(async () => {
      await antConfirmButton.evaluate((button) => button.click());
    });
    await page.waitForTimeout(500);
    return true;
  }

  const modalConfirmByText = modal.locator('button.ant-btn-primary', { hasText: /确\s*定/ }).last();
  if (await modalConfirmByText.isVisible().catch(() => false)) {
    await modalConfirmByText.click({ force: true });
    await page.waitForTimeout(500);
    return true;
  }

  const buttonBox = await page.locator('.ant-modal-wrap:visible .ant-modal-confirm-btns button.ant-btn-primary').last().boundingBox().catch(() => null);
  if (buttonBox) {
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.waitForTimeout(500);
    return true;
  }

  const dialogConfirm = page.getByRole('dialog').getByRole('button', { name: '确定' });
  const dialogButton = await firstVisible(dialogConfirm).catch(() => null);
  if (dialogButton) {
    await dialogButton.click();
    return true;
  }

  const confirmButtons = page.getByRole('button', { name: '确定' });
  const count = await confirmButtons.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const button = confirmButtons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return true;
    }
  }

  const textConfirmButtons = page.locator('button, [role="button"], div, span', { hasText: /^确定$/ });
  const textConfirmCount = await textConfirmButtons.count();
  for (let index = textConfirmCount - 1; index >= 0; index -= 1) {
    const button = textConfirmButtons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true });
      return true;
    }
  }

  const confirmText = page.getByText('确定', { exact: true });
  const confirmTextCount = await confirmText.count();
  for (let index = confirmTextCount - 1; index >= 0; index -= 1) {
    const target = confirmText.nth(index);
    if (await target.isVisible().catch(() => false)) {
      await target.click({ force: true });
      return true;
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-open-contract-confirm.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存确认弹窗调试截图：${screenshotPath}`);
  }

  if (!required) return false;

  throw new Error('没有找到弹窗里的“确定”按钮。');
}

async function clickPopVirtualMachine(row) {
  const popLink = await firstVisible(
    row.locator('xpath=.//*[contains(normalize-space(.), "PoP 虚拟机 ID")]/following::a[1]'),
  ).catch(() => null)
    ?? await firstVisible(row.locator('a', { hasText: /SDWAN|POP|PoP/i })).catch(() => null);

  if (!popLink) throw new Error('找到了合约行，但没有找到 PoP 虚拟机 ID 链接。');

  await popLink.scrollIntoViewIfNeeded();
  await popLink.click();
}

async function ensureSingleExport(page) {
  await page.waitForTimeout(2000);
  await page.getByText('单出口').waitFor({ timeout: 60000 });

  const singleExport = page.getByText('单出口', { exact: true }).first();
  await singleExport.scrollIntoViewIfNeeded();

  const toggle = page.locator('xpath=//*[normalize-space(.)="单出口"]/following::*[@role="switch" or contains(@class, "switch")][1]').first();
  if (await toggle.isVisible().catch(() => false)) {
    const state = await toggle.evaluate((element) => {
      const ariaChecked = element.getAttribute('aria-checked');
      const className = String(element.getAttribute('class') ?? '');
      const input = element.matches('input[type="checkbox"]')
        ? element
        : element.querySelector('input[type="checkbox"]');
      const { backgroundColor } = window.getComputedStyle(element);
      const rgb = backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      const [, r = '0', g = '0', b = '0'] = rgb ?? [];
      const looksBlue = Number(b) > Number(r) + 40 && Number(b) > Number(g) + 20;

      if (ariaChecked === 'true' || input?.checked) return 'multi';
      if (ariaChecked === 'false' || input?.checked === false) return 'single';
      if (/(^|\s)(ant-switch-checked|is-checked|checked)(\s|$)/i.test(className)) return 'multi';
      if (looksBlue) return 'multi';
      return 'single';
    });

    if (state === 'multi') {
      console.log('检测到当前是多出口（蓝色/已选择），点击切换为单出口。');
      await toggle.click({ force: true });
    } else {
      console.log('当前已是单出口（未选择/向左），保持不变。');
    }
    await page.waitForTimeout(1000);
    return;
  }

  const input = page.locator('xpath=//*[normalize-space(.)="单出口"]/following::input[@type="checkbox"][1]').first();
  if ((await input.count()) > 0) {
    if (await input.isChecked().catch(() => false)) await input.click({ force: true });
    await page.waitForTimeout(1000);
    return;
  }

  console.log('未识别到单/多出口开关状态，默认保持当前状态继续。');
}

async function clickExportConfig(page) {
  const exportConfigButton = await firstVisible(page.getByRole('button', { name: '出口配置' })).catch(() => null)
    ?? await firstVisible(page.locator('text=出口配置')).catch(() => null);

  if (!exportConfigButton) throw new Error('没有找到“出口配置”按钮。');

  await exportConfigButton.scrollIntoViewIfNeeded();
  await exportConfigButton.click();
  await page.waitForTimeout(1000);
}

async function pasteText(page, text) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  }).catch(() => null);

  const copied = await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
    return true;
  }, text).catch(() => false);

  if (copied) {
    await page.keyboard.press('Control+V');
    return true;
  }

  return page.evaluate((value) => {
    const target = document.activeElement;
    if (!target) return false;

    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData,
      bubbles: true,
      cancelable: true,
    });

    return target.dispatchEvent(pasteEvent);
  }, text).catch(() => false);
}

async function fillMagicConfig(page, configText) {
  if (!configText) return;

  await page.getByText('Magic 配置编辑器').waitFor({ timeout: 60000 });
  await page.locator('.monaco-view[data-mode-id="yaml"] .monaco-editor, .monaco-editor, .view-lines.monaco-mouse-cursor-text, textarea, [contenteditable="true"]').first().waitFor({ timeout: 30000 });

  const updatedMonacoModel = await page.evaluate((value) => {
    const monaco = window.monaco;
    const models = monaco?.editor?.getModels?.() ?? [];
    if (models.length === 0) return false;

    const configModel = models.find((model) => {
      const text = model.getValue?.() ?? '';
      const languageId = model.getLanguageId?.() ?? '';
      return languageId === 'yaml' || text.includes('proxies:') || text.includes('proxy-groups:') || text.includes('rules:');
    }) ?? models.at(-1);

    configModel.setValue(value);
    return true;
  }, configText).catch(() => false);

  if (updatedMonacoModel) {
    await page.waitForTimeout(500);
    return;
  }

  const monacoVisibleLayer = await firstVisible(page.locator('.monaco-view[data-mode-id="yaml"] .view-lines.monaco-mouse-cursor-text, .monaco-editor .view-lines.monaco-mouse-cursor-text, .view-lines.monaco-mouse-cursor-text, .monaco-editor .view-lines, .monaco-editor')).catch(() => null);
  if (monacoVisibleLayer) {
    await monacoVisibleLayer.click({ force: true });
    await page.waitForFunction(() => document.activeElement?.matches('textarea.inputarea, textarea[aria-label="Editor content"]'), null, { timeout: 1500 }).catch(async () => {
      await page.locator('.monaco-view[data-mode-id="yaml"] textarea.inputarea, .monaco-editor textarea.inputarea, textarea[aria-label="Editor content"]').first().evaluate((textarea) => textarea.focus()).catch(() => null);
    });
    await page.keyboard.press('Control+A');
    if (!(await pasteText(page, configText))) {
      throw new Error('没有成功粘贴 Magic 配置。');
    }
    await page.waitForTimeout(500);
    return;
  }

  const textareas = [
    page.locator('.cm-content[contenteditable="true"]').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('textarea').first(),
  ];

  for (const locator of textareas) {
    const editor = await firstVisible(locator).catch(() => null);
    if (!editor) continue;

    await editor.click({ force: true });
    await page.keyboard.press('Control+A');
    if (!(await pasteText(page, configText))) {
      throw new Error('没有成功粘贴 Magic 配置。');
    }
    await page.waitForTimeout(500);
    return;
  }

  throw new Error('没有找到 Magic 配置编辑器输入区域。');
}

async function clickSaveMagicConfig(page, { required = false } = {}) {
  if (!required) await page.waitForTimeout(500);

  const saveButtonLocators = [
    page.getByRole('button', { name: /^保存$/ }),
    page.getByRole('button', { name: /保存/ }),
    page.getByRole('button', { name: /^确定$/ }),
    page.getByRole('button', { name: /^确认$/ }),
    page.getByRole('button', { name: /^提交$/ }),
    page.locator('button, [role="button"]', { hasText: /保存|确定|确认|提交/ }),
  ];

  for (const locator of saveButtonLocators) {
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = locator.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      if (await button.isDisabled().catch(() => false)) continue;

      await button.scrollIntoViewIfNeeded().catch(() => null);
      await button.click({ force: true });
      await confirmAntModal(page, { required: false }).catch(() => false);
      await page.waitForTimeout(1000);
      return true;
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-open-contract-save-magic.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存 Magic 保存按钮调试截图：${screenshotPath}`);
  }

  if (required) throw new Error('没有找到 Magic 配置的保存/确定按钮。');
  return false;
}

async function main() {
  const options = readInputOptions();

  console.log('本次开通合约参数：');
  if (options.contractId) console.log(`合约ID：${options.contractId}`);
  else console.log(`合约ID：将从网络加速结果获取（${options.contractIdFile}）`);
  if (options.proxy) {
    console.log(`代理：${options.proxy.server}:${options.proxy.port}:${options.proxy.username}:******`);
  }

  const magicConfig = await buildMagicConfig(options.proxy);

  if (shouldDryRunConfig) {
    console.log(magicConfig ?? '未提供 --ip，不生成 Magic 配置。');
    return;
  }

  if (shouldDryRunParse) return;
  const context = await launchChrome();
  try {
    const page = context.pages()[0] ?? await context.newPage();

    await page.goto(CONTRACT_URL, { waitUntil: 'domcontentloaded' });
    await waitForLoginOrContractPage(page);
    if (!options.contractId) {
      options.contractId = await waitForContractIdFile(options.contractIdFile);
      console.log(`已收到网络加速 ID：${options.contractId}，开始查找合约。`);
    }

    const magicBackupPaths = magicConfig ? await saveMagicConfigBackup(magicConfig, options.contractId) : null;
    if (magicBackupPaths) {
      console.log(`已生成 Magic 手动兜底配置：${magicBackupPaths.contractConfigPath}`);
      console.log(`最新兜底副本：${magicBackupPaths.latestConfigPath}`);
    }

    const row = await waitForContractRow(page, options);
    await enableAppGlobalAcceleration(row);
    const didClickOpen = await clickOpenContract(row);
    if (didClickOpen) {
      await confirmAntModal(page);
      await page.waitForTimeout(3000);
    } else {
      console.log('未找到“开通”按钮，判断该合约可能已开通，继续进入 PoP。');
    }

    const refreshedRow = await waitForContractRow(page, options);
    await clickPopVirtualMachine(refreshedRow);
    await ensureSingleExport(page);
    await clickExportConfig(page);
    let needsManualMagicCheck = false;
    try {
      await fillMagicConfig(page, magicConfig);
      const savedMagicConfig = await clickSaveMagicConfig(page, { required: shouldCloseWhenDone && Boolean(magicConfig) });
      console.log(savedMagicConfig
        ? '已开通合约，进入 PoP 页面，确保单出口，点击“出口配置”，并填写、保存 Magic 配置。'
        : '已开通合约，进入 PoP 页面，确保单出口，点击“出口配置”，并填写 Magic 配置。');
    } catch (error) {
      await outputMagicConfigFallback(magicConfig, options.contractId, error.message, magicBackupPaths);
      if (shouldCloseWhenDone) {
        throw new Error(`Magic 配置自动填写或保存失败，任务未完成：${error.message}`, { cause: error });
      }
      console.log('已进入 PoP 页面，并停留在 Magic 配置编辑器，请手动填写兜底配置文件。');
      needsManualMagicCheck = true;
    }

    if (shouldDebugScreenshot) {
      const screenshotPath = path.resolve('debug-open-contract-result.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`已保存调试截图：${screenshotPath}`);
    }

    if (shouldCloseWhenDone && !needsManualMagicCheck) {
      await context.close();
      console.log('合约开通步骤已完成，浏览器已关闭。');
    } else {
      console.log('浏览器将保持打开；任务会等待你手动关闭浏览器后再结束。');
      await new Promise((resolve) => context.once('close', resolve));
      console.log('已检测到浏览器关闭，合约开通步骤结束。');
    }
  } catch (error) {
    if (shouldCloseWhenDone) await context.close().catch(() => null);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
