import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildContractProcess,
  buildRulesProcess,
  buildSingleProfileProvisioningWorkflow,
  readSuccessfulNetworkResult,
} from '../scripts/network-provisioning.mjs';

test('reads and validates the service ID produced by network acceleration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'network-result-'));
  const resultFile = path.join(directory, 'result.json');

  try {
    await writeFile(resultFile, JSON.stringify({ status: 'success', serviceId: ' 8565 ' }));
    const result = await readSuccessfulNetworkResult(resultFile);
    assert.equal(result.serviceId, '8565');

    await writeFile(resultFile, JSON.stringify({ status: 'failed', error: '创建失败' }));
    await assert.rejects(
      readSuccessfulNetworkResult(resultFile),
      /网络加速失败，后续任务已取消：创建失败/,
    );

    await writeFile(resultFile, JSON.stringify({ status: 'success', serviceId: '../wrong' }));
    await assert.rejects(
      readSuccessfulNetworkResult(resultFile),
      /服务 ID 格式无效/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('passes the same service ID and browser profile to contract and rules tasks', () => {
  const common = { nodeCommand: '/node', rootDir: '/workspace', serviceId: '8565' };
  const contract = buildContractProcess({ ...common, ip: '127.0.0.1:80:user:pass' });
  const rules = buildRulesProcess({
    ...common,
    companyName: '测试客户有限公司',
    rules: ['office365', 'office365', 'TikTok跨境电商'],
  });

  assert.deepEqual(contract.args.slice(1, 3), ['--contract-id', '8565']);
  assert.deepEqual(rules.args.slice(1, 3), ['--service-id', '8565']);
  assert.ok(!rules.args.includes('--file'));
  assert.equal(rules.args[rules.args.indexOf('--company') + 1], '测试客户有限公司');
  assert.deepEqual(JSON.parse(rules.args[rules.args.indexOf('--rules') + 1]), ['office365', 'TikTok跨境电商']);
  assert.ok(contract.args.includes('--close-when-done'));
  assert.ok(rules.args.includes('--close-when-done'));
  assert.equal(contract.profileIndex, 0);
  assert.equal(rules.profileIndex, 0);
});

test('the rules workflow requires a company for its service ID', () => {
  assert.throws(() => buildRulesProcess({
    nodeCommand: '/node', rootDir: '/workspace', serviceId: '8685', rules: ['office365'],
  }), /需要公司名称/);
});

test('runs network, rules, and contract sequentially in one browser profile', () => {
  const networkStep = { label: 'network', profileIndex: 0 };
  const contractStep = { label: 'contract', profileIndex: 0 };
  const rulesStep = { label: 'rules', profileIndex: 0 };
  const workflow = buildSingleProfileProvisioningWorkflow({
    label: 'workflow',
    resultFile: '/tmp/result.json',
    networkStep,
    contractStep,
    rulesStep,
  });

  assert.equal(workflow.profileCount, 1);
  assert.deepEqual(workflow.steps, [networkStep, rulesStep, contractStep]);
  assert.ok(workflow.steps.every((step) => !step.parallel));
});
