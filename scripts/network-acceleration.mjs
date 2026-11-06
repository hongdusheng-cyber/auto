import { chromium } from 'playwright';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreAuthState } from './auth-state.mjs';
import { normalizeLine, parseCustomerProfile } from './customer-profile.mjs';
import { enterCompanyBackend } from './company-backend.mjs';
import { getPlaywrightSlowMo } from './playwright-utils.mjs';

const APPLICATION_LIST_URL = 'https://console.osase.net/manage/saas/index/application';
const USER_DATA_DIR = path.resolve(process.env.PLAYWRIGHT_USER_DATA_DIR ?? '.playwright-profile');

const DEFAULT_INPUT = `
公司名称：贵州万三钧润新媒体直播培训有限公司
应用场景：英国10M 家宽ip tiktok直播 主流社媒包
邮箱：15519187121@qq.com
部署方式：CPE设备
`;

const shouldSubmit = process.argv.includes('--submit') || process.env.SUBMIT === 'true';
const shouldDryRunParse = process.argv.includes('--dry-run-parse');
const shouldDebugScreenshot = process.argv.includes('--debug-screenshot');
const shouldCloseWhenDone = process.argv.includes('--close-when-done');
const resultFileArg = getArgValue('--result-file');
const shouldReturnServiceId = shouldRequestServiceId(resultFileArg);
const SECOND_NEXT_DELAY_MS = 5500;
const LOCATION_RETRY_ATTEMPTS = 8;
const LOCATION_RETRY_DELAY_MS = 1000;
const CREATED_ID_RETRY_ATTEMPTS = 18;
const CREATED_ID_RETRY_DELAY_MS = 1500;
const CREATE_RESPONSE_CAPTURE_MS = 10000;
const LIST_RESPONSE_CAPTURE_MS = 2500;
const UI_TRANSITION_RETRY_ATTEMPTS = 3;
const UI_TRANSITION_RETRY_DELAY_MS = 1000;
const UI_TRANSITION_TIMEOUT_MS = 20000;
const CREATE_ACCEPTANCE_TIMEOUT_MS = 20000;

export function shouldRequestServiceId(resultFile) {
  return Boolean(String(resultFile ?? '').trim());
}

async function writeTaskResult(result) {
  if (!resultFileArg) return;

  const resultFile = path.resolve(resultFileArg);
  const temporaryFile = `${resultFile}.${process.pid}.tmp`;
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(temporaryFile, resultFile);
}

const countryLocationCandidates = {
  美国: ['新美国', '美国 PRO', '美国2 PRO', '美国3 PRO', '美国'],
  日本: ['日本 PRO', '日本'],
  香港: ['香港'],
  欧洲: ['欧洲 PRO', '欧洲'],
  英国: ['欧洲 PRO', '欧洲'],
  德国: ['上海 - 法兰克福 Pro', '欧洲 PRO', '德国'],
  新加坡: ['新加坡 PRO', '新加坡'],
  台湾: ['台湾 PRO', '台湾'],
  沙特: ['沙特 PRO', '沙特'],
};

const supportedRegions = Object.keys(countryLocationCandidates);
const supportedRegionPattern = supportedRegions
  .map((region) => region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .sort((a, b) => b.length - a.length)
  .join('|');

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
  for await (const chunk of process.stdin) {
    text += chunk;
  }

  return text;
}

async function readInputText() {
  const companyArg = getArgValue('--company');
  const acceleratorArg = getArgValue('--accelerator');
  if (companyArg || acceleratorArg) {
    return [
      companyArg ? `公司名称：${companyArg}` : '',
      acceleratorArg ? `加速类型：${acceleratorArg}` : '',
    ].filter(Boolean).join('\n');
  }

  const textArg = getArgValue('--text');
  if (textArg) return textArg;

  const fileArg = getArgValue('--file');
  if (fileArg) return readFile(path.resolve(fileArg), 'utf8');

  const stdinText = await readStdinIfAvailable();
  if (stdinText.trim()) return stdinText;

  return DEFAULT_INPUT;
}

function findRegionBeforeKeyword(text, keyword) {
  for (const region of supportedRegions) {
    const pattern = new RegExp(`${region}\\s*${keyword}`, 'i');
    if (pattern.test(text)) return region;
  }

  return null;
}

function parseAccelerator(text) {
  const normalizedText = normalizeLine(text);
  const compactMatch = normalizedText.match(new RegExp(`(${supportedRegionPattern})\\s*(\\d+)\\s*M`, 'i'));
  const bandwidthMatch = normalizedText.match(/(\d+)\s*M/i);
  const explicitExportRegion = findRegionBeforeKeyword(normalizedText, '出口');
  const ipRegion = compactMatch?.[1]
    ?? findRegionBeforeKeyword(normalizedText, 'IP')
    ?? supportedRegions.find((region) => normalizedText.includes(region));

  if (!ipRegion || !bandwidthMatch) {
    throw new Error(`没有识别到加速类型，请使用类似“美国 5M”的格式。当前内容：${text}`);
  }

  return {
    country: explicitExportRegion ?? ipRegion,
    ipRegion,
    exportRegion: explicitExportRegion ?? ipRegion,
    hasExplicitExportRegion: Boolean(explicitExportRegion),
    bandwidth: `${bandwidthMatch[1]}M`,
  };
}

