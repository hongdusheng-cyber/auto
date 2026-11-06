import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chromium } from 'playwright';
import { submitWarehouseRecord } from '../scripts/device-warehouse-outbound.mjs';

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function createFixture(t, { outsideViewport = false, animated = false, buttonAttributes = '' } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  t.after(() => page.close());
  await page.setContent(`<!doctype html><html lang="zh"><meta charset="utf-8">
    <style>
      html, body { margin: 0; overflow: hidden; }
      .ant-drawer-content-wrapper {
        position: fixed; top: ${outsideViewport ? 900 : 20}px; left: 20px;
        width: 400px; padding: 20px; background: white;
        ${animated ? 'transform: translateX(1000px); animation: enter 180ms 50ms forwards;' : ''}
      }
      button { padding: 12px; }
      @keyframes enter { to { transform: translateX(0); } }
    </style>
    <div class="ant-drawer-content-wrapper">
      <h2>修改设备记录</h2>
      <button id="submit" ${buttonAttributes}>修改记录</button>
      <button id="other">查看修改记录</button>
    </div>
    <script>
      window.submitClicks = 0;
      window.otherClicks = 0;
      window.clickTrusted = [];
      document.getElementById('submit').addEventListener('click', event => {
        window.submitClicks++;
        window.clickTrusted.push(event.isTrusted);
      });
      document.getElementById('other').addEventListener('click', () => window.otherClicks++);
    </script>
  </html>`);
  return { page, drawer: page.locator('.ant-drawer-content-wrapper') };
}

async function clickState(page) {
  return page.evaluate(() => ({
    submitClicks: window.submitClicks,
    otherClicks: window.otherClicks,
    clickTrusted: window.clickTrusted,
  }));
}

test('warehouse submit clicks the exact visible submit button once', async (t) => {
  const { page, drawer } = await createFixture(t);
  await submitWarehouseRecord(drawer, { timeoutMs: 1000 });
  assert.deepEqual(await clickState(page), { submitClicks: 1, otherClicks: 0, clickTrusted: [true] });
});

test('warehouse submit clicks a fixed button below the viewport once', async (t) => {
  const { page, drawer } = await createFixture(t, { outsideViewport: true });
  const button = drawer.getByRole('button', { name: '修改记录', exact: true });
  assert.ok((await button.boundingBox()).y > 600);
  await assert.rejects(button.click({ force: true, timeout: 200 }), /outside of the viewport/);
  assert.equal((await clickState(page)).submitClicks, 0);
  await submitWarehouseRecord(drawer, { timeoutMs: 200 });
  assert.deepEqual(await clickState(page), { submitClicks: 1, otherClicks: 0, clickTrusted: [false] });
});

test('warehouse submit waits for a drawer animation and dispatches only one real click', async (t) => {
  const { page, drawer } = await createFixture(t, { animated: true });
  await submitWarehouseRecord(drawer, { timeoutMs: 1500 });
  assert.deepEqual(await clickState(page), { submitClicks: 1, otherClicks: 0, clickTrusted: [true] });
});

for (const [name, buttonAttributes] of [
  ['disabled', 'disabled'],
  ['ARIA disabled', 'aria-disabled="true"'],
  ['ARIA busy', 'aria-busy="true"'],
  ['loading', 'class="ant-btn-loading"'],
]) {
  test(`warehouse submit never activates an offscreen ${name} button`, async (t) => {
    const { page, drawer } = await createFixture(t, { outsideViewport: true, buttonAttributes });
    await assert.rejects(submitWarehouseRecord(drawer, { timeoutMs: 200 }));
    assert.deepEqual(await clickState(page), { submitClicks: 0, otherClicks: 0, clickTrusted: [] });
  });
}

function withClickOverride(drawer, click) {
  return {
    getByRole(role, options) {
      const locator = drawer.getByRole(role, options);
      return new Proxy(locator, {
        get(target, property) {
          if (property === 'click') return (clickOptions) => click(target, clickOptions);
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

test('warehouse submit propagates a non-geometric trial failure without submitting', async (t) => {
  const { page, drawer } = await createFixture(t);
  const failure = new Error('locator.click: Target page, context or browser has been closed');
  const calls = [];
  const controlledDrawer = withClickOverride(drawer, async (_button, options) => {
    calls.push(options);
    throw failure;
  });
  await assert.rejects(submitWarehouseRecord(controlledDrawer, { timeoutMs: 200 }), (error) => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].trial, true);
  assert.deepEqual(await clickState(page), { submitClicks: 0, otherClicks: 0, clickTrusted: [] });
});

test('warehouse submit does not repeat a dispatched click when navigation later fails', async (t) => {
  const { page, drawer } = await createFixture(t);
  // A click can succeed before its navigation wait fails. Historical geometry
  // messages in that error's call log must not trigger another submission.
  const failure = new Error('locator.click: Timeout 200ms exceeded.\nCall log:\n  - element is outside of the viewport\n  - click action done\n  - waiting for scheduled navigations to finish');
  failure.name = 'TimeoutError';
  const calls = [];
  const controlledDrawer = withClickOverride(drawer, async (button, options) => {
    calls.push(options);
    await button.click(options);
    if (!options.trial) throw failure;
  });
  await assert.rejects(submitWarehouseRecord(controlledDrawer, { timeoutMs: 200 }), (error) => error === failure);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].trial, true);
  assert.ok(!calls[1].trial);
  assert.deepEqual(await clickState(page), { submitClicks: 1, otherClicks: 0, clickTrusted: [true] });
});
