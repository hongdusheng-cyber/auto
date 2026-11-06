import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../web/control-panel.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the real page script with a small DOM and fake network; no automation jobs are started.
class TextNode {
  constructor(text) { this.data = text; }
  get textContent() { return this.data; }
  get length() { return this.data.length; }
  deleteData(start, count) { this.data = this.data.slice(0, start) + this.data.slice(start + count); }
  remove() { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); }
}

class Element {
  constructor() {
    this.childNodes = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.focused = false;
    this.clientHeight = 100;
    this.scrollPosition = 0;
    this.appendCount = 0;
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force = !this.classes.has(name)) => {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return force;
      },
    };
  }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); if (value) this.append(new TextNode(value)); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter((node) => node instanceof Element); }
  get scrollHeight() { return this.textContent.length + this.clientHeight; }
  get scrollTop() { return this.scrollPosition; }
  set scrollTop(value) { this.scrollPosition = Math.min(Math.max(0, value), this.scrollHeight - this.clientHeight); }
  append(node) { node.parentNode = this; this.childNodes.push(node); this.appendCount += 1; }
  prepend(node) { node.parentNode = this; this.childNodes.unshift(node); }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  replaceChildren() { this.childNodes = []; this.scrollPosition = 0; }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }
  dispatch(type, event = {}) {
    return Promise.all((this.listeners.get(type) ?? []).map((listener) => listener({ preventDefault() {}, ...event })));
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll(selector) {
    const matches = (node) => selector.split(',').some((part) => {
      const name = part.trim();
      if (name.startsWith('.')) return node.classList.contains(name.slice(1));
      if (name.startsWith('#')) return node.id === name.slice(1);
      return node.tagName?.toLowerCase() === name;
    });
    return this.children.flatMap((node) => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: this.clientHeight }; }
  select() { this.selected = true; }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollTo({ top }) { this.scrollTop = top; }
}