function getPackageName(bandwidth) {
  const value = Number.parseInt(bandwidth, 10);
  if (value >= 200) return `高级版-${bandwidth}`;
  if (value >= 60) return `进阶版-${bandwidth}`;
  return `基础版-${bandwidth}`;
}

function parseInput(text) {
  const { companyName, acceleratorText } = parseCustomerProfile(text);

  if (!companyName) throw new Error('输入里缺少“公司名称”。');
  if (!acceleratorText) throw new Error('输入里缺少“加速类型”，请使用类似“加速类型：美国 5M”。');

  const accelerator = parseAccelerator(acceleratorText);
  const packageName = getPackageName(accelerator.bandwidth);
  const locationCandidates = countryLocationCandidates[accelerator.country] ?? [accelerator.country];

  return {
    companyName,
    acceleratorText,
    country: accelerator.country,
    ipRegion: accelerator.ipRegion,
    exportRegion: accelerator.exportRegion,
    hasExplicitExportRegion: accelerator.hasExplicitExportRegion,
    bandwidth: accelerator.bandwidth,
    packageName,
    locationCandidates,
    appServiceName: 'Basic',
    providerName: '包子科技',
  };
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdLikeValue(value) {
  return /^\d{3,}$/.test(String(value ?? '').trim());
}

function getIdCandidateScore(key, pathParts) {
  const normalizedKey = key.replace(/[-\s]/g, '_').toLowerCase();
  const normalizedPath = pathParts.join('.').replace(/[-\s]/g, '_').toLowerCase();

  if (/^(saas|service|application|app|product)_?id$/.test(normalizedKey)) return 100;
  if (/^(id)$/.test(normalizedKey) && /(saas|service|application|app|product)/.test(normalizedPath)) return 85;
  if (/^(id)$/.test(normalizedKey) && /(data|result|record|item|info)/.test(normalizedPath)) return 65;
  if (/^(id)$/.test(normalizedKey)) return 45;
  return 0;
}

function collectIdCandidates(value, pathParts = []) {
  const candidates = [];

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      candidates.push(...collectIdCandidates(value[index], [...pathParts, String(index)]));
    }
    return candidates;
  }

  if (!isPlainObject(value)) return candidates;

  for (const [key, childValue] of Object.entries(value)) {
    const childPath = [...pathParts, key];
    const score = getIdCandidateScore(key, pathParts);
    if (score > 0 && isIdLikeValue(childValue)) {
      candidates.push({
        id: String(childValue).trim(),
        path: childPath.join('.'),
        score,
      });
    }

    if (childValue && typeof childValue === 'object') {
      candidates.push(...collectIdCandidates(childValue, childPath));
    }
  }

  return candidates;
}

function pickBestIdCandidate(candidates, existingServiceIds = new Set()) {
  const candidatesById = new Map();
  for (const candidate of candidates) {
    if (!candidate?.id || existingServiceIds.has(candidate.id)) continue;
    const previous = candidatesById.get(candidate.id);
    if (!previous || candidate.score > previous.score) candidatesById.set(candidate.id, candidate);
  }

  const uniqueCandidates = [...candidatesById.values()];
  uniqueCandidates.sort((left, right) => right.score - left.score);
  if (uniqueCandidates.length > 1 && uniqueCandidates[0].score === uniqueCandidates[1].score) return null;
  return uniqueCandidates[0] ?? null;
}

function extractServiceIdFromUrl(url, existingServiceIds = new Set()) {
  const match = String(url ?? '').match(/\/manage\/saas\/(\d+)(?:\/|$)/);
  if (!match) return null;

  const id = match[1];
  return existingServiceIds.has(id) ? null : id;
}

function responseLooksLikeJson(response) {
  const contentType = response.headers()['content-type'] ?? '';
  return contentType.includes('application/json') || contentType.includes('text/json') || contentType.includes('+json');
}

function responseUrlLooksRelevant(response, keywords) {
  const url = response.url().toLowerCase();
  return keywords.some((keyword) => url.includes(keyword));
}

async function collectJsonResponses(page, action, { keywords, methods = null, waitMs = 0 }) {
  const records = [];
  const pendingReads = new Set();

  const onResponse = (response) => {
    const request = response.request();
    if (methods && !methods.includes(request.method())) return;
    if (response.status() < 200 || response.status() >= 300) return;
    if (!responseUrlLooksRelevant(response, keywords)) return;
    if (!responseLooksLikeJson(response)) return;

    const readPromise = response.json()
      .then((json) => {
        records.push({
          url: response.url(),
          method: request.method(),
          json,
        });
      })
      .catch(() => null)
      .finally(() => pendingReads.delete(readPromise));

    pendingReads.add(readPromise);
  };

  page.on('response', onResponse);
  try {
    await action();
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await Promise.allSettled([...pendingReads]);
  } finally {
    page.off('response', onResponse);
  }

  return records;
}

