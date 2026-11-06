import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  collectNetworkAccelerationServices,
  collectObjectsWithIds,
  describeCreatedServiceCandidates,
  pickCreatedServiceFromCards,
  pickCreatedServiceFromRecords,
  responseBodyLooksFailed,
  shouldRequestServiceId,
  waitForCreatedServiceId,
} from '../scripts/network-acceleration.mjs';

test('only requests a service ID when a result file is explicitly provided', () => {
  assert.equal(shouldRequestServiceId(null), false);
  assert.equal(shouldRequestServiceId(''), false);
  assert.equal(shouldRequestServiceId('   '), false);
  assert.equal(shouldRequestServiceId('/tmp/network-result.json'), true);
});

const options = { bandwidth: '5M', packageName: '基础版-5M' };

test('only the new pending card with matching bandwidth and location supplies the ID', () => {
  const card = (id, text, status = '待开通') => ({ id, text, status });
  const cards = [
    card('8960', '基础版-5M-新美国'),
    card('8970', '基础版-15M-新美国'),
    card('8971', '基础版-5M-日本 PRO'),
    card('8972', '基础版-5M-新美国', '已启动'),
    card('8973', '基础版-5M-新美国 8973 ID: 8973 产品带宽 5Mbps'),
  ];
  const selected = { ...options, selectedLocation: '新美国' };
  const existing = new Set(['8960']);
  assert.equal(pickCreatedServiceFromCards(cards, selected, existing), '8973');
  assert.equal(pickCreatedServiceFromCards(cards, selected, existing, '8973'), '8973');
  for (const id of ['8960', '8970', '8971', '8972', '9999']) {
    assert.equal(pickCreatedServiceFromCards(cards, selected, existing, id), null);
  }
  const ambiguous = [...cards, card('8974', '基础版-5M-新美国')];
  assert.throws(() => pickCreatedServiceFromCards(ambiguous, selected, existing), /多个新建/);
  assert.equal(pickCreatedServiceFromCards(ambiguous, selected, existing, '8973'), '8973');
  assert.equal(pickCreatedServiceFromCards([], selected, existing), null);
});

test('card extraction keeps neighboring IDs, pending states and bandwidths separate', async () => {
  class Element {
    constructor(text = '', children = [], className = '', visible = true) {
      Object.assign(this, { text, children, className, visible });
      for (const child of children) child.parentElement = this;
    }
    get textContent() { return [this.text, ...this.children.map((child) => child.textContent)].join(' '); }
    get innerText() { return this.textContent; }
    getBoundingClientRect() { return { width: 316, height: this.className === 'card' ? 214 : 20 }; }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector.split(',').some((part) => current.className.split(/\s+/).includes(part.trim().slice(1)))) return current;
      }
      return null;
    }
  }
  const makeCard = (id, bandwidth, status, visible = true) => new Element('', [
    new Element(`基础版-${bandwidth}M-新美国 ${id} ${status}`),
    new Element('', [new Element(`ID：${id}`)]),
    new Element(`产品带宽 ${bandwidth}Mbps 到期时间 2027-10-16 授权设备 0 台`),
  ], 'card', visible);
  const container = new Element('', [
    makeCard('897', 15, '已启动'), makeCard('8973', 5, '待开通'), makeCard('8974', 50, '待开通', false),
  ], 'service-list');
  const body = new Element('', [container]);
  const descendants = (element) => element.children.flatMap((child) => [child, ...descendants(child)]);
  const page = { evaluate(fn) {
    return vm.runInNewContext(`(${fn.toString()})()`, {
      document: { body, querySelectorAll: () => descendants(body) },
      window: { getComputedStyle: (element) => ({
        display: element.visible ? 'block' : 'none', visibility: 'visible',
      }) },
    });
  } };
  const cards = JSON.parse(JSON.stringify(await collectNetworkAccelerationServices(page)));
  assert.deepEqual(cards.map(({ id, status }) => ({ id, status })), [
    { id: '897', status: '已启动' }, { id: '8973', status: '待开通' },
  ]);
  assert.equal(pickCreatedServiceFromCards(cards, options), '8973');
  assert.doesNotMatch(cards[0].text, /8973/);
});