function createPanel({ storage = new Map(), denyStorage = false, fetch, clipboard } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    element.id = match[1];
    element.tagName = match[0].match(/^<(\w+)/)[1].toUpperCase();
    element.disabled = /\bdisabled\b/.test(match[0]);
    element.hidden = /\bhidden(?:\s|>|=)/.test(match[0]);
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) {
      element.setAttribute(attribute[1], attribute[2]);
    }
    element.className = element.getAttribute('class') ?? '';
    const initialText = html.slice(match.index + match[0].length).match(/^([^<]*)<\//)?.[1];
    if (initialText) element.textContent = initialText;
    elements.set(`#${element.id}`, element);
  }
  for (const selector of ['.controls', '.console-panel', '.nav-status']) elements.set(selector, new Element());
  const runButtons = [...html.matchAll(/<button[^>]*data-task="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((match) => {
    const button = new Element();
    button.dataset.task = match[1];
    button.textContent = match[2];
    return button;
  });
  const frames = new Map();
  let sequence = 0;
  let events;
  const context = vm.createContext({
    document: {
      body: new Element(),
      querySelector: (selector) => elements.get(selector) ?? null,
      querySelectorAll: (selector) => selector === '[data-task]' ? runButtons : [],
      createElement: (tagName) => Object.assign(new Element(), { tagName: tagName.toUpperCase() }),
      createTextNode: (text) => new TextNode(text),
    },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {}, innerHeight: 900, scrollY: 0, scrollTo({ top }) { this.scrollY = top; } },
    localStorage: {
      getItem(key) { if (denyStorage) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (denyStorage) throw new Error('Storage denied'); storage.set(key, value); },
    },
    EventSource: class { constructor() { events = this; } },
    fetch: fetch ?? (() => { throw new Error('Unexpected network request'); }),
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout() { return ++sequence; },
    clearTimeout() {},
    crypto: webcrypto,
    navigator: { clipboard },
  });
  vm.runInContext(script, context, { filename: 'control-panel.html' });
  return {
    node: (selector) => elements.get(selector),
    runButtons,
    events,
    frames,
    emit(data) { events.onmessage({ data: JSON.stringify(data) }); },
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function pendingRequests() {
  const requests = [];
  return {
    requests,
    fetch(url, options) {
      return new Promise((resolve) => {
        requests.push({ url, body: JSON.parse(options.body), finish(data = { ok: true }) {
          resolve({ ok: true, status: 200, async json() { return data; } });
        } });
      });
    },
  };
}

function taskButton(panel, task) {
  return panel.runButtons.find((button) => button.dataset.task === task);
}

const validFieldValues = {
  customerText: '公司名称：测试客户\n邮箱：customer@example.com',
  accountCompanyName: '成员所属公司',
  accountFullName: '欧阳明',
  accountEmail: 'member@example.com',
  ip: '203.0.113.8:62001:account:password',
  contractId: 'service_8685-A',
  addRuleCompanyName: '流量规则客户',
  addRuleServiceId: 'service_8685-A',
  completeRulesCompanyName: '完善规程客户',
  sdwanCompanyName: '设备客户',
  deviceName: '客户-CPE01',
  deviceMac: 'AA:BB:CC:DD:EE:FF',
};

const taskRequirements = [
  ['add-user', ['customerText'], 'customerFeedback'],
  ['add-account', ['accountCompanyName', 'accountFullName', 'accountEmail'], 'accountFeedback'],
  ['network-acceleration', ['customerText'], 'customerFeedback'],
  ['network-rules', ['customerText', 'rulePresets'], 'customerFeedback'],
  ['network-contract', ['customerText', 'ip'], 'customerFeedback'],
  ['network-contract-rules', ['customerText', 'ip', 'rulePresets'], 'customerFeedback'],
  ['contract-open', ['contractId'], 'contractFeedback'],
  ['add-rules', ['addRuleCompanyName', 'addRuleServiceId', 'rulePresets'], 'rulesFeedback'],
  ['complete-rules', ['completeRulesCompanyName', 'completeRulesPresets'], 'completeRulesFeedback'],
  ['sdwan-takeover', ['sdwanCompanyName', 'deviceName', 'deviceMac'], 'deviceFeedback'],
  ['device-warehouse-outbound', ['sdwanCompanyName', 'deviceName', 'deviceMac'], 'deviceFeedback'],
];

test('Magic copy action stays beside the contract and generation actions', () => {
  const contractGroup = html.match(/<div class="group" id="contractGroup"[\s\S]*?<div class="group" id="rulesGroup"/)[0];
  const topActions = contractGroup.match(/<div class="actions">([\s\S]*?)<\/div>/)[1];
  const magicDetails = contractGroup.match(/<details id="magicDetails">([\s\S]*?)<\/details>/)[1];

  assert.match(topActions, /data-task="contract-open"/);
  assert.match(topActions, /id="generateMagicConfig"/);
  assert.match(topActions, /id="copyMagicConfig"/);
  assert.doesNotMatch(magicDetails, /id="copyMagicConfig"/);
  assert.match(magicDetails, /id="copyFeedback"/);
});

test('the account creation section stays hidden from the control panel', () => {
  const accountGroup = html.match(/<section class="account-section" id="accountGroup"[^>]*>/)[0];
  assert.match(accountGroup, /\shidden(?:\s|>)/);
});

async function fillTaskRequirements(panel, fields, omittedField) {
  for (const field of fields) {
    if (field === omittedField) continue;
    if (field === 'rulePresets' || field === 'completeRulesPresets') {
      await panel.node(`#${field}`).childNodes[0].dispatch('click');
    } else {
      panel.node(`#${field}`).value = validFieldValues[field];
    }
  }
}

test('batches high-volume logs and bounds both deferred and rendered output', () => {
  const panel = createPanel();
  const terminal = panel.node('#terminal');
  for (let index = 0; index < 10000; index += 1) {
    panel.emit({ type: 'log', message: `${index}:` + 'x'.repeat(100) + '\n' });
  }
  assert.equal(terminal.textContent, '');
  assert.equal(panel.frames.size, 1);
  panel.frame();
  assert.equal(terminal.appendCount, 1);
  assert.equal(terminal.textContent.length, 200000);
  assert.ok(terminal.textContent.endsWith('9999:' + 'x'.repeat(100) + '\n'));
  for (let index = 0; index < 2200; index += 1) {
    panel.emit({ type: 'log', message: `${index}\n` });
    panel.frame();
  }
  assert.ok(terminal.textContent.length <= 200000);
  assert.ok(terminal.childNodes.length <= 2000);
  assert.ok(terminal.textContent.endsWith('2199\n'));
});

test('clearing logs cancels stale pending output', async () => {
  const panel = createPanel();
  panel.emit({ type: 'log', message: 'stale output' });
  await panel.node('#clearTerminal').dispatch('click');
  panel.emit({ type: 'log', message: 'new output' });
  panel.frame();
  assert.equal(panel.node('#terminal').textContent, 'new output');
});

test('log updates preserve a reader’s scroll position and resume following at the bottom', async () => {
  const panel = createPanel();
  const terminal = panel.node('#terminal');
  await panel.node('#consoleToggle').dispatch('click');
  panel.emit({ type: 'log', message: 'x'.repeat(1000) });
  panel.frame();
  assert.equal(terminal.scrollTop, 1000);
  terminal.scrollTop = 50;
  await terminal.dispatch('scroll');
  panel.emit({ type: 'log', message: 'y'.repeat(100) });
  panel.frame();
  assert.equal(terminal.scrollTop, 50);
  panel.emit({ type: 'status', running: false });
  assert.equal(terminal.scrollTop, 50);
  terminal.scrollTop = terminal.scrollHeight;
  await terminal.dispatch('scroll');
  panel.emit({ type: 'log', message: 'z'.repeat(100) });
  panel.frame();
  assert.equal(terminal.scrollTop, 1200);
});

test('reconnection and live service IDs preserve manually edited fields', async () => {
  const panel = createPanel();
  const contract = panel.node('#contractId');
  const rules = panel.node('#addRuleServiceId');
  panel.emit({ type: 'history', logs: [], networkAccelerationServiceId: '123' });
  assert.equal(contract.value, '123');
  contract.value = '456';
  await contract.dispatch('input');
  panel.emit({ type: 'history', logs: [], networkAccelerationServiceId: '999' });
  panel.emit({ type: 'network-acceleration-service-id', serviceId: '888' });
  assert.equal(contract.value, '456');
  assert.equal(rules.value, '888');
  contract.value = '';
  await contract.dispatch('input');
  panel.emit({ type: 'network-acceleration-service-id', serviceId: '777' });
  assert.equal(contract.value, '777');
});

test('network and rules starts without an IP or service ID and fills the created ID from the result', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#customerText').value = '公司名称：示例客户\n应用场景：美国 5M';
  await panel.node('#rulePresets').childNodes[0].dispatch('click');
  const run = taskButton(panel, 'network-rules').dispatch('click');
  assert.equal(network.requests.length, 1);
  assert.equal(network.requests[0].body.task, 'network-rules');
  assert.equal(network.requests[0].body.ip, '');
  assert.equal(network.requests[0].body.addRuleServiceId, '');
  assert.deepEqual(network.requests[0].body.ruleNames, ['office365', 'TikTok跨境电商']);
  network.requests[0].finish({ ok: true, job: { number: 1 } });
  await run;
  panel.emit({ type: 'network-acceleration-service-id', serviceId: '8973' });
  assert.equal(panel.node('#addRuleServiceId').value, '8973');
  assert.equal(panel.node('#addRuleServiceIdError').hidden, true);
  assert.equal(network.requests.length, 1, 'the server workflow owns rule submission');
});

test('storage failure does not prevent initialization or in-memory rule editing', async () => {
  const panel = createPanel({ denyStorage: true });
  assert.match(panel.node('#generatedPassword').value, /^[a-zA-Z0-9]{10}$/);
  await panel.node('#themeToggle').dispatch('click');
  panel.node('#rulePresetName').value = 'Custom';
  panel.node('#rulePresetRules').value = 'example';
  await panel.node('#saveRulePreset').dispatch('click');
  assert.match(panel.node('#rulePresets').textContent, /Custom/);
  assert.match(panel.node('#selectedRuleHint').textContent, /仅在当前页面有效/);
});

