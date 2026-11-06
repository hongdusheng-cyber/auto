import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountOutputParser, normalizeAccountResult } from '../scripts/account-results.mjs';

const options = { companyName: '示例公司', fullName: '张三', email: 'zhang@example.com' };
const success = {
  status: 'success', companyName: options.companyName, fullName: options.fullName,
  account: options.email, password: 'Abc2345xyz', phone: '13812345678', message: '账号添加成功',
};

function outputCollector() {
  const results = [];
  const logs = [];
  const parser = createAccountOutputParser((value) => results.push(value), (value) => logs.push(value));
  return { parser, results, logs };
}

test('account results wait for the full line when the prefix and password arrive in separate chunks', () => {
  const { parser, results, logs } = outputCollector();
  const line = `ACCOUNT_RESULT ${JSON.stringify(success)}`;
  const passwordStart = line.indexOf(success.password);
  parser.push('正在添加账号\nACCO');
  parser.push(line.slice(4, passwordStart + 3));
  assert.deepEqual(results, []);
  assert.deepEqual(logs, ['正在添加账号\n']);

  parser.push(line.slice(passwordStart + 3));
  assert.deepEqual(results, [], 'a JSON object without its terminating newline is still incomplete');
  parser.push('\n账号任务已结束\n');
  assert.deepEqual(results, [success]);
  assert.deepEqual(logs, ['正在添加账号\n', '账号任务已结束\n']);
  assert.ok(!logs.join('').includes(success.password));
  assert.ok(!logs.join('').includes('ACCOUNT_RESULT'));
});

test('multiple result lines are parsed while ordinary trailing output is flushed on finish', () => {
  const { parser, results, logs } = outputCollector();
  const failure = { status: 'error', message: '手机号重复' };
  parser.push(`ACCOUNT_RESULT ${JSON.stringify(success)}\r\nACCOUNT_RESULT ${JSON.stringify(failure)}\n关闭浏览器`);
  assert.deepEqual(results, [success, failure]);
  assert.deepEqual(logs, []);
  parser.finish();
  assert.deepEqual(logs, ['关闭浏览器']);
  parser.finish();
  assert.deepEqual(logs, ['关闭浏览器'], 'finishing twice must not duplicate the trailing output');
});

test('malformed, unsupported and unfinished structured output never reveals its password in logs', () => {
  const { parser, results, logs } = outputCollector();
  parser.push(`ACCOUNT_RESULT {"password":"${success.password}",invalid}\n`);
  parser.push(`ACCOUNT_RESULT ${JSON.stringify({ ...success, status: 'prepared' })}\n`);
  parser.push(`ACCOUNT_RESULT ${JSON.stringify(success)}`);
  parser.finish();
  assert.deepEqual(results, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /结果格式无效/);
  assert.ok(!logs.join('').includes(success.password));
  assert.ok(!logs.join('').includes('ACCOUNT_RESULT'));
});

test('confirmed account results preserve the credentials with their submitted identity', () => {
  assert.deepEqual(normalizeAccountResult(success, options), success);
});

test('failed account results discard the password and take the identity from this job', () => {
  const normalized = normalizeAccountResult({
    ...success, status: 'error', companyName: '其他公司', fullName: '李四',
    account: 'other@example.com', message: '【手机号重复】13812345678，请检查。',
  }, options);
  assert.deepEqual(normalized, {
    companyName: options.companyName, fullName: options.fullName, account: options.email,
    phone: success.phone, status: 'error', message: '【手机号重复】13812345678，请检查。',
  });
  assert.ok(!Object.hasOwn(normalized, 'password'));
});

test('a success for a different company, person or email is rejected without credentials', () => {
  for (const [field, value] of [
    ['companyName', '其他公司'], ['fullName', '李四'], ['account', 'other@example.com'],
  ]) {
    const normalized = normalizeAccountResult({ ...success, [field]: value }, options);
    assert.equal(normalized.status, 'error', field);
    assert.match(normalized.message, /结果与本次参数不一致/);
    assert.equal(normalized.companyName, options.companyName);
    assert.equal(normalized.fullName, options.fullName);
    assert.equal(normalized.account, options.email);
    assert.ok(!Object.hasOwn(normalized, 'password'), field);
  }
});

test('success must contain a valid generated password and an 11 digit mobile number', () => {
  for (const changes of [
    { password: '' }, { password: 'short' }, { password: 'Abc2345xy!' },
    { phone: '1381234567' }, { phone: '12812345678' }, { phone: '138123456789' },
  ]) {
    const normalized = normalizeAccountResult({ ...success, ...changes }, options);
    assert.equal(normalized.status, 'error', JSON.stringify(changes));
    assert.ok(!Object.hasOwn(normalized, 'password'));
  }
});