// Mirrors the deployed OSASE structure: the ID lives inside a tall stats
// wrapper, while the status and location live in its sibling header.
function nestedCardsPage({ useKnownCardClass = true } = {}) {
  class Element {
    constructor(className, text = '', children = [], height = 20) {
      Object.assign(this, { className, text, children, height });
      for (const child of children) child.parentElement = this;
    }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    get innerText() { return [this.text, ...this.children.map((child) => child.innerText)].join('\n'); }
    getBoundingClientRect() { return { width: 270, height: this.height }; }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector.split(',').some((part) => current.className.split(/\s+/).includes(part.trim().slice(1)))) return current;
      }
      return null;
    }
  }
  const card = (id, name, bandwidth, status) => new Element(
    useKnownCardClass ? 'manage-shell__overview-card manage-shell__saas-service-card-action--interactive' : 'legacy-product-card', '', [
      new Element('manage-shell__overview-card-shell', '', [
        new Element('manage-shell__overview-card-header-wrap', '', [
          new Element('manage-shell__overview-card-title', `${name} ${id}`),
          new Element('manage-shell__overview-stat-label--status', status),
        ]),
        new Element('manage-shell__overview-stats-wrap', '', [
          new Element('manage-shell__overview-stats', '', [
            new Element('manage-shell__saas-service-name-row', '', [
              new Element('manage-shell__saas-service-name-main', '备注名称 设置'),
              new Element('manage-shell__overview-stat-value', `ID: ${id}`),
            ]),
            new Element('manage-shell__overview-stat', '', [
              new Element('manage-shell__overview-branch-name', '产品带宽'),
              new Element('manage-shell__overview-stat-bandwidth-value', `${bandwidth}Mbps`),
            ]),
            new Element('manage-shell__overview-stat', '到期时间 2027-10-16'),
            new Element('manage-shell__overview-stat', '授权设备 0 台'),
          ], 120),
        ], 140),
      ], 214),
    ], 214);
  const grid = new Element('manage-shell__saas-service-grid', '', [
    card('8681', '基础版-50M-日本 PRO', 50, '已启动'),
    card('8973', '基础版-5M-新美国', 5, '待开通'),
    card('8974', '基础版-20M-新加坡 PRO', 20, '待开通'),
    card('8975', '基础版-20M-新加坡 PRO', 20, '待开通'),
  ], 400);
  const body = new Element('', '', [grid]);
  const descendants = (element) => element.children.flatMap((child) => [child, ...descendants(child)]);
  return { evaluate(fn) {
    return vm.runInNewContext(`(${fn.toString()})()`, {
      document: { body, querySelectorAll: () => descendants(body) },
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    });
  } };
}

for (const useKnownCardClass of [true, false]) {
  test(`full cards include the sibling header above a card-sized stats panel (${useKnownCardClass ? 'deployed' : 'fallback'} layout)`, async () => {
    const cards = JSON.parse(JSON.stringify(await collectNetworkAccelerationServices(nestedCardsPage({ useKnownCardClass }))));
    assert.equal(cards.length, 4);
    assert.equal(cards[3].status, '待开通');
    assert.match(cards[3].text, /基础版-20M-新加坡 PRO/);
    assert.match(cards[3].text, /产品带宽/);
    const target = { bandwidth: '20M', selectedLocation: '新加坡 PRO' };
    assert.equal(pickCreatedServiceFromCards(cards, target, new Set(['8681', '8973', '8974'])), '8975');
    assert.throws(() => pickCreatedServiceFromCards(cards, target, new Set(['8681', '8973'])), /多个新建/);
  });
}

test('location formatting tolerates missing spaces while still rejecting a different region', () => {
  const cards = [{ id: '8975', text: '基础版-20M-新加坡PRO 产品带宽 20Mbps', status: '待开通' }];
  assert.equal(pickCreatedServiceFromCards(cards, { bandwidth: '20M', selectedLocation: '新加坡 PRO' }), '8975');
  assert.equal(pickCreatedServiceFromCards(cards, { bandwidth: '20M', selectedLocation: '日本 PRO' }), null);
});

test('a visible newly created card is used immediately without a reload', async () => {
  const cards = await collectNetworkAccelerationServices(nestedCardsPage());
  const result = await waitForCreatedServiceId({
    url: () => 'https://console.osase.net/manage/saas/index/application',
    waitForTimeout() { assert.fail('no polling needed'); },
  }, { bandwidth: '20M', selectedLocation: '新加坡 PRO' }, new Set(['8681', '8973', '8974']), null, {
    collectServices: async () => cards,
    openList: async () => assert.fail('must not discard already rendered cards'),
    log() {},
  });
  assert.equal(result, '8975');
});