test('an intentionally empty rule list remains empty after reloading', async () => {
  const storage = new Map();
  const panel = createPanel({ storage });
  panel.node('#rulePresetName').value = 'TK';
  await panel.node('#deleteRulePreset').dispatch('click');
  assert.equal(panel.node('#rulePresets').childNodes.length, 0);
  assert.equal(createPanel({ storage }).node('#rulePresets').childNodes.length, 0);
});

test('repeated Enter requests stay blocked across SSE updates and restore current task state', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  const button = panel.node('#sendEnter');
  panel.emit({ type: 'status', running: true, task: 'test' });
  const first = button.dispatch('click');
  panel.emit({ type: 'status', running: true, task: 'test' });
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(network.requests.length, 1);
  panel.emit({ type: 'status', running: false });
  network.requests[0].finish();
  await first;
  assert.equal(button.disabled, true);
});

test('a pending run blocks duplicate clicks while different task buttons remain independent', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#customerText').value = validFieldValues.customerText;
  const firstButton = taskButton(panel, 'add-user');
  const secondButton = taskButton(panel, 'network-acceleration');
  const originalText = firstButton.textContent;
  const first = firstButton.dispatch('click');
  assert.equal(firstButton.disabled, true);
  assert.equal(firstButton.getAttribute('aria-busy'), 'true');
  assert.match(network.requests[0].body.password, /^[A-Za-z0-9]{10}$/);
  await firstButton.dispatch('click');
  const other = secondButton.dispatch('click');
  assert.equal(network.requests.length, 2);
  assert.notEqual(network.requests[0].body.task, network.requests[1].body.task);
  network.requests.forEach((request, index) => request.finish({ ok: true, job: { number: index, task: request.body.task, profileName: 'test' } }));
  await Promise.all([first, other]);
  assert.equal(firstButton.disabled, false);
  assert.equal(firstButton.getAttribute('aria-busy'), 'false');
  assert.equal(firstButton.textContent, originalText);
});

test('add-user displays the returned account and random password', () => {
  const panel = createPanel();
  const result = panel.node('#userCredentials');
  assert.equal(result.hidden, true);
  panel.emit({ type: 'user-credentials', account: 'customer@example.com', password: 'Ab3def4567' });
  assert.equal(result.hidden, false);
  assert.equal(panel.node('#userAccount').textContent, 'customer@example.com');
  assert.equal(panel.node('#userPassword').textContent, 'Ab3def4567');
  panel.emit({ type: 'user-credentials-clear' });
  assert.equal(result.hidden, true);
});

test('add-account only submits its three trimmed fields without the generated password', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  for (const field of ['accountCompanyName', 'accountFullName', 'accountEmail']) panel.node(`#${field}`).value = `  ${validFieldValues[field]}  `;
  panel.node('#customerText').value = validFieldValues.customerText;
  panel.node('#ip').value = 'invalid-unrelated-input';
  panel.node('#generatedPassword').value = 'OldPassword123';
  panel.emit({ type: 'user-credentials', account: 'existing@example.com', password: 'ExistingPass123' });
  const run = taskButton(panel, 'add-account').dispatch('click');
  assert.equal(network.requests.length, 1);
  assert.deepEqual(network.requests[0].body, {
    task: 'add-account',
    accountCompanyName: '成员所属公司',
    accountFullName: '欧阳明',
    accountEmail: 'member@example.com',
  });
  assert.equal(panel.node('#userCredentials').hidden, false);
  assert.equal(panel.node('#userPassword').textContent, 'ExistingPass123');
  network.requests[0].finish({ ok: true, job: { id: 'new-account', number: 1, task: 'add-account', profileName: 'test' } });
  await run;
  assert.equal(panel.node('#customerFeedback').hidden, true);
  assert.match(panel.node('#accountFeedback').textContent, /正在添加账号.*下方显示账号和密码/);
  assert.doesNotMatch(panel.node('#accountFeedback').textContent, /日志|任务 #/);
});

test('add-account rejects invalid email and clears the validation after correction', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  await fillTaskRequirements(panel, ['accountCompanyName', 'accountFullName', 'accountEmail']);
  panel.node('#accountEmail').value = 'invalid-email';
  await taskButton(panel, 'add-account').dispatch('click');
  assert.equal(network.requests.length, 0);
  assert.equal(panel.node('#accountEmail').focused, true);
  assert.equal(panel.node('#accountEmailError').hidden, false);
  assert.match(panel.node('#accountEmailError').textContent, /有效的邮箱/);
  panel.node('#accountEmail').value = validFieldValues.accountEmail;
  await panel.node('#accountEmail').dispatch('input');
  assert.equal(panel.node('#accountEmailError').hidden, true);
  assert.equal(panel.node('#accountFeedback').hidden, true);
});

test('account completion updates the current task without allowing older jobs to replace its feedback', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  await fillTaskRequirements(panel, ['accountCompanyName', 'accountFullName', 'accountEmail']);
  const first = taskButton(panel, 'add-account').dispatch('click');
  network.requests[0].finish({ ok: true, job: { id: 'first', number: 1, task: 'add-account' } });
  await first;
  const second = taskButton(panel, 'add-account').dispatch('click');
  const submitting = panel.node('#accountFeedback').textContent;
  panel.emit({ type: 'account-result', id: 'first', status: 'error', message: '手机号 13812345678 已存在' });
  assert.equal(panel.node('#accountFeedback').textContent, submitting);
  network.requests[1].finish({ ok: true, job: { id: 'second', number: 2, task: 'add-account' } });
  await second;
  const pending = panel.node('#accountFeedback').textContent;
  panel.emit({ type: 'account-result', id: 'first', status: 'success', account: 'first@example.com', password: 'FirstPass123' });
  assert.equal(panel.node('#accountFeedback').textContent, pending);
  panel.emit({ type: 'account-result', id: 'second', status: 'success', account: 'second@example.com', password: 'SecondPass123' });
  assert.equal(panel.node('#accountFeedback').textContent, '账号已添加，账号和密码已显示在下方。');
  assert.equal(panel.node('#accountResults').children[0].dataset.jobId, 'second');
  panel.emit({ type: 'account-result', id: 'first', status: 'error', message: '较早任务失败' });
  assert.equal(panel.node('#accountFeedback').textContent, '账号已添加，账号和密码已显示在下方。');
});

