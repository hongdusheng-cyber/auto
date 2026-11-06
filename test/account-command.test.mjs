import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommand } from '../scripts/control-panel.mjs';

const input = {
  task: 'add-account', accountCompanyName: '示例公司',
  accountFullName: '张三', accountEmail: 'zhang@example.com',
};

test('add account builds a submission command from its own company, name and email fields', async () => {
  const command = await buildCommand({
    ...input, accountCompanyName: ' 示例公司 ', accountFullName: ' 张三 ',
    accountEmail: ' zhang@example.com ', customerText: '公司名称：其他旧客户',
    password: 'old-password',
  }, 'unused');
  assert.equal(command.label, '添加账号');
  assert.ok(command.executable);
  assert.match(command.args[0], /[/\\]scripts[/\\]add-account\.mjs$/);
  assert.deepEqual(command.args.slice(1), [
    '--company', input.accountCompanyName, '--name', input.accountFullName,
    '--email', input.accountEmail, '--submit',
  ]);
  assert.deepEqual(command.accountOptions, {
    companyName: input.accountCompanyName, fullName: input.accountFullName,
    lastName: '张', firstName: '三', email: input.accountEmail,
  });
  assert.equal(command.args.includes('--password'), false);
  assert.equal(command.args.includes('--file'), false);
});

test('add account keeps an explicitly separated surname and given name as one CLI argument', async () => {
  const command = await buildCommand({ ...input, accountFullName: ' Smith   John Paul ' }, 'unused');
  assert.equal(command.args[command.args.indexOf('--name') + 1], 'Smith John Paul');
  assert.equal(command.accountOptions.lastName, 'Smith');
  assert.equal(command.accountOptions.firstName, 'John Paul');
});

test('add account rejects missing and invalid values before launching a browser', async () => {
  for (const [field, expected] of [
    ['accountCompanyName', /请填写公司名称/], ['accountFullName', /请填写姓名/], ['accountEmail', /请填写邮箱/],
  ]) {
    for (const value of [undefined, '', '   ', 42]) {
      await assert.rejects(buildCommand({ ...input, [field]: value }, 'unused'), expected, `${field}: ${value}`);
    }
  }
  for (const [changes, expected] of [
    [{ accountCompanyName: '公司\n其他公司' }, /公司名称格式不正确/],
    [{ accountFullName: '张' }, /姓名无法拆分/],
    [{ accountFullName: 'John' }, /请将姓名/],
    [{ accountEmail: 'bad-email' }, /有效的邮箱地址/],
    [{ accountEmail: 'name@@example.com' }, /有效的邮箱地址/],
    [{ accountEmail: 'name@example' }, /有效的邮箱地址/],
    [{ accountEmail: 'name @example.com' }, /有效的邮箱地址/],
  ]) {
    await assert.rejects(buildCommand({ ...input, ...changes }, 'unused'), expected);
  }
});

test('add account never substitutes the old customer text for a missing explicit company', async () => {
  await assert.rejects(buildCommand({
    ...input, accountCompanyName: '', customerText: '公司名称：旧客户公司\n姓名：张三\n邮箱：old@example.com',
    sdwanCompanyName: '设备公司', addRuleCompanyName: '流量规则公司',
  }, 'unused'), /请填写公司名称/);
});
