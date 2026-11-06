import { readFile } from 'node:fs/promises';
import path from 'node:path';

const SERVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeServiceId(value) {
  const serviceId = String(value ?? '').trim();
  if (!SERVICE_ID_PATTERN.test(serviceId)) {
    throw new Error('网络加速返回的服务 ID 格式无效。');
  }

  return serviceId;
}

export async function readSuccessfulNetworkResult(resultFile, expectedCompanyName) {
  let result;
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`网络加速没有生成结果文件：${resultFile}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`网络加速结果文件不是有效 JSON：${resultFile}`);
    }
    throw error;
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('网络加速结果文件内容无效。');
  }
  if (result.status === 'failed') {
    throw new Error(`网络加速失败，后续任务已取消：${result.error || '未知错误'}`);
  }
  if (result.status !== 'success') {
    throw new Error(`网络加速没有成功产出 ID，当前状态：${result.status || '未知'}`);
  }
  if (expectedCompanyName && result.companyName !== expectedCompanyName) {
    throw new Error('网络加速结果中的公司与本次客户不一致，后续任务已取消。');
  }

  return {
    ...result,
    serviceId: normalizeServiceId(result.serviceId),
  };
}

export function buildContractProcess({ nodeCommand, rootDir, serviceId, ip, profileIndex = 0 }) {
  return {
    label: '开通合约并配置出口',
    executable: nodeCommand,
    args: [
      path.join(rootDir, 'scripts', 'open-contract.mjs'),
      '--contract-id',
      normalizeServiceId(serviceId),
      '--ip',
      String(ip).trim(),
      '--close-when-done',
    ],
    profileIndex,
  };
}

export function buildRulesProcess({ nodeCommand, rootDir, serviceId, companyName, rules, profileIndex = 0 }) {
  const uniqueRules = [...new Set((rules ?? []).map((rule) => String(rule).trim()).filter(Boolean))];
  if (uniqueRules.length === 0) throw new Error('请至少选择一个规则按钮。');
  const company = String(companyName ?? '').trim();
  if (!company) throw new Error('添加规则前需要公司名称，以进入对应公司用户后台。');

  return {
    label: '添加选中规则',
    executable: nodeCommand,
    args: [
      path.join(rootDir, 'scripts', 'add-rules.mjs'),
      '--service-id',
      normalizeServiceId(serviceId),
      '--company',
      company,
      '--rules',
      JSON.stringify(uniqueRules),
      '--close-when-done',
    ],
    profileIndex,
  };
}

export function buildSingleProfileProvisioningWorkflow({
  label,
  resultFile,
  networkStep,
  contractStep = null,
  rulesStep = null,
}) {
  return {
    label,
    profileCount: 1,
    resultFile,
    steps: [networkStep, ...(rulesStep ? [rulesStep] : []), ...(contractStep ? [contractStep] : [])],
  };
}