test('account results received before the start response retain completion and show concise current failures', async () => {
  for (const outcome of [
    { status: 'success', account: 'ready@example.com', password: 'ReadyPass123', expected: /账号已添加/ },
    { status: 'error', message: '\u001b[2mlocator.waitFor: Timeout 15000ms exceeded. Call log:\n waiting for getByRole(checkbox)', expected: /操作超时/ },
    { status: 'error', message: '【手机号重复】13812345678：该手机号已存在', expected: /手机号重复，请核查/ },
  ]) {
    const network = pendingRequests();
    const panel = createPanel(network);
    await fillTaskRequirements(panel, ['accountCompanyName', 'accountFullName', 'accountEmail']);
    const run = taskButton(panel, 'add-account').dispatch('click');
    panel.emit({ type: 'account-result', id: 'early', ...outcome });
    network.requests[0].finish({ ok: true, job: { id: 'early', number: 24, task: 'add-account' } });
    await run;
    const feedback = panel.node('#accountFeedback');
    assert.match(feedback.textContent, outcome.expected);
    assert.doesNotMatch(feedback.textContent, /任务|日志|locator|Call log|13812345678|15000/);
    assert.equal(panel.node('#accountResults').children.length, outcome.status === 'success' ? 1 : 0);
  }
});

test('account start failures stay in the form and retain raw errors only in the diagnostic console', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  await fillTaskRequirements(panel, ['accountCompanyName', 'accountFullName', 'accountEmail']);
  const run = taskButton(panel, 'add-account').dispatch('click');
  network.requests[0].finish({ ok: false, error: 'locator.waitFor: Timeout 15000ms exceeded. Call log: internal details' });
  await run;
  assert.match(panel.node('#accountFeedback').textContent, /操作超时/);
  assert.doesNotMatch(panel.node('#accountFeedback').textContent, /locator|Call log|internal details|15000/);
  assert.equal(panel.node('#consoleToggle').getAttribute('aria-expanded'), 'false');
  panel.frame();
  assert.match(panel.node('#terminal').textContent, /internal details/);
});

test('account results display only successful credentials and keep task details out of the form', () => {
  const storage = new Map();
  const panel = createPanel({ storage });
  const results = panel.node('#accountResults');
  assert.equal(results.hidden, true);
  panel.emit({ type: 'account-result', id: 'second', number: 2, status: 'success', companyName: '<script>unsafe</script>', fullName: '李四', account: 'second@example.com', password: '<img src=x onerror=unsafe>', phone: '13912345678' });
  panel.emit({ type: 'account-result', id: 'first', number: 1, status: 'error', companyName: '第一家公司', fullName: '张三', account: 'failed@example.com', password: 'MustNotDisplay123', phone: '13812345678', message: '手机号 13812345678 已存在，请核查重复号码。' });
  assert.equal(results.hidden, false);
  assert.equal(results.children.length, 1);
  const [success] = results.children;
  assert.equal(success.dataset.jobId, 'second');
  assert.match(success.textContent, /账号：second@example.com密码：<img src=x onerror=unsafe>/);
  assert.equal(success.querySelectorAll('code').length, 2);
  assert.equal(success.querySelectorAll('script, img').length, 0);
  assert.doesNotMatch(results.textContent, /任务|添加失败|手机号|13912345678|13812345678|第一家公司|李四|张三|<script>|MustNotDisplay123|failed@example.com/);
  assert.doesNotMatch([...storage.values()].join('\n'), /second@example.com|onerror=unsafe|MustNotDisplay123/);
  panel.emit({ type: 'user-credentials', account: 'legacy@example.com', password: 'LegacyPass123' });
  panel.emit({ type: 'user-credentials-clear' });
  assert.equal(results.children.length, 1);
});

test('account history restores and deduplicates results on SSE reconnection', () => {
  const panel = createPanel();
  const result = { id: 'restored', number: 4, status: 'success', companyName: '恢复公司', fullName: '王五', account: 'restored@example.com', password: 'RestoredPass123' };
  panel.emit({ type: 'history', logs: [], accountResults: [result] });
  const results = panel.node('#accountResults');
  assert.equal(results.children.length, 1);
  assert.match(results.textContent, /RestoredPass123/);
  panel.emit({ type: 'account-result', ...result });
  assert.equal(results.children.length, 1);
  panel.events.onerror();
  panel.events.onopen();
  panel.emit({ type: 'history', logs: [], accountResults: [result, { id: 'failed', number: 5, status: 'error', companyName: '恢复公司', fullName: '赵六', message: '手机号重复' }] });
  assert.equal(results.children.length, 1);
  assert.doesNotMatch(results.textContent, /手机号重复|添加失败/);
  assert.equal(panel.node('#accountFeedback').hidden, true);
  panel.emit({ type: 'history', logs: [], accountResults: [] });
  assert.equal(results.children.length, 0);
  assert.equal(results.hidden, true);
});

test('failed account history and incomplete success records do not produce empty result cards', () => {
  const panel = createPanel();
  panel.emit({ type: 'history', logs: [], accountResults: [{ id: 'failed', status: 'error', message: 'locator.waitFor: Timeout 15000ms exceeded. Call log: waiting for checkbox', phone: '13812345678' }] });
  panel.emit({ type: 'account-result', id: 'incomplete', status: 'success', account: 'incomplete@example.com' });
  assert.equal(panel.node('#accountResults').children.length, 0);
  assert.equal(panel.node('#accountResults').hidden, true);
  assert.equal(panel.node('#accountFeedback').hidden, true);
});