async function clickCreateProductAndCaptureId(page, existingServiceIds) {
  const responses = await collectJsonResponses(
    page,
    () => clickCreateProduct(page),
    {
      keywords: ['saas', 'application', 'app', 'product', 'service', 'order', 'create'],
      methods: ['POST', 'PUT', 'PATCH'],
      waitMs: CREATE_RESPONSE_CAPTURE_MS,
    },
  );

  console.log('已点击“创建产品”。');

  const candidates = responses.filter((record) => !responseBodyLooksFailed(record.json)).flatMap((record) => (
    collectIdCandidates(record.json).map((candidate) => ({
      ...candidate,
      url: record.url,
      score: candidate.score + (record.url.includes('saas') ? 15 : 0),
    }))
  ));
  const bestCandidate = pickBestIdCandidate(candidates, existingServiceIds);
  if (bestCandidate && bestCandidate.score >= 80) {
    console.log(`已从创建接口响应识别到候选 ID：${bestCandidate.id}`);
    return bestCandidate.id;
  }
  if (bestCandidate) {
    console.log(`创建接口响应里只有低置信度候选 ID：${bestCandidate.id}，继续通过页面地址或列表接口确认。`);
  }

  const urlId = extractServiceIdFromUrl(page.url(), existingServiceIds);
  if (urlId) {
    console.log(`已从创建后的页面地址识别到 ID：${urlId}`);
    return urlId;
  }

  return null;
}

export function collectObjectsWithIds(value, pathParts = []) {
  const records = [];

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      records.push(...collectObjectsWithIds(value[index], [...pathParts, String(index)]));
    }
    return records;
  }

  if (!isPlainObject(value)) return records;

  // A service ID belongs to its own record, never to a containing response/list.
  const directCandidates = Object.entries(value).flatMap(([key, childValue]) => {
    const score = getIdCandidateScore(key, pathParts);
    return score > 0 && isIdLikeValue(childValue)
      ? [{ id: String(childValue).trim(), score }]
      : [];
  });
  const bestId = pickBestIdCandidate(directCandidates);
  if (bestId) {
    records.push({
      id: bestId.id,
      path: pathParts.join('.'),
      text: normalizeText(JSON.stringify(value)),
    });
    // Nested package/provider IDs are references within this service, not services.
    return records;
  }

  for (const [key, childValue] of Object.entries(value)) {
    if (childValue && typeof childValue === 'object') {
      records.push(...collectObjectsWithIds(childValue, [...pathParts, key]));
    }
  }

  return records;
}

function serviceRecordMatchesOptions(record, options) {
  const bandwidth = String(options.bandwidth ?? '').match(/^(\d+)M$/i)?.[1];
  if (!bandwidth) return false;
  return new RegExp(`(?:^|[^\\d.])${bandwidth}\\s*M(?:bps)?(?=$|[^A-Za-z0-9])`, 'i').test(record.text);
}

export function pickCreatedServiceFromRecords(records, options, existingServiceIds = new Set()) {
  const matchingIds = new Set();
  for (const record of records) {
    if (!record?.id || existingServiceIds.has(record.id)) continue;
    if (serviceRecordMatchesOptions(record, options)) matchingIds.add(record.id);
  }

  return matchingIds.size === 1 ? [...matchingIds][0] : null;
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

async function waitForVisible(locator, timeout = UI_TRANSITION_TIMEOUT_MS) {
  await locator.first().waitFor({ state: 'visible', timeout });
  return locator.first();
}

async function clickVisible(locator, description, timeout = UI_TRANSITION_TIMEOUT_MS) {
  const target = await waitForVisible(locator, timeout);
  await target.scrollIntoViewIfNeeded();
  await target.waitFor({ state: 'attached', timeout });
  await target.click({ timeout }).catch((error) => {
    throw new Error(`${description}点击失败：${error.message}`);
  });
}

async function runUiTransition(page, label, action, readyLocator) {
  let lastError = null;

  for (let attempt = 1; attempt <= UI_TRANSITION_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && await readyLocator().first().isVisible().catch(() => false)) {
      console.log(`${label}已生效，继续后续步骤。`);
      return;
    }

    try {
      await action();
      await waitForVisible(readyLocator());
      return;
    } catch (error) {
      lastError = error;
      if (page.isClosed() || attempt === UI_TRANSITION_RETRY_ATTEMPTS) break;

      console.warn(`${label}未完成：${error.message}`);
      console.warn(`等待 ${UI_TRANSITION_RETRY_DELAY_MS / 1000} 秒后重试（${attempt}/${UI_TRANSITION_RETRY_ATTEMPTS}）。`);
      await page.waitForTimeout(UI_TRANSITION_RETRY_DELAY_MS);
    }
  }

  throw new Error(`${label}失败，已重试 ${UI_TRANSITION_RETRY_ATTEMPTS} 次：${lastError?.message ?? '未知错误'}`);
}

async function waitForRefresh(page, milliseconds = 2000) {
  await page.waitForTimeout(milliseconds);
}

