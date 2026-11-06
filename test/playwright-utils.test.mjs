import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  getPlaywrightSlowMo,
  runAndWaitForActivePage,
  waitForPageFullyLoaded,
} from '../scripts/playwright-utils.mjs';

class FakePage extends EventEmitter {
  constructor(url = 'https://example.test/admin') {
    super();
    this.currentUrl = url;
    this.broughtToFront = 0;
    this.loadStateWaits = 0;
    this.frame = {};
  }

  url() {
    return this.currentUrl;
  }

  mainFrame() {
    return this.frame;
  }

  navigate(url) {
    this.currentUrl = url;
    this.emit('framenavigated', this.frame);
  }

  async bringToFront() {
    this.broughtToFront += 1;
  }

  async waitForLoadState(state, options) {
    this.loadStateWaits += 1;
    this.loadStateOptions = { state, ...options };
  }
}

class FakeContext extends EventEmitter {}

test('disables Playwright slow motion by default and accepts an explicit override', () => {
  assert.equal(getPlaywrightSlowMo(undefined), 0);
  assert.equal(getPlaywrightSlowMo('40'), 40);
  assert.equal(getPlaywrightSlowMo('-1'), 0);
  assert.equal(getPlaywrightSlowMo('invalid'), 0);
});

test('waits for network idle and a short render settle window', async () => {
  const calls = [];
  const page = {
    async waitForLoadState(state, options) {
      calls.push(['load-state', state, options]);
    },
    async waitForTimeout(milliseconds) {
      calls.push(['timeout', milliseconds]);
    },
  };

  await waitForPageFullyLoaded(page, { timeoutMs: 1234, settleMs: 567 });

  assert.deepEqual(calls, [
    ['load-state', 'networkidle', { timeout: 1234 }],
    ['timeout', 567],
  ]);
});

test('continues on same-page navigation without waiting for the popup timeout', async () => {
  const context = new FakeContext();
  const page = new FakePage();

  const activePage = await runAndWaitForActivePage(context, page, async () => {
    assert.equal(context.listenerCount('page'), 1, 'popup listener must exist before the click');
    page.navigate('https://example.test/manage');
  }, { timeoutMs: 1000 });

  assert.equal(activePage, page);
  assert.equal(page.broughtToFront, 1);
  assert.equal(page.loadStateWaits, 1);
  assert.deepEqual(page.loadStateOptions, { state: 'domcontentloaded', timeout: 1000 });
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('uses a newly opened page when the click creates a popup', async () => {
  const context = new FakeContext();
  const page = new FakePage();
  const popup = new FakePage('https://example.test/manage');

  const activePage = await runAndWaitForActivePage(context, page, async () => {
    context.emit('page', popup);
  }, { timeoutMs: 1000 });

  assert.equal(activePage, popup);
  assert.equal(popup.broughtToFront, 1);
  assert.equal(popup.loadStateWaits, 1);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
});

test('removes pending navigation listeners when the action fails', async () => {
  const context = new FakeContext();
  const page = new FakePage();
  const failure = new Error('click failed');

  await assert.rejects(runAndWaitForActivePage(context, page, async () => {
    throw failure;
  }), failure);

  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
  assert.equal(page.listenerCount('close'), 0);
  assert.equal(page.broughtToFront, 0);
});

test('falls back to the current page after the timeout and ignores iframe navigation', async () => {
  const context = new FakeContext();
  const page = new FakePage();
  const activePage = await runAndWaitForActivePage(context, page, async () => {
    page.emit('framenavigated', {});
  }, { timeoutMs: 5 });

  assert.equal(activePage, page);
  assert.equal(context.listenerCount('page'), 0);
  assert.equal(page.listenerCount('framenavigated'), 0);
  assert.equal(page.listenerCount('close'), 0);
});