test('live account results retain only the latest 50 jobs without waiting for a reload', () => {
  const panel = createPanel();
  const results = panel.node('#accountResults');
  const entries = Array.from({ length: 52 }, (_, number) => ({ id: `job-${number}`, number, status: 'success', account: `member${number}@example.com`, password: `Password${number}` }));
  for (const entry of entries) panel.emit({ type: 'account-result', ...entry });
  assert.equal(results.children.length, 50);
  assert.equal(results.children[0].dataset.jobId, 'job-51');
  assert.equal(results.children.at(-1).dataset.jobId, 'job-2');
  assert.doesNotMatch(results.textContent, /member[01]@example.com/);
  panel.emit({ type: 'account-result', ...entries[51], message: '已恢复该任务结果' });
  assert.equal(results.children.length, 50);
  assert.match(results.children[0].textContent, /member51@example.com/);
  const failures = Array.from({ length: 52 }, (_, number) => ({ id: `failed-${number}`, status: 'error', message: '旧失败记录' }));
  for (const failure of failures) panel.emit({ type: 'account-result', ...failure });
  assert.equal(results.children.length, 50);
  panel.emit({ type: 'history', logs: [], accountResults: [...entries, ...failures] });
  assert.equal(results.children.length, 50);
  assert.equal(results.children[0].dataset.jobId, 'job-51');
});

test('copying account credentials confirms only after the clipboard write succeeds', async () => {
  let resolveCopy;
  let copiedText;
  const panel = createPanel({ clipboard: { writeText(text) { copiedText = text; return new Promise((resolve) => { resolveCopy = resolve; }); } } });
  panel.emit({ type: 'account-result', id: 'copy', number: 1, status: 'success', account: 'copy@example.com', password: 'CopyPass123' });
  const card = panel.node('#accountResults').children[0];
  const button = card.querySelector('button');
  const feedback = card.querySelector('.copy-feedback');
  const copy = button.dispatch('click');
  assert.equal(copiedText, '账号：copy@example.com\n密码：CopyPass123');
  assert.equal(button.disabled, true);
  assert.equal(feedback.textContent, '正在复制…');
  resolveCopy();
  await copy;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '已复制');
  assert.match(feedback.textContent, /已复制/);
});

test('denied clipboard access reveals and selects a manual copy field without claiming success', async () => {
  const panel = createPanel({ clipboard: { async writeText() { throw new Error('Not allowed'); } } });
  panel.emit({ type: 'account-result', id: 'copy-denied', number: 1, status: 'success', account: 'copy@example.com', password: 'CopyPass123' });
  const card = panel.node('#accountResults').children[0];
  const button = card.querySelector('button');
  await button.dispatch('click');
  assert.equal(button.textContent, '复制账号 + 密码');
  assert.match(card.querySelector('.copy-feedback').textContent, /请手动复制/);
  const fallback = card.querySelector('textarea');
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.readOnly, true);
  assert.equal(fallback.focused, true);
  assert.equal(fallback.selected, true);
  assert.equal(fallback.value, '账号：copy@example.com\n密码：CopyPass123');
});

test('a failed copy retry clears the previous successful copy label', async () => {
  let denied = false;
  const panel = createPanel({ clipboard: { async writeText() { if (denied) throw new Error('Not allowed'); } } });
  panel.emit({ type: 'account-result', id: 'copy-retry', number: 1, status: 'success', account: 'copy@example.com', password: 'CopyPass123' });
  const card = panel.node('#accountResults').children[0];
  const button = card.querySelector('button');
  await button.dispatch('click');
  assert.equal(button.textContent, '已复制');
  denied = true;
  await button.dispatch('click');
  assert.equal(button.textContent, '复制账号 + 密码');
  assert.match(card.querySelector('.copy-feedback').textContent, /复制未完成/);
});

test('adding rules sends the company name, service ID, and customer details for company fallback', async () => {
  for (const companyName of ['规则目标公司', '']) {
    const network = pendingRequests();
    const panel = createPanel(network);
    const customerText = '公司名称：客户资料公司\n邮箱：customer@example.com';
    panel.node('#addRuleCompanyName').value = companyName;
    panel.node('#addRuleServiceId').value = '8685';
    panel.node('#customerText').value = customerText;
    await panel.node('#rulePresets').childNodes[0].dispatch('click');

    const run = panel.runButtons.find((button) => button.dataset.task === 'add-rules').dispatch('click');
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].url, '/api/run');
    assert.equal(network.requests[0].body.task, 'add-rules');
    assert.equal(network.requests[0].body.addRuleCompanyName, companyName);
    assert.equal(network.requests[0].body.addRuleServiceId, '8685');
    assert.equal(network.requests[0].body.customerText, customerText);
    network.requests[0].finish({ ok: true, job: { number: 1, task: 'add-rules', profileName: 'test' } });
    await run;
  }
});

test('malformed SSE data is ignored and connection recovery updates the visible state', () => {
  const panel = createPanel();
  assert.doesNotThrow(() => panel.events.onmessage({ data: '{' }));
  assert.doesNotThrow(() => panel.events.onmessage({ data: 'null' }));
  panel.events.onerror();
  assert.match(panel.node('#statusText').textContent, /自动重连/);
  panel.events.onopen();
  panel.emit({ type: 'history', logs: ['restored'], running: true, task: 'test' });
  panel.frame();
  assert.equal(panel.node('#terminal').textContent, 'restored');
  assert.match(panel.node('#statusText').textContent, /运行中：test/);
});