function isApplicationListUrl(url) {
  try {
    return new URL(url).pathname === '/manage/saas/index/application';
  } catch {
    return false;
  }
}

async function openApplicationList(page) {
  if (isApplicationListUrl(page.url())) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null);
  } else {
    await page.goto(APPLICATION_LIST_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
  }

  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
  await waitForRefresh(page, 700);
}

export async function collectNetworkAccelerationServices(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    }

    function normalizeText(value) {
      return String(value ?? '').replace(/\s+/g, ' ').trim();
    }

    function findServiceCard(element, id) {
      const cardIds = (text) => [...new Set([...text.matchAll(/\bID\s*[:：]\s*(\d+)\b/gi)].map((match) => match[1]))];
      // The stats wrapper also has card-like dimensions, but does not contain
      // the title or pending status. Prefer the actual deployed service card.
      const card = element.closest('.manage-shell__saas-service-card-action--interactive, .manage-shell__overview-card, .el-card, .ant-card');
      if (card && isVisible(card)) {
        const ids = cardIds(normalizeText(card.innerText || card.textContent));
        if (ids.length === 1 && ids[0] === id) return card;
      }

      for (let current = element; current && current !== document.body; current = current.parentElement) {
        if (!isVisible(current)) continue;

        const text = normalizeText(current.innerText || current.textContent);
        const ids = cardIds(text);
        // Never associate one ID with a container holding multiple service cards.
        if (ids.length > 1) break;
        if (ids[0] !== id) continue;

        const rect = current.getBoundingClientRect();
        const className = String(current.className ?? '');
        const looksLikeCard = /card|item|service|product|application|saas|panel|box/i.test(className)
          || (rect.width >= 180 && rect.width <= 520 && rect.height >= 90 && rect.height <= 300);

        if (!looksLikeCard) continue;
        // For older layouts require both the header status and the bandwidth.
        // Do not stop at an inner stats panel merely because it contains an ID.
        if (text.includes('产品带宽') && /待开通|已启动|已停用|已停止|已过期/.test(text)) return current;
      }

      return null;
    }

    const servicesById = new Map();
    const idElements = [...document.querySelectorAll('body *')]
      .filter((element) => isVisible(element) && /\bID\s*[:：]\s*\d+\b/i.test(element.textContent ?? '')
        && ![...element.children].some((child) => /\bID\s*[:：]\s*\d+\b/i.test(child.textContent ?? '')));

    for (const element of idElements) {
      const idMatch = normalizeText(element.textContent).match(/\bID\s*[:：]\s*(\d+)\b/i);
      if (!idMatch) continue;

      const id = idMatch[1];
      const card = findServiceCard(element, id);
      if (!card) continue;

      const text = normalizeText(card.innerText || card.textContent);
      if (!text || servicesById.has(id)) continue;

      servicesById.set(id, {
        id,
        text,
        status: text.includes('待开通') ? '待开通' : (text.includes('已启动') ? '已启动' : ''),
      });
    }

    return [...servicesById.values()];
  });
}

function createdServiceRejectionReasons(service, options, existingServiceIds, expectedId = null) {
  const reasons = [];
  if (!service?.id) return ['缺少 ID'];
  if (existingServiceIds.has(service.id)) reasons.push('创建前已存在');
  if (expectedId && service.id !== expectedId) reasons.push('与创建响应 ID 不符');
  if (service.status !== '待开通') reasons.push(`状态${service.status || '未识别'}`);
  if (!serviceRecordMatchesOptions(service, options)) reasons.push(`带宽不符（需要 ${options.bandwidth}）`);
  const compact = (text) => normalizeText(text).replace(/\s+/g, '').toLowerCase();
  if (options.selectedLocation && !compact(service.text).includes(compact(options.selectedLocation))) {
    reasons.push(`位置不符（需要 ${options.selectedLocation}）`);
  }
  return reasons;
}

export function describeCreatedServiceCandidates(services, options, existingServiceIds, expectedId = null) {
  if (!services.length) return '尚未读取到完整服务卡片，正在等待列表加载。';
  return `已读取 ${services.length} 张服务卡片：${services.map((service) => {
    const reasons = createdServiceRejectionReasons(service, options, existingServiceIds, expectedId);
    return `${service.id}（${reasons.join('；') || '符合本次创建条件'}）`;
  }).join('、')}。`;
}

export function pickCreatedServiceFromCards(services, options, existingServiceIds = new Set(), expectedId = null) {
  const matchingIds = [...new Set(services
    .filter((service) => createdServiceRejectionReasons(service, options, existingServiceIds, expectedId).length === 0)
    .map((service) => service.id))];
  if (expectedId) return matchingIds.includes(expectedId) ? expectedId : null;
  if (matchingIds.length > 1) {
    throw new Error(`发现多个新建且匹配的待开通服务（${matchingIds.join('、')}），无法确定本次服务 ID，已停止后续步骤。`);
  }
  return matchingIds[0] ?? null;
}

