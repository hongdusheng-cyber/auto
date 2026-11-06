import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommand } from '../scripts/control-panel.mjs';

function arg(command, name) {
  return command.args[command.args.indexOf(name) + 1];
}

test('device warehouse outbound builds a MAC based command', async () => {
  const command = await buildCommand({
    task: 'device-warehouse-outbound',
    sdwanCompanyName: '金华市海杰电子商务有限公司',
    deviceName: '客户公司-CPE01',
    deviceMac: '11:22:77:07:93:41',
  }, 'unused');

  assert.equal(command.label, '设备出库 → 接管并升级');
  assert.equal(command.steps.length, 3);
  assert.equal(arg(command.steps[0], '--device-mac'), '11:22:77:07:93:41');
  assert.equal(arg(command.steps[0], '--device-name'), '客户公司-CPE01');
  assert.equal(arg(command.steps[0], '--company'), '金华市海杰电子商务有限公司');
  assert.equal(arg(command.steps[1], '--device-mac'), '11:22:77:07:93:41');
  assert.equal(arg(command.steps[1], '--device-name'), '客户公司-CPE01');
  assert.equal(arg(command.steps[2], '--device-mac'), '11:22:77:07:93:41');
  assert.ok(command.steps[0].args.includes('--close-when-done'));
  assert.ok(command.steps[1].args.includes('--close-when-done'));
});

test('device warehouse outbound validates required inputs', async () => {
  await assert.rejects(
    buildCommand({ task: 'device-warehouse-outbound', sdwanCompanyName: '公司', deviceName: '设备' }, 'unused'),
    /请填写设备 MAC/,
  );
  await assert.rejects(
    buildCommand({ task: 'device-warehouse-outbound', sdwanCompanyName: '公司', deviceMac: '11:22:77:07:93:41' }, 'unused'),
    /请填写设备名称/,
  );
  await assert.rejects(
    buildCommand({ task: 'device-warehouse-outbound', deviceName: '设备', deviceMac: '11:22:77:07:93:41' }, 'unused'),
    /请填写公司名称/,
  );
});