test('complete rules shares saved presets and selection with traffic rules, using its own company', async () => {
  const storage = new Map([['controlPanelRulePresets', JSON.stringify([
    { name: '谷歌', rules: ['Google', 'Google 登录'] },
    { name: 'TK', rules: ['office365', 'TikTok跨境电商'] },
    { name: '社媒', rules: ['Facebook', 'whatsapp', 'Youtube', 'instagram', 'Linkedin'] },
  ])]]);
  const network = pendingRequests();
  const panel = createPanel({ ...network, storage });
  const traffic = panel.node('#rulePresets').childNodes;
  const complete = panel.node('#completeRulesPresets').childNodes;
  assert.deepEqual(complete.map((button) => button.textContent), ['谷歌', 'TK', '社媒']);
  await traffic[0].dispatch('click');
  await complete[1].dispatch('click');
  assert.equal(panel.node('#rulePresetName').value, 'TK');
  assert.equal(panel.node('#rulePresetRules').value, 'office365\nTikTok跨境电商');
  assert.equal(complete[0].attributes['aria-pressed'], 'true');
  assert.equal(traffic[1].attributes['aria-pressed'], 'true');
  await complete[0].dispatch('click');
  assert.equal(traffic[0].attributes['aria-pressed'], 'false');
  assert.match(panel.node('#completeRulesHint').textContent, /office365、TikTok跨境电商/);
  panel.node('#completeRulesCompanyName').value = '完善规程客户';
  panel.node('#addRuleCompanyName').value = '不同的流量规则客户';
  panel.node('#customerText').value = '公司名称：资料客户';
  const run = panel.runButtons.find((button) => button.dataset.task === 'complete-rules').dispatch('click');
  assert.equal(network.requests[0].body.completeRulesCompanyName, '完善规程客户');
  assert.equal(network.requests[0].body.customerText, '公司名称：资料客户');
  assert.deepEqual(network.requests[0].body.ruleNames, ['office365', 'TikTok跨境电商']);
  assert.equal(network.requests[0].body.addRuleServiceId, '');
  network.requests[0].finish({ ok: true, job: { number: 1, task: 'complete-rules', profileName: 'test' } });
  await run;

  panel.node('#rulePresetName').value = 'TK';
  await panel.node('#deleteRulePreset').dispatch('click');
  assert.deepEqual(panel.node('#completeRulesPresets').childNodes.map((button) => button.textContent), ['谷歌', '社媒']);
  assert.match(panel.node('#completeRulesHint').textContent, /请选择/);
  assert.deepEqual(createPanel({ storage }).node('#completeRulesPresets').childNodes.map((button) => button.textContent), ['谷歌', '社媒']);
});

for (const [task, fields, feedbackId] of taskRequirements) {
  test(`${task} blocks missing required inputs before starting a request`, async (t) => {
    for (const missingField of fields) {
      await t.test(missingField, async () => {
        const network = pendingRequests();
        const panel = createPanel(network);
        await fillTaskRequirements(panel, fields, missingField);
        const button = taskButton(panel, task);
        await button.dispatch('click');
        assert.equal(network.requests.length, 0);
        assert.equal(button.disabled, false);
        const error = panel.node(`#${missingField}Error`);
        assert.equal(error.hidden, false);
        assert.ok(error.textContent.trim());
        if (!missingField.endsWith('Presets')) {
          const input = panel.node(`#${missingField}`);
          assert.equal(input.getAttribute('aria-invalid'), 'true');
          assert.equal(input.focused, true);
          input.value = validFieldValues[missingField];
          await input.dispatch('input');
          assert.equal(error.hidden, true);
          assert.notEqual(input.getAttribute('aria-invalid'), 'true');
        }
      });
    }
  });

  test(`${task} shows the started job in its own card`, async () => {
    const network = pendingRequests();
    const panel = createPanel(network);
    await fillTaskRequirements(panel, fields);
    const run = taskButton(panel, task).dispatch('click');
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].body.task, task);
    network.requests[0].finish({ ok: true, job: { number: 73, task, profileName: 'test' } });
    await run;
    const feedback = panel.node(`#${feedbackId}`);
    assert.equal(feedback.hidden, false);
    if (task === 'add-account') {
      assert.match(feedback.textContent, /正在添加账号.*下方显示账号和密码/);
      assert.doesNotMatch(feedback.textContent, /任务|日志|73/);
    } else {
      assert.match(feedback.textContent, /已启动/);
      assert.match(feedback.textContent, /73/);
    }
  });
}

test('editing one invalid field keeps other missing fields visible and focuses the first input', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  await taskButton(panel, 'network-contract').dispatch('click');
  assert.equal(network.requests.length, 0);
  assert.equal(panel.node('#customerText').focused, true);
  assert.equal(panel.node('#ip').focused, false);
  assert.equal(panel.node('#ipError').hidden, false);
  panel.node('#customerText').value = validFieldValues.customerText;
  await panel.node('#customerText').dispatch('input');
  assert.equal(panel.node('#customerTextError').hidden, true);
  assert.equal(panel.node('#ipError').hidden, false);
  assert.equal(panel.node('#ip').getAttribute('aria-invalid'), 'true');
});

test('combined onboarding validation counts down as inputs are completed without submitting', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  const feedback = panel.node('#customerFeedback');
  await taskButton(panel, 'network-contract-rules').dispatch('click');
  assert.equal(feedback.hidden, false);
  assert.match(feedback.textContent, /3\s*项/);
  panel.node('#customerText').value = validFieldValues.customerText;
  await panel.node('#customerText').dispatch('input');
  assert.match(feedback.textContent, /2\s*项/);
  assert.equal(panel.node('#customerTextError').hidden, true);
  panel.node('#ip').value = validFieldValues.ip;
  await panel.node('#ip').dispatch('input');
  assert.match(feedback.textContent, /1\s*项/);
  assert.equal(panel.node('#ipError').hidden, true);
  await panel.node('#rulePresets').childNodes[0].dispatch('click');
  assert.equal(feedback.hidden, true);
  assert.equal(panel.node('#rulePresetsError').hidden, true);
  assert.equal(network.requests.length, 0);
});

test('an automatically received service ID clears the contract validation error without submitting', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  await taskButton(panel, 'contract-open').dispatch('click');
  assert.equal(panel.node('#contractIdError').hidden, false);
  assert.equal(panel.node('#contractFeedback').hidden, false);
  panel.emit({ type: 'network-acceleration-service-id', serviceId: 'service_8685-A' });
  assert.equal(panel.node('#contractId').value, 'service_8685-A');
  assert.equal(panel.node('#contractIdError').hidden, true);
  assert.notEqual(panel.node('#contractId').getAttribute('aria-invalid'), 'true');
  assert.equal(panel.node('#contractFeedback').hidden, true);
  assert.equal(network.requests.length, 0);
});