async function snapshotExistingServiceIds(page) {
  const responses = await collectJsonResponses(
    page,
    () => openApplicationList(page),
    {
      keywords: ['saas', 'application', 'app', 'product', 'service'],
      methods: ['GET', 'POST'],
      waitMs: LIST_RESPONSE_CAPTURE_MS,
    },
  );
  const apiRecords = responses.flatMap((record) => collectObjectsWithIds(record.json));
  const services = await collectNetworkAccelerationServices(page);
  return new Set([
    ...apiRecords.map((record) => record.id),
    ...services.map((service) => service.id),
  ]);
}

export async function waitForCreatedServiceId(page, options, existingServiceIds, expectedId = null, {
  collectServices = collectNetworkAccelerationServices,
  openList = openApplicationList,
  attempts = CREATED_ID_RETRY_ATTEMPTS,
  retryDelayMs = CREATED_ID_RETRY_DELAY_MS,
  refreshEvery = 4,
  log = console.log,
} = {}) {
  log(`正在核对本次新建的待开通服务：${options.bandwidth} / ${options.selectedLocation || options.country || '未指定位置'}${expectedId ? ` / 创建响应 ID ${expectedId}` : ''}。`);
  let lastDiagnostic = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Inspect cards already rendered after purchase before navigating away.
    // Poll the current DOM so delayed rendering isn't reset by every retry.
    if (!isApplicationListUrl(page.url()) || (attempt > 1 && (attempt - 1) % refreshEvery === 0)) {
      await openList(page);
    }
    const services = await collectServices(page);
    const serviceId = pickCreatedServiceFromCards(services, options, existingServiceIds, expectedId);
    if (serviceId) {
      log(`已从完整服务卡片确认待开通 ID：${serviceId}`);
      return serviceId;
    }

    const diagnostic = describeCreatedServiceCandidates(services, options, existingServiceIds, expectedId);
    if (diagnostic !== lastDiagnostic) {
      log(diagnostic);
      lastDiagnostic = diagnostic;
    }

    if (attempt < attempts) {
      log(`暂未匹配到待开通 ID，等待 ${retryDelayMs / 1000} 秒后重试（${attempt}/${attempts}）。`);
      await page.waitForTimeout(retryDelayMs);
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-network-acceleration-created-id.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存待开通 ID 调试截图：${screenshotPath}`);
  }

  throw new Error(`创建后未能确认本次待开通网络加速 ID。${lastDiagnostic}产品可能已经创建，请核对后仅补加规则，不要重复运行创建流程。`);
}

async function clickAddNetworkAcceleration(page) {
  await page.waitForLoadState('networkidle').catch(() => null);

  const buyTaskButton = await firstVisible(page.getByRole('button', { name: '购买网络加速服务' })).catch(() => null);
  if (buyTaskButton) {
    await clickVisible(buyTaskButton, '“购买网络加速服务”按钮');
    return;
  }

  const buyTextButton = await firstVisible(page.locator('text=购买网络加速服务')).catch(() => null);
  if (buyTextButton) {
    await clickVisible(buyTextButton, '“购买网络加速服务”入口');
    return;
  }

  const addButtonAfterNetwork = page.locator(
    'xpath=//*[normalize-space(.)="网络加速"]/following::button[contains(@class, "manage-shell__overview-card-add")][1]',
  );
  const addButton = await firstVisible(addButtonAfterNetwork).catch(() => null);
  if (addButton) {
    await clickVisible(addButton, '网络加速添加按钮');
    return;
  }

  const plusImageAfterNetwork = page.locator(
    'xpath=//*[normalize-space(.)="网络加速"]/following::img[@alt="plus" or contains(@src, "plus.svg")][1]',
  );
  const plusImage = await firstVisible(plusImageAfterNetwork).catch(() => null);
  if (plusImage) {
    await clickVisible(plusImage, '网络加速添加图标');
    return;
  }

  const networkCard = page.locator(
    'xpath=//*[normalize-space(.)="网络加速"]/ancestor::*[contains(@class, "card") or contains(@class, "panel") or contains(@class, "box") or contains(@class, "item")][1]',
  ).first();

  const scopedPlusButtons = [
    networkCard.locator('button.manage-shell__overview-card-add').first(),
    networkCard.locator('xpath=.//img[@alt="plus" or contains(@src, "plus.svg")]').first(),
    networkCard.locator('xpath=.//*[name()="svg" and .//*[local-name()="path"]]').first(),
    networkCard.locator('xpath=.//*[self::button or @role="button"][not(contains(normalize-space(.), "查看全部"))]').first(),
  ];

  for (const locator of scopedPlusButtons) {
    const button = await firstVisible(locator).catch(() => null);
    if (!button) continue;

    await clickVisible(button, '网络加速卡片添加按钮');
    return;
  }

  const cardBox = await networkCard.boundingBox().catch(() => null);
  if (cardBox) {
    await page.mouse.click(cardBox.x + cardBox.width - 110, cardBox.y + 32);
    return;
  }

  throw new Error('没有找到“购买网络加速服务”按钮或“网络加速”卡片上的添加按钮。');
}

async function selectAccelerationServiceType(page) {
  await page.getByText('选择加速服务类型').waitFor({ timeout: 60000 });

  const liveCommerceText = page.getByText('直播与电商', { exact: true }).first();
  await liveCommerceText.waitFor({ timeout: 30000 });
  await liveCommerceText.scrollIntoViewIfNeeded();

  const literal = xpathLiteral('直播与电商');
  const card = page.locator(`xpath=//*[normalize-space(.)=${literal}]/ancestor::*[contains(@class, "card") or contains(@class, "item") or contains(@class, "option")][1]`).first();
  if (await card.isVisible().catch(() => false)) {
    await clickVisible(card, '“直播与电商”卡片');
  } else {
    await clickVisible(liveCommerceText, '“直播与电商”选项');
  }

}

async function clickTextCard(page, text, timeout = 60000) {
  const exactText = page.getByText(text, { exact: true }).first();
  await exactText.waitFor({ timeout });
  await exactText.scrollIntoViewIfNeeded();

  const literal = xpathLiteral(text);
  const card = page.locator(`xpath=//*[normalize-space(.)=${literal}]/ancestor::*[contains(@class, "card") or contains(@class, "item") or contains(@class, "option") or contains(@class, "package")][1]`).first();
  if (await card.isVisible().catch(() => false)) {
    await clickVisible(card, `“${text}”选项`, timeout);
  } else {
    await clickVisible(exactText, `“${text}”文本`, timeout);
  }

}

async function selectProvider(page, providerName) {
  await page.getByRole('heading', { name: '选择服务提供商' }).waitFor({ timeout: 60000 });

  const dropdowns = [
    page.getByPlaceholder('请选择服务提供商'),
    page.getByText('请选择服务提供商', { exact: true }),
    page.locator('input').first(),
  ];

  for (const locator of dropdowns) {
    const dropdown = await firstVisible(locator).catch(() => null);
    if (!dropdown) continue;

    await clickVisible(dropdown, '服务提供商下拉框');
    await clickTextCard(page, providerName);
    return;
  }

  throw new Error('没有找到服务提供商下拉框。');
}

async function selectLocation(page, candidates) {
  await page.getByText('请选择服务位置', { exact: true }).first().waitFor({ timeout: 60000 });

  for (let attempt = 1; attempt <= LOCATION_RETRY_ATTEMPTS; attempt += 1) {
    for (const locationName of candidates) {
      const exactLocation = await firstVisible(page.getByText(locationName, { exact: true })).catch(() => null);
      if (exactLocation) {
        await clickTextCard(page, locationName);
        return locationName;
      }

      const fuzzyLocation = await firstVisible(page.getByText(locationName)).catch(() => null);
      if (fuzzyLocation) {
        await fuzzyLocation.scrollIntoViewIfNeeded();
        await clickVisible(fuzzyLocation, `服务位置“${locationName}”`);
        return locationName;
      }
    }

    if (attempt < LOCATION_RETRY_ATTEMPTS) {
      console.log(`还没有看到服务位置，等待 ${LOCATION_RETRY_DELAY_MS / 1000} 秒后重试：${candidates.join('、')}`);
      await page.waitForTimeout(LOCATION_RETRY_DELAY_MS);
    }
  }

  if (shouldDebugScreenshot) {
    const screenshotPath = path.resolve('debug-network-acceleration-location.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`已保存服务位置调试截图：${screenshotPath}`);
  }

  throw new Error(`没有找到服务位置，可尝试位置：${candidates.join('、')}`);
}

async function clickNext(page) {
  const buttons = page.getByRole('button', { name: '下一步' });
  const count = await buttons.count();

  for (let index = count - 1; index >= 0; index -= 1) {
    const button = buttons.nth(index);
    if (await button.isVisible().catch(() => false)) {
      await clickVisible(button, '“下一步”按钮');
      return;
    }
  }

  throw new Error('没有找到“下一步”按钮。');
}

async function checkAgreementBoxes(page) {
  await page.getByText('付款方式').waitFor({ timeout: 60000 });

  const agreementList = page.locator('#outerPanel > section > section > div.account-panel__agreement-list');
  await agreementList.waitFor({ timeout: 60000 });

  for (const checkboxId of ['x608', 'x609', 'x610']) {
    const checkbox = page.locator(`xpath=//*[@id="${checkboxId}"]`);
    if (!(await checkbox.count())) continue;
    if (await checkbox.isChecked().catch(() => false)) continue;

    await checkbox.click({ force: true });
    await page.waitForTimeout(200);
  }

  const allAgreementCheckboxes = agreementList.locator('input[type="checkbox"]');
  const allAgreementCheckboxCount = await allAgreementCheckboxes.count();
  for (let index = 0; index < allAgreementCheckboxCount; index += 1) {
    const checkbox = allAgreementCheckboxes.nth(index);
    await checkbox.waitFor({ timeout: 10000 });

    if (await checkbox.isChecked().catch(() => false)) continue;

    await checkbox.click({ force: true });
    await page.waitForTimeout(200);

    if (await checkbox.isChecked().catch(() => false)) continue;

    const checkboxId = await checkbox.getAttribute('id');
    if (checkboxId) {
      await agreementList.locator(`label[for="${checkboxId}"]`).click({ force: true }).catch(() => null);
      await page.waitForTimeout(200);
    }
  }

  await agreementList.evaluate((list) => {
    const labels = [...list.querySelectorAll('label')]
      .filter((label) => label.textContent?.includes('点击勾选'));

    for (const label of labels) {
      const htmlForInput = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const previousInput = label.previousElementSibling?.matches?.('input[type="checkbox"]')
        ? label.previousElementSibling
        : null;
      const parentInput = label.parentElement?.querySelector('input[type="checkbox"]');
      const rowInput = label.closest('div, label, p, li')?.querySelector('input[type="checkbox"]');
      const input = htmlForInput ?? previousInput ?? parentInput ?? rowInput;

      if (!(input instanceof HTMLInputElement) || input.checked) continue;

      input.click();
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  });

  const checkboxes = agreementList.locator('input[type="checkbox"].tw-w-4.tw-h-4');
  const checkboxCount = await checkboxes.count();
  for (let index = 0; index < checkboxCount; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (await checkbox.isChecked().catch(() => false)) continue;

    const box = await checkbox.boundingBox();
    if (!box) continue;

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
  }

  const agreementTexts = agreementList.getByText(/点击勾选即代表/);
  const agreementCount = await agreementTexts.count();
  for (let index = 0; index < agreementCount; index += 1) {
    const text = agreementTexts.nth(index);
    const box = await text.boundingBox();
    if (!box) continue;

    await page.mouse.click(110, box.y + box.height / 2);
  }

  const uncheckedCount = await agreementList
    .locator('input[type="checkbox"]')
    .evaluateAll((inputs) => inputs.filter((input) => !input.checked).length)
    .catch(() => 0);

  if (uncheckedCount > 0) {
    if (shouldDebugScreenshot) {
      const screenshotPath = path.resolve('debug-network-acceleration-agreements.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`已保存协议勾选调试截图：${screenshotPath}`);
    }

    throw new Error(`还有 ${uncheckedCount} 个协议复选框没有勾选成功。`);
  }
}

async function clickCreateProduct(page) {
  const button = await firstVisible(page.getByRole('button', { name: '创建产品' })).catch(() => null);
  if (!button) throw new Error('没有找到“创建产品”按钮。');

  await button.scrollIntoViewIfNeeded();
  // 提交只点击一次，避免在网络较慢时创建重复产品。
  await button.click({ timeout: UI_TRANSITION_TIMEOUT_MS }).catch((error) => {
    throw new Error(`“创建产品”按钮点击失败，请检查协议是否全部勾选：${error.message}`);
  });
}

function isRelevantCreateResponse(response) {
  const request = response.request();
  return ['POST', 'PUT', 'PATCH'].includes(request.method())
    && response.status() >= 200
    && response.status() < 300
    && responseUrlLooksRelevant(response, ['saas', 'application', 'app', 'product', 'service', 'order', 'create']);
}

export function responseBodyLooksFailed(value) {
  if (!isPlainObject(value)) return false;
  if (value.success === false || value.ok === false) return true;
  if (String(value.status ?? '').toLowerCase() === 'failed') return true;

  if (Object.hasOwn(value, 'code')) {
    const code = String(value.code).toLowerCase();
    if (!['0', '200', 'success', 'ok'].includes(code)) return true;
  }

  return false;
}

async function confirmCreateResponse(response) {
  if (!responseLooksLikeJson(response)) return 'interface';

  const body = await response.json().catch(() => null);
  if (responseBodyLooksFailed(body)) {
    throw new Error(`创建接口返回失败：${normalizeText(body?.message ?? body?.msg ?? body?.error ?? '未知原因')}`);
  }

  return 'interface';
}

async function clickCreateProductAndWaitForAcceptance(page) {
  const acceptedResponse = page.waitForResponse(isRelevantCreateResponse, {
    timeout: CREATE_ACCEPTANCE_TIMEOUT_MS,
  }).then(confirmCreateResponse);
  const acceptedPageState = page.waitForFunction(() => {
    const bodyText = document.body?.innerText ?? '';
    const createButtons = [...document.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === '创建产品');
    const hasVisibleCreateButton = createButtons.some((button) => {
      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });

    return /创建成功|购买成功|提交成功/.test(bodyText)
      || (!hasVisibleCreateButton && /\/manage\/saas(?:\/|$)/.test(location.pathname));
  }, null, { timeout: CREATE_ACCEPTANCE_TIMEOUT_MS }).then(() => 'page');

  const acceptance = Promise.any([acceptedResponse, acceptedPageState]);
  try {
    await clickCreateProduct(page);
  } catch (error) {
    acceptance.catch(() => null);
    throw error;
  }

  let acceptedBy;
  try {
    acceptedBy = await acceptance;
  } catch {
    throw new Error('已点击“创建产品”，但在 20 秒内未收到平台的成功响应。为避免重复创建，本次不会自动再次点击。');
  }

  console.log(`平台已接受创建请求（通过${acceptedBy === 'interface' ? '接口响应' : '页面状态'}确认）。`);
}

async function main() {
  await writeTaskResult({ status: 'pending' });

  const inputText = await readInputText();
  const options = parseInput(inputText);

  console.log('本次创建网络加速参数：');
  console.log(`公司名称：${options.companyName}`);
  console.log(`供应商：${options.providerName}`);
  console.log(`加速类型：${options.exportRegion} ${options.bandwidth}`);
  console.log(`出口地区：${options.exportRegion}${options.hasExplicitExportRegion ? '（应用场景已明确指定出口）' : '（按加速类型自动判断）'}`);
  console.log(`IP地区：${options.ipRegion}`);
  console.log(`套餐：${options.packageName}`);
  console.log(`服务位置候选：${options.locationCandidates.join('、')}`);
  console.log(`应用加速：${options.appServiceName}`);

  if (shouldDryRunParse) return;

  const context = await launchChrome();
  try {
    let adminLoginState = null;
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const enteredBackend = await enterCompanyBackend(context, page, options.companyName, { userDataDir: USER_DATA_DIR });
      const userPage = enteredBackend.userPage;
      adminLoginState = enteredBackend.adminLoginState;
      const existingServiceIds = shouldReturnServiceId
        ? await snapshotExistingServiceIds(userPage)
        : new Set();

      await runUiTransition(
        userPage,
        '打开网络加速购买页',
        () => clickAddNetworkAcceleration(userPage),
        () => userPage.getByText('选择加速服务类型'),
      );
      await runUiTransition(
        userPage,
        '选择“直播与电商”',
        () => selectAccelerationServiceType(userPage),
        () => userPage.getByRole('heading', { name: '选择服务提供商' }),
      );
      await runUiTransition(
        userPage,
        `选择服务提供商“${options.providerName}”`,
        () => selectProvider(userPage, options.providerName),
        () => userPage.getByText(options.packageName, { exact: true }),
      );
      await waitForRefresh(userPage, 1000);
      await runUiTransition(
        userPage,
        `选择套餐“${options.packageName}”`,
        () => clickTextCard(userPage, options.packageName),
        () => userPage.getByText('请选择服务位置', { exact: true }),
      );
      await waitForRefresh(userPage, 2000);
      let selectedLocation = options.locationCandidates[0];
      await runUiTransition(
        userPage,
        `选择服务位置（${options.locationCandidates.join('、')}）`,
        async () => {
          selectedLocation = await selectLocation(userPage, options.locationCandidates);
        },
        () => userPage.getByText(options.appServiceName, { exact: true }),
      );
      await waitForRefresh(userPage, 1000);
      await runUiTransition(
        userPage,
        `选择应用加速“${options.appServiceName}”`,
        () => clickTextCard(userPage, options.appServiceName),
        () => userPage.getByRole('button', { name: '下一步' }),
      );
      await clickNext(userPage);
      console.log(`已点击第一个“下一步”，等待 ${SECOND_NEXT_DELAY_MS / 1000} 秒后再点击第二个“下一步”。`);
      await waitForRefresh(userPage, SECOND_NEXT_DELAY_MS);
      await clickNext(userPage);
      await checkAgreementBoxes(userPage);

      if (shouldSubmit) {
        if (shouldReturnServiceId) {
          const candidateId = await clickCreateProductAndCaptureId(userPage, existingServiceIds);
          const createdServiceId = await waitForCreatedServiceId(
            userPage, { ...options, selectedLocation }, existingServiceIds, candidateId,
          );
          await writeTaskResult({
            status: 'success',
            serviceId: String(createdServiceId),
            companyName: options.companyName,
          });
          console.log(`待开通网络加速 ID：${createdServiceId}`);
        } else {
          await clickCreateProductAndWaitForAcceptance(userPage);
          console.log('网络加速已创建成功，独立流程不再扫描或等待 ID。');
        }
      } else {
        console.log(`已完成选择：${options.packageName} / ${selectedLocation} / ${options.appServiceName}`);
        console.log('当前为测试模式，已停在最后确认页，未点击“创建产品”。');
        console.log('确认无误后可运行：npm run network:acceleration -- --file examples/customer.txt --submit');
      }
    } finally {
      if (adminLoginState) {
        try {
          const restored = await restoreAuthState(context, adminLoginState);
          if (restored) console.log('已恢复管理员登录态，下一次网络加速会继续使用该登录状态。');
          else console.warn('当前浏览器上下文不支持恢复管理员登录态。');
        } catch (error) {
          console.warn(`恢复管理员登录态失败：${error.message}`);
        }
      }
    }

    if (shouldCloseWhenDone) {
      await context.close();
      console.log('网络加速步骤已完成，浏览器已关闭。');
    } else {
      console.log('浏览器将保持打开；任务会等待你手动关闭浏览器后再结束。');
      await new Promise((resolve) => context.once('close', resolve));
      console.log('已检测到浏览器关闭，网络加速步骤结束。');
    }
  } catch (error) {
    if (shouldCloseWhenDone) await context.close().catch(() => null);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    await writeTaskResult({ status: 'failed', error: error.message }).catch(() => null);
    console.error(error);
    process.exitCode = 1;
  });
}
