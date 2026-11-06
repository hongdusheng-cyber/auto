import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAuthState } from './auth-state.mjs';
import { createJobRunner } from './job-runner.mjs';
import { LogBuffer, createEventHub } from './control-panel-events.mjs';
import { normalizeContractId, parseProxyValue, renderMagicConfig } from './magic-config.mjs';
import { parseCustomerProfile } from './customer-profile.mjs';
import { normalizeAccountOptions } from './add-account.mjs';
import { createAccountOutputParser, normalizeAccountResult } from './account-results.mjs';
import {
  buildContractProcess,
  buildRulesProcess,
  buildSingleProfileProvisioningWorkflow,
  readSuccessfulNetworkResult,
} from './network-provisioning.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT ?? 17321);
const HOST = process.env.CONTROL_PANEL_HOST ?? '127.0.0.1';
const nodeCommand = process.execPath;
const CONTROL_PANEL_DIR = path.join(ROOT_DIR, '.control-panel');
const BASE_USER_DATA_DIR = path.join(ROOT_DIR, '.playwright-profile');
const PROFILE_POOL_DIR = path.join(ROOT_DIR, '.playwright-profiles');
const AUTH_STATE_FILE = path.join(ROOT_DIR, '.playwright-auth-state.json');
const shouldAutoOpenBrowser = process.env.AUTO_OPEN !== 'false';

const logs = new LogBuffer();
const events = createEventHub();
const configuredMaxJobs = Number(process.env.CONTROL_PANEL_MAX_JOBS ?? 8);
if (!Number.isInteger(configuredMaxJobs) || configuredMaxJobs < 1) {
  throw new Error('CONTROL_PANEL_MAX_JOBS 必须是大于 0 的整数。');
}
let shuttingDown = false;
const runner = createJobRunner({
  rootDir: ROOT_DIR,
  profilePoolDir: PROFILE_POOL_DIR,
  prepareProfile: prepareUserDataDir,
  prepareCommand: async (command) => {
    if (!command.resultFile) return;
    await mkdir(path.dirname(command.resultFile), { recursive: true });
    await writeFile(command.resultFile, `${JSON.stringify({ status: 'pending' })}\n`, { encoding: 'utf8', mode: 0o600 });
  },
  environment: (slot) => ({
    PLAYWRIGHT_USER_DATA_DIR: slot.userDataDir,
    PLAYWRIGHT_AUTH_STATE_FILE: process.env.PLAYWRIGHT_AUTH_STATE_FILE ?? AUTH_STATE_FILE,
  }),
  writeLog,
  handleOutput: handleJobOutput,
  sendStatus,
  maxJobs: configuredMaxJobs,
});
const { jobs } = runner;
let latestMagicConfig = null;
let latestNetworkAccelerationServiceId = null;
let latestUserCredentials = null;
const accountResults = new Map();

function sendEvent(data) {
  events.send(data);
}

function writeLog(message) {
  const line = String(message);
  logs.push(line);
  sendEvent({ type: 'log', message: line });
  process.stdout.write(line);
}

function getStatus() {
  const runningJobs = [...jobs.values()].map((job) => ({
    id: job.id,
    number: job.number,
    task: job.task,
    profileName: job.profileName,
    userDataDir: job.userDataDir,
  }));
  return {
    running: runningJobs.length > 0,
    task: runningJobs.length === 1 ? runningJobs[0].task : null,
    jobs: runningJobs,
  };
}

function sendStatus() {
  sendEvent({ type: 'status', ...getStatus() });
}