test('waits for late rendering without continually reloading and logs rejection reasons', async () => {
  let reads = 0;
  let reloads = 0;
  const messages = [];
  const cards = await collectNetworkAccelerationServices(nestedCardsPage());
  const result = await waitForCreatedServiceId({
    url: () => 'https://console.osase.net/manage/saas/index/application',
    async waitForTimeout() {},
  }, { bandwidth: '20M', selectedLocation: '新加坡 PRO' }, new Set(['8681', '8973', '8974']), null, {
    collectServices: async () => ++reads < 6 ? cards.slice(0, 3) : cards,
    openList: async () => { reloads += 1; }, attempts: 6, retryDelayMs: 1,
    log: (message) => messages.push(message),
  });
  assert.equal(result, '8975');
  assert.equal(reloads, 1);
  assert.equal(messages.filter((message) => message.startsWith('已读取')).length, 1);
  assert.ok(messages.some((message) => message.includes('8974（创建前已存在')));
});

test('timeout explains candidate mismatches and does not trigger another purchase', async () => {
  const cards = [{ id: '8975', status: '', text: '产品带宽 20Mbps' }];
  const target = { bandwidth: '20M', selectedLocation: '新加坡 PRO' };
  const diagnostic = describeCreatedServiceCandidates(cards, target, new Set(), '9999');
  assert.match(diagnostic, /8975（与创建响应 ID 不符；状态未识别；位置不符/);
  const page = { url: () => 'https://console.osase.net/manage/saas/index/application', async waitForTimeout() {} };
  await assert.rejects(waitForCreatedServiceId(page, target, new Set(), '9999', {
    collectServices: async () => cards, attempts: 2, retryDelayMs: 1,
    openList: async () => assert.fail('must not reload on every retry'), log() {},
  }), /状态未识别.*不要重复运行创建流程/);
});

test('response wrappers cannot combine one service ID with another service bandwidth', () => {
  const records = collectObjectsWithIds({
    code: 0,
    data: { items: [
      { id: 8561, packageName: '基础版-15M', status: 'pending' },
      { id: 8562, packageName: '基础版-5M', status: 'pending' },
    ] },
  });
  assert.deepEqual(records.map((record) => record.id), ['8561', '8562']);
  assert.equal(pickCreatedServiceFromRecords(records, options), '8562');
});

test('nested plan IDs remain associated with their service record', () => {
  const records = collectObjectsWithIds({ data: [
    { service_id: 8562, package: { id: 991, name: '基础版-5M' } },
  ] });
  assert.deepEqual(records.map((record) => record.id), ['8562']);
  assert.equal(pickCreatedServiceFromRecords(records, options), '8562');
});

test('bandwidth selection uses complete numeric values and never a pending-only fallback', () => {
  for (const text of ['基础版-15M', '基础版-50M', '带宽 1.5Mbps', '待开通', '基础版-5MB']) {
    assert.equal(pickCreatedServiceFromRecords([{ id: '8562', text }], options), null, text);
  }
  for (const text of ['基础版-5M', '产品带宽 5Mbps', '带宽 5 M']) {
    assert.equal(pickCreatedServiceFromRecords([{ id: '8562', text }], options), '8562', text);
  }
});

test('multiple newly matching services are ambiguous even when one is pending', () => {
  const records = [
    { id: '8561', text: '基础版-5M 已启动' },
    { id: '8562', text: '基础版-5M pending' },
    { id: '8562', text: '产品带宽 5Mbps' },
  ];
  assert.equal(pickCreatedServiceFromRecords(records, options), null);
  assert.equal(pickCreatedServiceFromRecords(records, options, new Set(['8561'])), '8562');
  assert.equal(pickCreatedServiceFromRecords(records, options, new Set(['8561', '8562'])), null);
});

test('does not accept HTTP-success response bodies that report a business failure', () => {
  assert.equal(responseBodyLooksFailed({ success: false, message: '创建失败' }), true);
  assert.equal(responseBodyLooksFailed({ ok: false }), true);
  assert.equal(responseBodyLooksFailed({ status: 'failed' }), true);
  assert.equal(responseBodyLooksFailed({ code: 500, msg: '系统异常' }), true);
  assert.equal(responseBodyLooksFailed({ success: true, code: 0 }), false);
  assert.equal(responseBodyLooksFailed({ code: 200, data: {} }), false);
});
