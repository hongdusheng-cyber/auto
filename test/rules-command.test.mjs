import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCommand } from '../scripts/control-panel.mjs';
import { createJobRunner } from '../scripts/job-runner.mjs';

function arg(command, name) {
  return command.args[command.args.indexOf(name) + 1];
}

test('standalone rules use an explicit company or fall back to customer details', async () => {
  const input = { task: 'add-rules', addRuleServiceId: '8685', ruleNames: ['office365'], customerText: '公司名称：客户资料公司' };
  const explicit = await buildCommand({ ...input, addRuleCompanyName: ' 指定公司 ' }, 'unused');
  assert.equal(arg(explicit, '--company'), '指定公司');
  assert.equal(arg(explicit, '--service-id'), '8685');
  const inferred = await buildCommand({ ...input, addRuleCompanyName: ' ' }, 'unused');
  assert.equal(arg(inferred, '--company'), '客户资料公司');
  await assert.rejects(buildCommand({ ...input, customerText: '' }, 'unused'), /请填写流量规则的公司名称/);
});

test('complete rules runs automatic addition with its own company and selected applications without a service ID', async () => {
  const input = {
    task: 'complete-rules', ruleNames: [' Google ', 'Google', 'office365', 'TikTok跨境电商'],
    customerText: '公司名称：客户资料公司', addRuleCompanyName: '其他流量规则公司',
    addRuleServiceId: 'irrelevant/invalid', submit: true,
  };
  const command = await buildCommand({ ...input, completeRulesCompanyName: ' 指定公司 ' }, 'unused');
  assert.equal(command.label, '完善规程（自动添加）');
  assert.match(command.args[0], /complete-rules\.mjs$/);
  assert.equal(arg(command, '--company'), '指定公司');
  assert.deepEqual(JSON.parse(arg(command, '--rules')), ['Google', 'office365', 'TikTok跨境电商']);
  for (const flag of ['--service-id', '--submit', '--close-when-done']) assert.equal(command.args.includes(flag), false);
  const inferred = await buildCommand({ ...input, completeRulesCompanyName: ' ' }, 'unused');
  assert.equal(arg(inferred, '--company'), '客户资料公司');
  await assert.rejects(buildCommand({ ...input, customerText: '' }, 'unused'), /请填写完善规程的公司名称/);
  await assert.rejects(buildCommand({ ...input, ruleNames: [] }, 'unused'), /请至少选择一个规则按钮/);
});

test('combined provisioning carries the network customer into its rules step', async (t) => {
  const workflow = await buildCommand({
    task: 'network-contract-rules', customerText: '公司名称：网络加速客户',
    addRuleCompanyName: '其他独立规则客户', ip: 'proxy.example:1080:demo:test', ruleNames: ['office365'],
  }, `test-rules-${randomUUID()}`);
  t.after(() => rm(arg(workflow.steps[0], '--file'), { force: true }));
  const rulesStep = workflow.steps[1];
  const inferred = await rulesStep.resolve({ networkAccelerationServiceId: '8685' });
  assert.equal(arg(inferred, '--company'), '网络加速客户');
  assert.equal(arg(inferred, '--service-id'), '8685');
  const fromResult = await rulesStep.resolve({ networkAccelerationServiceId: '8686', companyName: '网络结果中的客户' });
  assert.equal(arg(fromResult, '--company'), '网络结果中的客户');
  assert.equal(arg(fromResult, '--service-id'), '8686');
});

test('network and rules rejects missing inputs before starting a purchase', async () => {
  const input = { task: 'network-rules', customerText: '公司名称：网络加速客户\n应用场景：美国 5M', ruleNames: ['office365'] };
  await assert.rejects(buildCommand({ ...input, customerText: '' }, 'unused'), /客户资料/);
  await assert.rejects(buildCommand({ ...input, customerText: '应用场景：美国 5M' }, 'unused'), /缺少公司名称/);
  await assert.rejects(buildCommand({ ...input, ruleNames: [] }, 'unused'), /至少选择一个规则/);
  await assert.rejects(buildCommand({ ...input, submit: false }, 'unused'), /不能使用测试模式/);
});

for (const scenario of ['success', 'missing', 'invalid-json', 'pending', 'failed', 'wrong-company', 'invalid-id', 'process-failed']) {
  test(`network and rules workflow consumes only this run's verified result: ${scenario}`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'network-rules-flow-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const command = await buildCommand({
      task: 'network-rules', customerText: '公司名称：网络加速客户\n应用场景：美国 5M',
      ruleNames: ['office365', 'office365', 'TikTok跨境电商'],
      addRuleServiceId: 'old-id', addRuleCompanyName: '其他公司', ip: 'unused-invalid-proxy',
    }, `test-network-rules-${randomUUID()}`);
    t.after(() => rm(arg(command.steps[0], '--file'), { force: true }));
    t.after(() => rm(command.resultFile, { force: true }));
    assert.equal(command.steps.length, 2);
    assert.equal(command.profileCount, 1);
    assert.equal(arg(command.steps[0], '--result-file'), command.resultFile);
    assert.ok(command.steps[0].args.includes('--submit'));
    assert.ok(command.steps[0].args.includes('--close-when-done'));
    const result = { status: 'success', serviceId: '8973', companyName: '网络加速客户' };
    if (['pending', 'failed'].includes(scenario)) result.status = scenario;
    if (scenario === 'wrong-company') result.companyName = '其他公司';
    if (scenario === 'invalid-id') result.serviceId = '../bad';
    const resultText = scenario === 'invalid-json' ? '{' : JSON.stringify(result);
    // Replace only the external browser processes with local fixtures; execute
    // the actual serial runner, result validation and downstream command resolver.
    command.steps[0].args = ['--input-type=module', '-e', scenario === 'missing' ? '' :
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(command.resultFile)}, ${JSON.stringify(resultText)}); ${scenario === 'process-failed' ? 'process.exitCode = 1;' : ''}`];
    const resolveRules = command.steps[1].resolve;
    let rulesCommand;
    const rulesRan = path.join(directory, 'rules-ran.json');
    command.steps[1].resolve = (job) => {
      rulesCommand = resolveRules(job);
      return { ...rulesCommand, args: ['--input-type=module', '-e',
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(rulesRan)}, ${JSON.stringify(JSON.stringify(rulesCommand.args))});`] };
    };
    const runner = createJobRunner({ rootDir: directory, profilePoolDir: directory, prepareProfile: async () => {} });
    const job = runner.run(command, randomUUID());
    await job.completion;
    if (scenario === 'success') {
      assert.equal(job.status, 'completed');
      assert.equal(job.networkAccelerationServiceId, '8973');
      assert.equal(arg(rulesCommand, '--company'), '网络加速客户');
      assert.equal(arg(rulesCommand, '--service-id'), '8973');
      assert.deepEqual(JSON.parse(arg(rulesCommand, '--rules')), ['office365', 'TikTok跨境电商']);
      assert.ok(rulesCommand.args.includes('--close-when-done'));
      assert.equal(rulesCommand.profileIndex, 0);
      assert.deepEqual(JSON.parse(await readFile(rulesRan, 'utf8')), rulesCommand.args);
    } else {
      assert.equal(job.status, 'failed');
      assert.equal(rulesCommand, undefined);
      await assert.rejects(readFile(rulesRan), { code: 'ENOENT' });
    }
  });
}
