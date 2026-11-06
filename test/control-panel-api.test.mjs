import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { server, shutdown } from '../scripts/control-panel.mjs';

test('local API validates requests and streams initial status without running business tasks', async (t) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(shutdown);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (endpoint, body, headers = {}) => {
    try {
      return await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
    } catch (cause) {
      throw new Error(`POST ${endpoint} (${Buffer.byteLength(body)} bytes) failed`, { cause });
    }
  };

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /EventSource/);
  for (const body of ['{', 'null', '[]']) {
    const response = await post('/api/run', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal((await post('/api/run', JSON.stringify({ task: 'unknown' }))).status, 400);
  assert.equal((await post('/api/run', JSON.stringify({ task: 'add-user', customerText: ' ' }))).status, 400);
  assert.equal((await post('/api/run', JSON.stringify({ task: 'add-account', customerText: '公司名称：旧客户' }))).status, 400);
  const invalidAccount = await post('/api/run', JSON.stringify({ task: 'add-account', accountCompanyName: '示例公司', accountFullName: '张三', accountEmail: 'invalid-email' }));
  assert.equal(invalidAccount.status, 400);
  assert.match((await invalidAccount.json()).error, /邮箱/);
  assert.equal((await post('/api/run', JSON.stringify({ task: 'complete-rules', completeRulesCompanyName: '公司', ruleNames: [] }))).status, 400);
  assert.equal((await post('/api/run', JSON.stringify({ task: 'complete-rules', ruleNames: ['Google'] }))).status, 400);
  assert.equal((await post('/api/run', JSON.stringify({ task: 'contract-open', contractId: '../../bad' }))).status, 400);
  assert.equal((await post('/api/magic-config', JSON.stringify({ ip: 'invalid' }))).status, 400);
  const oversized = await post('/api/run', JSON.stringify({ customerText: '中'.repeat(400000) }));
  assert.equal(oversized.status, 413);
  assert.equal((await post('/api/stop', '{}', { Origin: 'https://unrelated.test' })).status, 403);
  assert.equal((await post('/api/stop', '{}', { Origin: 'null' })).status, 403);
  assert.equal((await post('/api/stop', '{}')).status, 409);
  assert.equal((await post('/api/enter', '{}')).status, 409);

  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const history = JSON.parse(new TextDecoder().decode(value).split('data: ')[1].trim());
  assert.equal(history.type, 'history');
  assert.equal(history.running, false);
  assert.deepEqual(history.jobs, []);
  assert.deepEqual(history.accountResults, []);
  controller.abort();
});