test('service IDs reject invalid characters and allow letters, numbers, underscores and hyphens', async () => {
  for (const [task, idField, fields] of [
    ['contract-open', 'contractId', ['contractId']],
    ['add-rules', 'addRuleServiceId', ['addRuleCompanyName', 'addRuleServiceId', 'rulePresets']],
  ]) {
    const network = pendingRequests();
    const panel = createPanel(network);
    await fillTaskRequirements(panel, fields);
    const input = panel.node(`#${idField}`);
    input.value = 'service id?';
    await taskButton(panel, task).dispatch('click');
    assert.equal(network.requests.length, 0);
    assert.equal(panel.node(`#${idField}Error`).hidden, false);
    input.value = 'service_8685-A';
    await input.dispatch('input');
    const run = taskButton(panel, task).dispatch('click');
    assert.equal(network.requests.length, 1);
    assert.equal(network.requests[0].body[idField], 'service_8685-A');
    network.requests[0].finish({ ok: true, job: { number: 1, task, profileName: 'test' } });
    await run;
  }
});

test('outbound parameters accept domain names, bracketed IPv6 and passwords containing colons', async () => {
  for (const ip of [
    '203.0.113.8:62001:account:pass:word',
    'proxy.example.com:62001:account:password',
    '[2001:db8::1]:62001:account:pass:word',
  ]) {
    const network = pendingRequests();
    const panel = createPanel(network);
    panel.node('#customerText').value = validFieldValues.customerText;
    panel.node('#ip').value = ip;
    const run = taskButton(panel, 'network-contract').dispatch('click');
    assert.equal(network.requests.length, 1, ip);
    assert.equal(network.requests[0].body.ip, ip);
    network.requests[0].finish({ ok: true, job: { number: 1, task: 'network-contract', profileName: 'test' } });
    await run;
  }
});

test('invalid outbound parameters stay in the form and can be corrected before retrying', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#customerText').value = validFieldValues.customerText;
  panel.node('#ip').value = 'missing-port-and-account';
  await taskButton(panel, 'network-contract').dispatch('click');
  assert.equal(network.requests.length, 0);
  assert.equal(panel.node('#ip').value, 'missing-port-and-account');
  assert.equal(panel.node('#ipError').hidden, false);
  assert.equal(panel.node('#ip').focused, true);
  panel.node('#ip').value = validFieldValues.ip;
  await panel.node('#ip').dispatch('input');
  assert.equal(panel.node('#ipError').hidden, true);
  const run = taskButton(panel, 'network-contract').dispatch('click');
  assert.equal(network.requests.length, 1);
  network.requests[0].finish({ ok: true, job: { number: 1, task: 'network-contract', profileName: 'test' } });
  await run;
});

test('complete rules can read its company from customer details', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#customerText').value = validFieldValues.customerText;
  await panel.node('#completeRulesPresets').childNodes[0].dispatch('click');
  const run = taskButton(panel, 'complete-rules').dispatch('click');
  assert.equal(network.requests.length, 1);
  assert.equal(network.requests[0].body.completeRulesCompanyName, '');
  assert.equal(network.requests[0].body.customerText, validFieldValues.customerText);
  network.requests[0].finish({ ok: true, job: { number: 1, task: 'complete-rules', profileName: 'test' } });
  await run;
});

test('server errors appear in the task card and restore the start button for a retry', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#contractId').value = validFieldValues.contractId;
  const button = taskButton(panel, 'contract-open');
  const originalText = button.textContent;
  const first = button.dispatch('click');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  await button.dispatch('click');
  assert.equal(network.requests.length, 1);
  network.requests[0].finish({ ok: false, error: '该合约暂时无法开通，请稍后重试。' });
  await first;
  assert.equal(panel.node('#contractFeedback').hidden, false);
  assert.match(panel.node('#contractFeedback').textContent, /该合约暂时无法开通，请稍后重试。/);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  assert.equal(button.textContent, originalText);
  assert.equal(panel.node('#contractId').value, validFieldValues.contractId);
  const retry = button.dispatch('click');
  assert.equal(network.requests.length, 2);
  network.requests[1].finish({ ok: true, job: { number: 2, task: 'contract-open', profileName: 'test' } });
  await retry;
  assert.match(panel.node('#contractFeedback').textContent, /已启动/);
  assert.doesNotMatch(panel.node('#contractFeedback').textContent, /暂时无法开通/);
});

test('an earlier request finishing late cannot replace the latest task feedback in the same card', async () => {
  for (const earlierResult of [
    { ok: true, job: { number: 11, task: 'add-user', profileName: 'test' } },
    { ok: false, error: '较早请求失败' },
  ]) {
    const network = pendingRequests();
    const panel = createPanel(network);
    panel.node('#customerText').value = validFieldValues.customerText;
    const earlier = taskButton(panel, 'add-user').dispatch('click');
    const latest = taskButton(panel, 'network-acceleration').dispatch('click');
    assert.equal(network.requests.length, 2);
    network.requests[1].finish({ ok: true, job: { number: 22, task: 'network-acceleration', profileName: 'test' } });
    await latest;
    const latestFeedback = panel.node('#customerFeedback').textContent;
    assert.match(latestFeedback, /22/);
    network.requests[0].finish(earlierResult);
    await earlier;
    assert.equal(panel.node('#customerFeedback').textContent, latestFeedback);
    assert.equal(taskButton(panel, 'add-user').disabled, false);
    assert.equal(taskButton(panel, 'network-acceleration').disabled, false);
  }
});

test('generating Magic configuration without outbound parameters stays in the form', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  const button = panel.node('#generateMagicConfig');
  const originalText = button.textContent;
  await button.dispatch('click');
  assert.equal(network.requests.length, 0);
  assert.equal(panel.node('#ipError').hidden, false);
  assert.equal(panel.node('#ip').getAttribute('aria-invalid'), 'true');
  assert.equal(panel.node('#ip').focused, true);
  assert.equal(panel.node('#contractFeedback').hidden, false);
  assert.ok(panel.node('#contractFeedback').textContent.trim());
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, originalText);
});