function jsonResponse(res, status, data) {
  res.req?.resume();
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(status === 413 ? { Connection: 'close' } : {}),
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      const error = new Error('请求内容超过 1 MB，请减少客户资料长度。');
      error.statusCode = 413;
      req.resume();
      throw error;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    const error = new Error('请求内容不是有效的 JSON。');
    error.statusCode = 400;
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('请求内容必须是 JSON 对象。');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

async function writeCustomerText(text, runToken) {
  await mkdir(CONTROL_PANEL_DIR, { recursive: true });
  const customerTextFile = path.join(CONTROL_PANEL_DIR, `customer-${runToken}.txt`);
  await writeFile(customerTextFile, text ?? '', { encoding: 'utf8', mode: 0o600 });
  return customerTextFile;
}

async function buildMagicConfigText(ip) {
  const proxy = parseProxyValue(ip);
  const template = await readFile(path.join(ROOT_DIR, 'examples', '模板.txt'), 'utf8');
  return renderMagicConfig(template, proxy);
}

async function prepareMagicConfigForCopy(contractId, ip) {
  if (!ip) {
    latestMagicConfig = null;
    sendEvent({ type: 'magic-config', config: '', contractPath: '', latestPath: '' });
    return null;
  }

  await mkdir(CONTROL_PANEL_DIR, { recursive: true });

  const config = await buildMagicConfigText(ip);
  const contractPath = path.join(CONTROL_PANEL_DIR, `magic-config-${normalizeContractId(contractId)}.txt`);
  const latestPath = path.join(CONTROL_PANEL_DIR, 'magic-config-latest.txt');
  await writeFile(contractPath, config, { encoding: 'utf8', mode: 0o600 });
  await writeFile(latestPath, config, { encoding: 'utf8', mode: 0o600 });

  latestMagicConfig = { config, contractPath, latestPath };
  sendEvent({ type: 'magic-config', config, contractPath, latestPath });
  writeLog(`已在网页生成 Magic 兜底配置，可直接复制；文件：${contractPath}\n`);

  return latestMagicConfig;
}

async function prepareLatestMagicConfig(ip) {
  if (!String(ip ?? '').trim()) throw new Error('请填写 IP 参数。');

  await mkdir(CONTROL_PANEL_DIR, { recursive: true });

  const config = await buildMagicConfigText(ip);
  const latestPath = path.join(CONTROL_PANEL_DIR, 'magic-config-latest.txt');
  await writeFile(latestPath, config, { encoding: 'utf8', mode: 0o600 });

  latestMagicConfig = { config, contractPath: '', latestPath };
  sendEvent({ type: 'magic-config', ...latestMagicConfig });
  writeLog(`已根据 IP 参数直接生成 Magic 配置；最新副本：${latestPath}\n`);

  return latestMagicConfig;
}

function normalizeRuleNames(ruleNames) {
  if (Array.isArray(ruleNames)) {
    return [...new Set(ruleNames.map((name) => String(name).trim()).filter(Boolean))];
  }

  return [...new Set(String(ruleNames ?? '')
    .split(/[,，\n]/)
    .map((name) => name.trim())
    .filter(Boolean))];
}

export async function buildCommand({
  task,
  customerText,
  contractId,
  ip,
  sdwanCompanyName,
  deviceName,
  deviceMac,
  upgradeDeviceMac,
  addRuleServiceId,
  addRuleCompanyName,
  completeRulesCompanyName,
  ruleNames,
  password,
  accountCompanyName,
  accountFullName,
  accountEmail,
  submit,
}, runToken) {
  if (['add-user', 'network-acceleration', 'network-rules', 'network-contract', 'network-contract-rules'].includes(task)
    && (typeof customerText !== 'string' || !customerText.trim())) {
    throw new Error('请填写客户资料。');
  }
  if (task === 'add-user') {
    const inputFile = await writeCustomerText(customerText, runToken);
    const args = [path.join(ROOT_DIR, 'scripts', 'add-user.mjs'), '--file', inputFile, '--submit'];
    if (typeof password === 'string' && password.trim()) args.push('--password', password.trim());
    return { label: '添加用户', executable: nodeCommand, args };
  }

  if (task === 'add-account') {
    const accountOptions = normalizeAccountOptions({ companyName: accountCompanyName, fullName: accountFullName, email: accountEmail });
    const args = [path.join(ROOT_DIR, 'scripts', 'add-account.mjs'),
      '--company', accountOptions.companyName, '--name', accountOptions.fullName,
      '--email', accountOptions.email, '--submit'];
    return { label: '添加账号', executable: nodeCommand, args, accountOptions };
  }

  if (task === 'network-acceleration') {
    const inputFile = await writeCustomerText(customerText, runToken);
    const args = [path.join(ROOT_DIR, 'scripts', 'network-acceleration.mjs'), '--file', inputFile];
    if (submit !== false) args.push('--submit');
    return { label: '网络加速', executable: nodeCommand, args };
  }

  if (['network-rules', 'network-contract', 'network-contract-rules'].includes(task)) {
    const shouldOpenContract = task !== 'network-rules';
    if (shouldOpenContract) {
      if (!ip) throw new Error('请填写 IP 参数。');
      parseProxyValue(ip);
    }
    if (submit === false) throw new Error('组合流程需要提交网络加速，不能使用测试模式。');

    const shouldAddRules = task !== 'network-contract';
    const customerCompanyName = parseCustomerProfile(customerText).companyName;
    if (shouldAddRules && !customerCompanyName) throw new Error('客户资料里缺少公司名称，无法进入公司用户后台添加规则。');
    const rules = shouldAddRules ? normalizeRuleNames(ruleNames) : [];
    if (shouldAddRules && rules.length === 0) throw new Error('请至少选择一个规则按钮。');

    const inputFile = await writeCustomerText(customerText, runToken);
    const resultFile = path.join(CONTROL_PANEL_DIR, `network-result-${runToken}.json`);
    const networkArgs = [path.join(ROOT_DIR, 'scripts', 'network-acceleration.mjs'), '--file', inputFile];
    if (submit !== false) networkArgs.push('--submit');
    networkArgs.push('--result-file', resultFile);
    networkArgs.push('--close-when-done');

    const networkStep = {
      label: '网络加速',
      executable: nodeCommand,
      args: networkArgs,
      profileIndex: 0,
      after: async (job) => {
        const result = await readSuccessfulNetworkResult(resultFile, customerCompanyName);
        job.companyName = result.companyName || customerCompanyName;
        registerNetworkAccelerationServiceId(job, result.serviceId);
        if (shouldOpenContract) await prepareMagicConfigForCopy(result.serviceId, ip);
      },
    };
    const rulesStep = shouldAddRules
      ? {
        label: '进入公司用户后台并添加规则',
        resolve: (job) => buildRulesProcess({
          nodeCommand,
          rootDir: ROOT_DIR,
          serviceId: job.networkAccelerationServiceId,
          companyName: job.companyName || customerCompanyName,
          rules,
          profileIndex: 0,
        }),
      }
      : null;
    const contractStep = shouldOpenContract ? {
      label: '根据 ID 开通合约',
      resolve: (job) => buildContractProcess({
        nodeCommand,
        rootDir: ROOT_DIR,
        serviceId: job.networkAccelerationServiceId,
        ip,
        profileIndex: 0,
      }),
    } : null;

    return buildSingleProfileProvisioningWorkflow({
      label: !shouldOpenContract ? '网络加速 → 添加选中规则' : shouldAddRules
        ? '网络加速 → 添加规则 → 合约开通'
        : '网络加速 → 合约开通',
      resultFile,
      networkStep,
      rulesStep,
      contractStep,
    });
  }

  if (task === 'contract-open') {
    contractId = normalizeContractId(contractId);
    await prepareMagicConfigForCopy(contractId, ip);

    const args = [path.join(ROOT_DIR, 'scripts', 'open-contract.mjs'), '--contract-id', String(contractId).trim()];
    if (ip) args.push('--ip', String(ip).trim());
    return { label: '开通合约并配置出口', executable: nodeCommand, args };
  }

  if (task === 'add-rules') {
    const rules = normalizeRuleNames(ruleNames);
    if (rules.length === 0) throw new Error('请至少选择一个规则按钮。');

    const serviceId = String(addRuleServiceId ?? '').trim();
    if (!serviceId) throw new Error('请填写网络加速服务 ID。');
    if (!/^[A-Za-z0-9_-]+$/.test(serviceId)) throw new Error('网络加速服务 ID 格式错误，请填写纯 ID。');
    const companyName = String(addRuleCompanyName ?? '').trim() || parseCustomerProfile(customerText).companyName;
    if (!companyName) throw new Error('请填写流量规则的公司名称，或在上方客户资料中提供公司名称。');
    const args = [
      path.join(ROOT_DIR, 'scripts', 'add-rules.mjs'),
      '--service-id',
      serviceId,
      '--company',
      companyName,
      '--rules',
      JSON.stringify(rules),
    ];
    return { label: '添加流量调度规则', executable: nodeCommand, args };
  }

  if (task === 'complete-rules') {
    const rules = normalizeRuleNames(ruleNames);
    if (rules.length === 0) throw new Error('请至少选择一个规则按钮。');
    const companyName = String(completeRulesCompanyName ?? '').trim() || parseCustomerProfile(customerText).companyName;
    if (!companyName) throw new Error('请填写完善规程的公司名称，或在上方客户资料中提供公司名称。');
    return {
      label: '完善规程（自动添加）',
      executable: nodeCommand,
      args: [
        path.join(ROOT_DIR, 'scripts', 'complete-rules.mjs'),
        '--company', companyName,
        '--rules', JSON.stringify(rules),
      ],
    };
  }

  if (task === 'sdwan-takeover') {
    if (!sdwanCompanyName) throw new Error('请填写公司名称。');
    if (!deviceName) throw new Error('请填写设备名称。');
    if (!deviceMac) throw new Error('请填写设备 MAC。');

    const normalizedDeviceMac = String(deviceMac).trim();
    const takeoverArgs = [
      path.join(ROOT_DIR, 'scripts', 'takeover-sdwan.mjs'),
      '--company',
      String(sdwanCompanyName).trim(),
      '--device-name',
      String(deviceName).trim(),
      '--device-mac',
      normalizedDeviceMac,
      '--close-when-done',
    ];
    const upgradeArgs = [
      path.join(ROOT_DIR, 'scripts', 'upgrade-device.mjs'),
      '--device-mac',
      normalizedDeviceMac,
    ];

    return {
      label: '接管 SD-WAN CPE 并升级设备',
      steps: [
        { label: '接管 SD-WAN CPE', executable: nodeCommand, args: takeoverArgs },
        { label: '进入设备界面并升级', executable: nodeCommand, args: upgradeArgs },
      ],
    };
  }

  if (task === 'device-upgrade') {
    if (!upgradeDeviceMac) throw new Error('请填写设备 MAC。');

    const args = [
      path.join(ROOT_DIR, 'scripts', 'upgrade-device.mjs'),
      '--device-mac',
      String(upgradeDeviceMac).trim(),
    ];
    return { label: '设备升级', executable: nodeCommand, args };
  }

  if (task === 'device-warehouse-outbound') {
    const mac = String(deviceMac ?? '').trim();
    const companyName = String(sdwanCompanyName ?? '').trim();
    const name = String(deviceName ?? '').trim();
    if (!mac) throw new Error('请填写设备 MAC。');
    if (!name) throw new Error('请填写设备名称。');
    if (!companyName) throw new Error('请填写公司名称，用于填写设备备注。');

    const outboundArgs = [
      path.join(ROOT_DIR, 'scripts', 'device-warehouse-outbound.mjs'),
      '--device-mac', mac,
      '--device-name', name,
      '--company', companyName,
      '--close-when-done',
    ];
    const takeoverArgs = [
      path.join(ROOT_DIR, 'scripts', 'takeover-sdwan.mjs'),
      '--company', companyName,
      '--device-name', name,
      '--device-mac', mac,
      '--close-when-done',
    ];
    const upgradeArgs = [
      path.join(ROOT_DIR, 'scripts', 'upgrade-device.mjs'),
      '--device-mac', mac,
    ];
    return {
      label: '设备出库 → 接管并升级',
      steps: [
        { label: '设备仓库出库', executable: nodeCommand, args: outboundArgs },
        { label: '接管 SD-WAN CPE', executable: nodeCommand, args: takeoverArgs },
        { label: '进入设备界面并升级', executable: nodeCommand, args: upgradeArgs },
      ],
    };
  }

  throw new Error('未知功能。');
}

function createRunToken() {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeJobLog(job, message) {
  const text = String(message);
  if (!text) return;
  const prefix = `[任务#${job.number}] `;
  const output = (job.atLineStart ? prefix : '') + text.replace(/\n(?=[\s\S])/g, `\n${prefix}`);
  job.atLineStart = text.endsWith('\n');
  writeLog(output);
}

function detectUserCredentials(job, message) {
  if (job.task !== '添加用户') return;
  job.credentialsOutputBuffer = `${job.credentialsOutputBuffer || ''}${message}`.slice(-4000);
  const match = job.credentialsOutputBuffer.match(/用户凭据[：:]\s*账号[=:]\s*(\S+)\s+密码[=:]\s*(\S+)/);
  if (!match) return;

  const [, account, password] = match;
  if (job.lastDetectedUserCredentials?.account === account
    && job.lastDetectedUserCredentials?.password === password) return;

  const credentials = { account, password, companyName: job.companyName || '' };
  job.lastDetectedUserCredentials = credentials;
  latestUserCredentials = credentials;
  sendEvent({ type: 'user-credentials', ...credentials });
}

function registerNetworkAccelerationServiceId(job, serviceId) {
  if (job.lastDetectedNetworkAccelerationServiceId === serviceId) return;

  job.lastDetectedNetworkAccelerationServiceId = serviceId;
  job.networkAccelerationServiceId = serviceId;
  latestNetworkAccelerationServiceId = serviceId;
  sendEvent({ type: 'network-acceleration-service-id', serviceId });
  writeLog(`已自动填入网络加速 ID：${serviceId}\n`);
}

function handleJobOutput(job, message, stream = 'stdout') {
  if (job.accountOptions) {
    if (stream === 'stderr') {
      writeJobLog(job, message);
      return;
    }
    job.accountOutputParser ??= createAccountOutputParser(
      (result) => registerAccountResult(job, result),
      (line) => writeJobLog(job, line),
    );
    job.accountOutputParser.push(message);
    return;
  }
  detectUserCredentials(job, message);
  writeJobLog(job, message);
}

function registerAccountResult(job, result) {
  if (job.accountResult?.status === 'success') return;
  const normalized = normalizeAccountResult(result, job.accountOptions);
  const entry = { ...normalized, id: job.id, number: job.number };
  job.accountResult = entry;
  accountResults.set(job.id, entry);
  while (accountResults.size > 50) accountResults.delete(accountResults.keys().next().value);
  sendEvent({ type: 'account-result', ...entry });
}

async function prepareUserDataDir(userDataDir) {
  const skippedProfileEntries = new Set([
    'BrowserMetrics',
    'Cache',
    'Code Cache',
    'Crashpad',
    'DevToolsActivePort',
    'DawnCache',
    'GPUCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'ShaderCache',
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
  ]);

  try {
    await access(userDataDir);
    return { state: 'reused', source: userDataDir };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (await loadAuthState()) {
    await mkdir(userDataDir, { recursive: true });
    return { state: 'shared', source: AUTH_STATE_FILE };
  }

  const seedUserDataDir = await findSeedUserDataDir(userDataDir);
  const stagingDir = `${userDataDir}.initializing-${createRunToken()}`;
  try {
    await cp(seedUserDataDir, stagingDir, {
      recursive: true,
      errorOnExist: false,
      force: false,
      filter: (source) => !skippedProfileEntries.has(path.basename(source)),
    });
    await rename(stagingDir, userDataDir);
    return { state: 'copied', source: seedUserDataDir };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(userDataDir, { recursive: true });
    return { state: 'created', source: null };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function findSeedUserDataDir(targetUserDataDir) {
  const busyDirs = new Set([...jobs.values()].flatMap((job) => job.userDataDirs));
  const candidateDirs = [BASE_USER_DATA_DIR];
  if (await pathExists(PROFILE_POOL_DIR)) {
    const entries = await readdir(PROFILE_POOL_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(?:job-[A-Za-z0-9-]+|profile-\d+)$/.test(entry.name)) continue;
      const userDataDir = path.join(PROFILE_POOL_DIR, entry.name);
      if (userDataDir !== targetUserDataDir && !busyDirs.has(userDataDir)) candidateDirs.push(userDataDir);
    }
  }
  const candidates = await Promise.all(candidateDirs.map(async (userDataDir) => {
    try {
      const cookiesStat = await stat(path.join(userDataDir, 'Default', 'Network', 'Cookies'));
      return { userDataDir, mtimeMs: cookiesStat.mtimeMs };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
  return candidates.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.userDataDir ?? BASE_USER_DATA_DIR;
}

function openBrowser(url) {
  if (!shouldAutoOpenBrowser || process.platform !== 'darwin') return;

  const child = spawn('open', [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', (error) => writeLog(`无法自动打开浏览器：${error.message}\n`));
  child.unref();
}

async function serveStatic(res, fileName, contentType) {
  const content = await readFile(path.join(ROOT_DIR, 'web', fileName));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { /* Opaque origins are rejected below. */ }
      if (origin?.host !== req.headers.host || origin?.protocol !== 'http:') {
        jsonResponse(res, 403, { ok: false, error: '只允许从当前控制台发起操作。' });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      await serveStatic(res, 'control-panel.html', 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      events.add(res, {
        type: 'history', logs: logs.snapshot(), ...getStatus(),
        magicConfig: latestMagicConfig,
        networkAccelerationServiceId: latestNetworkAccelerationServiceId,
        userCredentials: latestUserCredentials,
        accountResults: [...accountResults.values()],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (shuttingDown) {
        jsonResponse(res, 503, { ok: false, error: '控制台正在关闭，请稍后重试。' });
        return;
      }
      runner.assertCapacity();
      const body = await readJson(req);
      const runToken = createRunToken();
      let command;
      try {
        command = await buildCommand(body, runToken);
      } catch (error) {
        if (!error.code) error.statusCode = 400;
        throw error;
      }
      if (shuttingDown) {
        jsonResponse(res, 503, { ok: false, error: '控制台正在关闭，请稍后重试。' });
        return;
      }
      if (body.task === 'add-user') {
        latestUserCredentials = null;
        sendEvent({ type: 'user-credentials-clear' });
      }
      const job = runner.run(command, runToken);
      if (command.accountOptions) {
        job.accountOptions = command.accountOptions;
        job.completion.then(() => {
          job.accountOutputParser?.finish();
          if (!job.accountResult) registerAccountResult(job, {
            status: 'error', message: job.stopped
              ? '添加账号任务已停止，尚未确认成功；请检查后台后再决定是否重试。'
              : job.error?.message || '没有收到账号添加成功的确认，请检查后台后再决定是否重试。',
          });
        });
      }
      jsonResponse(res, 200, { ok: true, job: { id: job.id, number: job.number, task: job.task, profileName: job.profileName, userDataDir: job.userDataDir } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/magic-config') {
      const body = await readJson(req);
      try {
        parseProxyValue(body.ip);
      } catch (error) {
        error.statusCode = 400;
        throw error;
      }
      const result = await prepareLatestMagicConfig(body.ip);
      jsonResponse(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/enter') {
      const activeChildren = [...jobs.values()].flatMap((job) => [...job.children]);
      if (activeChildren.length === 0) {
        jsonResponse(res, 409, { ok: false, error: '当前没有正在运行的任务。' });
        return;
      }
      for (const child of activeChildren) {
        if (child.stdin.writable && !child.stdin.destroyed) child.stdin.write('\n');
      }
      writeLog(`\n[已向 ${activeChildren.length} 个运行中的子任务发送 Enter]\n`);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const activeJobs = [...jobs.values()];
      if (activeJobs.length === 0) {
        jsonResponse(res, 409, { ok: false, error: '当前没有正在运行的任务。' });
        return;
      }
      for (const job of activeJobs) runner.stop(job);
      writeLog(`\n[已请求停止 ${activeJobs.length} 个运行任务]\n`);
      sendStatus();
      jsonResponse(res, 200, { ok: true });
      return;
    }

    jsonResponse(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) jsonResponse(res, error.statusCode ?? 500, { ok: false, error: error.message });
  }
});

export async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  const activeJobs = [...jobs.values()];
  for (const job of activeJobs) runner.stop(job);
  await Promise.allSettled(activeJobs.map((job) => job.completion));
  events.close();
  server.closeAllConnections();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  server.listen(PORT, HOST, () => {
    const url = `http://localhost:${server.address().port}`;
    console.log(`本地控制台已启动：${url}`);
    console.log(`最多同时运行 ${configuredMaxJobs} 个任务，可通过 CONTROL_PANEL_MAX_JOBS 调整。`);
    console.log('在网页里填写参数并点击按钮即可运行脚本。按 Ctrl+C 关闭控制台。');
    openBrowser(url);
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