for (const earlierOperation of ['magic-config', 'contract-open']) {
  test(`late ${earlierOperation} responses preserve the newer operation's contract feedback`, async () => {
    for (const fails of [false, true]) {
      const network = pendingRequests();
      const panel = createPanel(network);
      panel.node('#contractId').value = validFieldValues.contractId;
      panel.node('#ip').value = validFieldValues.ip;
      const magicButton = panel.node('#generateMagicConfig');
      const contractButton = taskButton(panel, 'contract-open');
      const magicFirst = earlierOperation === 'magic-config';
      const earlier = (magicFirst ? magicButton : contractButton).dispatch('click');
      const latest = (magicFirst ? contractButton : magicButton).dispatch('click');
      assert.equal(network.requests.length, 2);
      assert.equal(network.requests[0].url, magicFirst ? '/api/magic-config' : '/api/run');
      assert.equal(network.requests[1].url, magicFirst ? '/api/run' : '/api/magic-config');
      network.requests[1].finish(magicFirst
        ? { ok: true, job: { number: 22, task: 'contract-open', profileName: 'test' } }
        : { ok: true, config: 'latest generated configuration' });
      await latest;
      const latestFeedback = panel.node('#contractFeedback').textContent;
      assert.match(latestFeedback, magicFirst ? /已启动.*22/ : /Magic 配置已生成/);
      network.requests[0].finish(fails
        ? { ok: false, error: '较早操作失败' }
        : magicFirst
          ? { ok: true, config: 'earlier generated configuration' }
          : { ok: true, job: { number: 11, task: 'contract-open', profileName: 'test' } });
      await earlier;
      assert.equal(panel.node('#contractFeedback').textContent, latestFeedback);
      assert.equal(magicButton.disabled, false);
      assert.equal(contractButton.disabled, false);
    }
  });
}

test('a pending contract response cannot replace a newer Magic parameter validation error', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  panel.node('#contractId').value = validFieldValues.contractId;
  const contract = taskButton(panel, 'contract-open').dispatch('click');
  await panel.node('#generateMagicConfig').dispatch('click');
  assert.equal(network.requests.length, 1);
  assert.equal(panel.node('#ipError').hidden, false);
  const validationFeedback = panel.node('#contractFeedback').textContent;
  assert.ok(validationFeedback.trim());
  network.requests[0].finish({ ok: true, job: { number: 11, task: 'contract-open', profileName: 'test' } });
  await contract;
  assert.equal(panel.node('#contractFeedback').textContent, validationFeedback);
  assert.equal(panel.node('#ipError').hidden, false);
});

test('select all and clear keep both rule selectors and preparation status in sync', async () => {
  const storage = new Map([['controlPanelRulePresets', JSON.stringify([
    { name: '谷歌', rules: ['Google'] },
    { name: 'TK', rules: ['office365', 'TikTok跨境电商'] },
  ])]]);
  const panel = createPanel({ storage });
  await panel.node('#selectAllRules').dispatch('click');
  for (const id of ['#rulePresets', '#completeRulesPresets']) {
    assert.ok(panel.node(id).childNodes.every((button) => button.getAttribute('aria-pressed') === 'true'));
  }
  assert.match(panel.node('#selectedRuleHint').textContent, /Google/);
  assert.match(panel.node('#completeRulesHint').textContent, /TikTok跨境电商/);
  assert.equal(panel.node('#prepareRules').classList.contains('is-ready'), true);
  await panel.node('#clearSelectedRules').dispatch('click');
  for (const id of ['#rulePresets', '#completeRulesPresets']) {
    assert.ok(panel.node(id).childNodes.every((button) => button.getAttribute('aria-pressed') === 'false'));
  }
  assert.match(panel.node('#selectedRuleHint').textContent, /请选择/);
  assert.match(panel.node('#completeRulesHint').textContent, /请选择/);
  assert.equal(panel.node('#prepareRules').classList.contains('is-ready'), false);
});

test('the latest log button resumes following after the reader scrolls up', async () => {
  const panel = createPanel();
  const terminal = panel.node('#terminal');
  const follow = panel.node('#followTerminalButton');
  await panel.node('#consoleToggle').dispatch('click');
  panel.emit({ type: 'log', message: 'x'.repeat(1000) });
  panel.frame();
  assert.equal(follow.textContent, '跟随最新');
  terminal.scrollTop = 50;
  await terminal.dispatch('scroll');
  assert.equal(follow.textContent, '回到最新');
  panel.emit({ type: 'log', message: 'y'.repeat(100) });
  panel.frame();
  assert.equal(terminal.scrollTop, 50);
  await follow.dispatch('click');
  assert.equal(terminal.scrollTop, 1100);
  assert.equal(follow.textContent, '跟随最新');
  panel.emit({ type: 'log', message: 'z'.repeat(100) });
  panel.frame();
  assert.equal(terminal.scrollTop, 1200);
});

test('preparation shortcuts reflect current inputs and navigate without starting jobs', async () => {
  const network = pendingRequests();
  const panel = createPanel(network);
  for (const id of ['#prepareCustomer', '#prepareIp', '#prepareRules']) {
    assert.equal(panel.node(id).classList.contains('is-ready'), false);
    await panel.node(id).dispatch('click');
  }
  assert.equal(network.requests.length, 0);
  for (const [fieldId, preparationId] of [['#customerText', '#prepareCustomer'], ['#ip', '#prepareIp']]) {
    const input = panel.node(fieldId);
    input.value = '已填写';
    await input.dispatch('input');
    assert.equal(panel.node(preparationId).classList.contains('is-ready'), true);
    input.value = '   ';
    await input.dispatch('input');
    assert.equal(panel.node(preparationId).classList.contains('is-ready'), false);
  }
  await panel.node('#rulePresets').childNodes[0].dispatch('click');
  assert.equal(panel.node('#prepareRules').classList.contains('is-ready'), true);
  await panel.node('#completeRulesPresets').childNodes[0].dispatch('click');
  assert.equal(panel.node('#prepareRules').classList.contains('is-ready'), false);
  assert.equal(network.requests.length, 0);
});
