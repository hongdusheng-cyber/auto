import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { HIDDEN_RULES_URL, completeHiddenRules, prepareHiddenRules, readCompleteRulesOptions } from '../scripts/complete-rules.mjs';
import { findHiddenRuleMatches, parseHiddenRuleLabel } from '../scripts/hidden-rule-matching.mjs';

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(rootDir, 'scripts', 'complete-rules.mjs');
const COMPANY = '示例客户有限公司';
const CATALOG = [
  '测试规则包2 (测试规则包2)',
  'Google (GL)',
  'Google 登录 (GLSIGNIN)',
  '抖音规则包 (office365)',
  'TikTok跨境电商 (TikTok跨境电商)',
  'TikTok跨境电商(黑名单) (TikTok跨境电商(黑名单))',
  '抖音规则包new (office365new)',
  'whatsapp (WA)',
  'Youtube (Y)',
  'Linkedin (Link)',
  'instagram (instagram)',
  'Facebook (Facebook)',
  'Twitter(X.com) (Twitter(X.com))',
  'Telegram (tG)',
  'Pinterest (Pin)',
  'Discord (DC)',
  'Anthropic(Claude) (Anthropic(Claude))',
  '中国大陆IPV4(黑名单) (中国大陆IPV4(黑名单))',
];

test('complete-rules CLI accepts company and selected applications without a service ID', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    script, '--company', COMPANY, '--rules', '["office365","TikTok跨境电商"]', '--dry-run-parse',
  ], { cwd: rootDir });
  assert.match(stdout, /公司名称：示例客户有限公司/);
  assert.match(stdout, /规则应用：office365、TikTok跨境电商/);
  assert.ok(stdout.includes(HIDDEN_RULES_URL));
});

test('complete-rules reads customer profiles and validates input before opening a browser', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'complete-rules-profile-'));
  try {
    const file = path.join(directory, 'customer.txt');
    await writeFile(file, `公司名称：${COMPANY}\n联系人：张先生\n`);
    assert.deepEqual(await readCompleteRulesOptions(['--file', file, '--rule', 'Google', '--rules', '["Google","Youtube"]']), {
      companyName: COMPANY, rules: ['Google', 'Youtube'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(readCompleteRulesOptions(['--rules', '["Google"]']), /公司名称/);
  await assert.rejects(readCompleteRulesOptions(['--company', COMPANY]), /至少选择一个/);
  await assert.rejects(readCompleteRulesOptions(['--company', COMPANY, '--rules', '[null]']), /字符串数组/);
  await assert.rejects(readCompleteRulesOptions(['--company', COMPANY, '--rules', '[broken']), /有效的 JSON/);
  assert.deepEqual(await readCompleteRulesOptions(['--company', COMPANY, '--rules', '测试规则包2']), {
    companyName: COMPANY, rules: ['测试规则包2'],
  });
});

test('rule names match exact backend/display names, prefer actual custom names and preserve parentheses', () => {
  assert.equal(findHiddenRuleMatches('谷歌', CATALOG)[0].label, 'Google (GL)');
  assert.equal(findHiddenRuleMatches('office365', CATALOG)[0].label, '抖音规则包 (office365)');
  assert.equal(findHiddenRuleMatches('谷歌', [...CATALOG, '谷歌 (自定义谷歌)'])[0].label, '谷歌 (自定义谷歌)');
  assert.equal(findHiddenRuleMatches('TikTok跨境电商', CATALOG).length, 1);
  assert.equal(findHiddenRuleMatches('测试规则包2', CATALOG).length, 1);
  assert.equal(findHiddenRuleMatches('TK', CATALOG)[0].label, 'TikTok跨境电商 (TikTok跨境电商)');
  assert.equal(findHiddenRuleMatches('Google', [...CATALOG, '另一个包 (Google)']).length, 2);
  assert.deepEqual(parseHiddenRuleLabel('Anthropic(Claude) (Anthropic(Claude))'), {
    label: 'Anthropic(Claude) (Anthropic(Claude))', backend: 'Anthropic(Claude)', display: 'Anthropic(Claude)',
  });
  assert.deepEqual(parseHiddenRuleLabel('自定义 (业务) (展示 (分组))'), {
    label: '自定义 (业务) (展示 (分组))', backend: '自定义 (业务)', display: '展示 (分组)',
  });
});

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

function fixtureHtml({
  companies = [`${COMPANY}分公司`, COMPANY], catalog = CATALOG, rejectSelections = false,
  collapseRulesAfterSelection = false, asyncCompanySearch = false, rejectCompanySelection = false,
  remoteCompanySearch = false, fetchCompanyRequests = false, reorderRulesAfterFirstSelection = false,
  submitBehavior = '',
} = {}) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
    body { font: 14px sans-serif; margin: 20px; }
    .ant-drawer-content-wrapper { width: 600px; padding: 20px; border: 1px solid #ccc; }
    [role=listbox] { max-height: 240px; overflow: auto; padding: 0; list-style: none; }
    [role=option] { padding: 8px; cursor: pointer; }
    .el-select__wrapper { position: relative; width: 440px; min-height: 40px; border: 1px solid #ccc; cursor: pointer; }
    .el-select__input { display: block; box-sizing: border-box; width: 100%; height: 40px; border: 0; padding: 8px; }
    .el-select__placeholder, #tags { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; background: white; }
    .el-select__placeholder span { display: flex; align-items: center; width: 100%; height: 100%; padding-left: 8px; }
    #tags:empty { display: none; }
    .el-select__tags-text { display: inline-block; padding: 4px; }
  </style><button id="open">添加企业隐藏规则包</button>
  <div class="ant-drawer-content-wrapper" style="display:none">
    <div class="ant-drawer-title">新建企业隐藏规则包</div>
    <p>企业</p><div class="company-field"><div class="el-select"><div class="el-select__wrapper">
      <input class="el-select__input" role="combobox" aria-controls="company-list" aria-expanded="false">
      <div class="el-select__selected-item el-select__placeholder is-transparent"><span>请输入关键词以搜索企业</span></div>
    </div></div></div>
    <p>隐藏规则包</p><div class="rules-field"><div class="el-select"><div class="el-select__wrapper">
      <input class="el-select__input" role="combobox" aria-controls="rules-list" aria-expanded="false">
      <div class="el-select__selected-item el-select__placeholder is-transparent"><span>请输入关键词以搜索隐藏规则包</span></div>
      <div id="tags"></div>
    </div></div></div>
    <button id="submit" disabled>添加</button>
  </div>
  <ul role="listbox" id="company-list" class="el-select-dropdown" style="display:none"></ul>
  <ul role="listbox" id="rules-list" class="el-select-dropdown" style="display:none"></ul>
  <script>
    const companies = ${JSON.stringify(companies)};
    let catalog = ${JSON.stringify(catalog)};
    const companyIds = new Map(companies.map((name, index) => [name, 1000 + index]));
    const ruleIds = new Map(catalog.map((name, index) => [name, 2000 + index]));
    const rejectSelections = ${JSON.stringify(rejectSelections)};
    const collapseRulesAfterSelection = ${JSON.stringify(collapseRulesAfterSelection)};
    const asyncCompanySearch = ${JSON.stringify(asyncCompanySearch)};
    const rejectCompanySelection = ${JSON.stringify(rejectCompanySelection)};
    const remoteCompanySearch = ${JSON.stringify(remoteCompanySearch)};
    const fetchCompanyRequests = ${JSON.stringify(fetchCompanyRequests)};
    const reorderRulesAfterFirstSelection = ${JSON.stringify(reorderRulesAfterFirstSelection)};
    const submitBehavior = ${JSON.stringify(submitBehavior)};
    const state = window.fixtureState = {
      company: null, rules: [], submitClicks: 0, opened: 0, searches: [],
      companyOptionClicks: 0, hiddenCompanyOptionClicks: 0, companyResultUpdates: 0,
      ruleDropdownOpens: 0, ruleSelectionCloses: 0, rulesOpenedBeforeCompanySelection: false,
      companyEvents: [], companyRequestErrors: [],
      ruleCatalogReorders: 0,
      submitPayloads: [], submitResponseReceived: false, submitErrors: [],
    };
    const drawer = document.querySelector('.ant-drawer-content-wrapper');
    const companyInput = document.querySelector('.company-field input');
    const ruleInput = document.querySelector('.rules-field input');
    let companyList = document.getElementById('company-list');
    const ruleList = document.getElementById('rules-list');
    const submit = document.getElementById('submit');
    let readyCompanyQuery = '';
    let previousCompanyQuery = null;
    function hideLists() {
      for (const list of [companyList, ruleList]) list.style.display = 'none';
      for (const input of [companyInput, ruleInput]) input.setAttribute('aria-expanded', 'false');
    }
    function toggleList(input, list, render) {
      const wasOpen = input.getAttribute('aria-expanded') === 'true';
      hideLists();
      if (wasOpen) return;
      render();
      // A remote Element Plus select can be expanded while its list remains
      // hidden until a nonempty query has returned results.
      if (list !== companyList || !remoteCompanySearch) list.style.display = 'block';
      input.setAttribute('aria-expanded', 'true');
      if (list === ruleList) {
        state.ruleDropdownOpens++;
        if (!state.company) state.rulesOpenedBeforeCompanySelection = true;
      }
      input.focus();
    }
    function updateSubmit() { submit.disabled = !state.company || !state.rules.length; }
    function renderCompanies(searchReady = !asyncCompanySearch || !companyInput.value || readyCompanyQuery === companyInput.value, remoteMatches) {
      if (fetchCompanyRequests && !remoteMatches) return;
      companyList.replaceChildren();
      let matches = remoteMatches ?? companies.filter(name => name.includes(companyInput.value));
      if (asyncCompanySearch && companyInput.value) {
        // Keep an old hidden result while remote results arrive in a different order.
        const stale = document.createElement('li');
        stale.setAttribute('role', 'option'); stale.style.display = 'none';
        stale.textContent = companyInput.value;
        stale.onclick = () => state.hiddenCompanyOptionClicks++;
        companyList.append(stale);
        matches = searchReady ? matches.toReversed() : matches.filter(name => name !== companyInput.value);
      }
      for (const name of matches) {
        const option = document.createElement('li');
        option.className = 'el-select-dropdown__item';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const span = document.createElement('span'); span.textContent = name; option.append(span);
        option.onclick = () => {
          state.companyOptionClicks++;
          const placeholder = document.querySelector('.company-field .el-select__placeholder');
          placeholder.querySelector('span').textContent = name; placeholder.style.display = 'flex';
          if (rejectCompanySelection) return;
          state.company = name; companyInput.value = '';
          placeholder.classList.remove('is-transparent');
          option.setAttribute('aria-selected', 'true'); hideLists(); updateSubmit();
        };
        companyList.append(option);
      }
    }
    async function fetchCompanies(query) {
      state.companyEvents.push('request:' + query);
      try {
        const response = await fetch('/admin/organize/list?keyword=' + encodeURIComponent(query));
        const data = await response.json();
        if (data.loginRequired) {
          const expiredStates = JSON.parse(sessionStorage.getItem('expiredFixtureStates') ?? '[]');
          expiredStates.push(state);
          sessionStorage.setItem('expiredFixtureStates', JSON.stringify(expiredStates));
          location.assign('/admin/login/account');
          return;
        }
        // Deliberately apply every response, including a late initialization
        // response whose keyword no longer matches the current input.
        renderCompanies(true, data.companies);
        if (companyInput.getAttribute('aria-expanded') === 'true') companyList.style.display = 'block';
        state.companyEvents.push('applied:' + query);
      } catch (error) {
        state.companyRequestErrors.push(error.message);
      }
    }
    function requestCompanyQuery(query) {
      if (previousCompanyQuery === query) return;
      previousCompanyQuery = query;
      void fetchCompanies(query);
    }
    function renderRules() {
      ruleList.replaceChildren();
      for (const name of catalog.filter(name => name.toLowerCase().includes(ruleInput.value.toLowerCase()))) {
        const option = document.createElement('li');
        option.className = 'el-select-dropdown__item';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(state.rules.includes(name)));
        const span = document.createElement('span'); span.textContent = name; option.append(span);
        option.onclick = () => {
          if (rejectSelections) return;
          if (state.rules.includes(name)) state.rules = state.rules.filter(rule => rule !== name);
          else state.rules.push(name);
          option.setAttribute('aria-selected', String(state.rules.includes(name)));
          document.getElementById('tags').replaceChildren(...state.rules.map(rule => {
            const tag = document.createElement('span'); tag.className = 'el-select__tags-text'; tag.textContent = rule; return tag;
          }));
          document.querySelector('.rules-field .el-select__placeholder').style.display = state.rules.length ? 'none' : 'flex';
          if (reorderRulesAfterFirstSelection && state.ruleCatalogReorders === 0) {
            state.ruleCatalogReorders++;
            catalog = catalog.toReversed();
            renderRules();
          }
          if (collapseRulesAfterSelection) { state.ruleSelectionCloses++; hideLists(); }
          updateSubmit();
        };
        ruleList.append(option);
      }
    }
    document.getElementById('open').onclick = () => {
      state.opened++; drawer.style.display = 'block';
      if (fetchCompanyRequests) void fetchCompanies('');
    };
    document.querySelector('.ant-drawer-title').onclick = hideLists;
    document.querySelector('.company-field .el-select__wrapper').onclick = () => {
      toggleList(companyInput, companyList, renderCompanies);
      // Mounted loading bypasses ElSelect's previousQuery cache. Opening an
      // empty select therefore sends an additional empty remote query.
      if (fetchCompanyRequests && companyInput.getAttribute('aria-expanded') === 'true') {
        requestCompanyQuery(companyInput.value);
      }
    };
    companyInput.oninput = () => {
      state.searches.push(companyInput.value);
      state.companyEvents.push('input:' + companyInput.value);
      readyCompanyQuery = '';
      document.querySelector('.company-field .el-select__placeholder').style.display = companyInput.value ? 'none' : 'flex';
      renderCompanies();
      if (companyInput.value) {
        companyInput.setAttribute('aria-expanded', 'true');
        if (!remoteCompanySearch) companyList.style.display = 'block';
      }
      if (remoteCompanySearch) {
        companyList.style.display = 'none';
        companyInput.setAttribute('aria-expanded', 'true');
        if (!companyInput.value) return;
      }
      if (fetchCompanyRequests) {
        requestCompanyQuery(companyInput.value);
        return;
      }
      if (asyncCompanySearch || remoteCompanySearch) {
        const query = companyInput.value;
        setTimeout(() => {
          if (companyInput.value !== query) return;
          state.companyResultUpdates++;
          readyCompanyQuery = query;
          if (remoteCompanySearch) {
            // Keep the old, populated UL hidden, as detached/stale dropdowns
            // must not be mistaken for the current remote search results.
            const nextList = companyList.cloneNode(false);
            nextList.id = 'company-list-search-' + state.companyResultUpdates;
            companyList.after(nextList);
            companyList = nextList;
            companyInput.setAttribute('aria-controls', companyList.id);
          }
          renderCompanies(true);
          if (remoteCompanySearch) companyList.style.display = 'block';
        }, 40);
      }
    };
    document.querySelector('.rules-field .el-select__wrapper').onclick = () => toggleList(ruleInput, ruleList, renderRules);
    ruleInput.oninput = renderRules;
    submit.onclick = async () => {
      state.submitClicks++;
      if (!submitBehavior) { drawer.style.display = 'none'; return; }
      const payload = {
        org_id: companyIds.get(state.company),
        saas_rule_package_ids: state.rules.map(rule => ruleIds.get(rule)),
      };
      state.submitPayloads.push(payload);
      submit.disabled = true;
      try {
        const response = await fetch('/admin/tools/hide-saas-rule-package-add', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        const data = await response.json();
        state.submitResponseReceived = true;
        if (data.loginRequired) {
          sessionStorage.setItem('submittedFixtureState', JSON.stringify(state));
          location.assign('/admin/login/account');
          return;
        }
        if (response.ok && data.code === 0) {
          if (submitBehavior !== 'success-with-open-drawer') drawer.style.display = 'none';
        } else state.submitErrors.push(data.message ?? '请求失败');
      } catch (error) {
        state.submitErrors.push(error.message);
      } finally {
        updateSubmit();
      }
    };
    if (remoteCompanySearch) renderCompanies();
  </script></html>`;
}

async function withFixture(fixtureOptions, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(1000);
  let expiredCompanyRequestCount = 0;
  const heldInitialCompanyRequests = [];
  const submitRequests = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin/login/account') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh"><meta charset="utf-8"><h1>登录</h1></html>' });
      return;
    }
    if (url.pathname === '/admin/tools/hide-saas-rule-package-add') {
      submitRequests.push({ method: route.request().method(), payload: route.request().postDataJSON() });
      if (fixtureOptions.submitBehavior === 'pending') return;
      await delay(30);
      if (fixtureOptions.submitBehavior === 'business-error') {
        await route.fulfill({ json: { code: 409, message: '企业规则包已存在' } });
      } else if (fixtureOptions.submitBehavior === 'http-error') {
        await route.fulfill({ status: 500, json: { code: 0, message: '服务暂不可用' } });
      } else if (fixtureOptions.submitBehavior === 'invalid-json') {
        await route.fulfill({ contentType: 'application/json', body: '<html>upstream error</html>' });
      } else if (fixtureOptions.submitBehavior === 'login') {
        await route.fulfill({ status: 401, json: { code: 401, message: '登录失效', loginRequired: true } });
      } else {
        await route.fulfill({ json: { code: 0, data: null, message: '添加成功' } });
      }
      return;
    }
    if (fixtureOptions.fetchCompanyRequests && url.pathname === '/admin/organize/list') {
      const query = url.searchParams.get('keyword') ?? '';
      if (query && expiredCompanyRequestCount < (fixtureOptions.expireCompanyRequests ?? 0)) {
        expiredCompanyRequestCount++;
        await delay(300);
        await route.fulfill({ status: 401, json: { loginRequired: true } });
        return;
      }
      if (!query && fixtureOptions.holdInitialCompanyRequest) {
        heldInitialCompanyRequests.push(route);
        return;
      }
      await delay(query ? 10 : fixtureOptions.initialCompanyDelayMs ?? 200);
      const companies = query
        ? fixtureOptions.companies.filter(name => name.includes(query))
        : ['unrelated initial company'];
      await route.fulfill({ json: { companies } });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: fixtureHtml(fixtureOptions) });
  });
  try {
    await run(page, {
      timeoutMs: 400, pollIntervalMs: 10, settleMs: 10,
      async waitForLogin(_page, options) {
        assert.equal(options.targetUrl, HIDDEN_RULES_URL);
        await options.readyLocator.waitFor({ state: 'visible' });
      },
    }, {
      submitRequests,
      get pendingInitialCompanyRequests() { return heldInitialCompanyRequests.length; },
      async releaseInitialCompanyRequests() {
        for (const route of heldInitialCompanyRequests.splice(0)) {
          await route.fulfill({ json: { companies: ['unrelated initial company'] } });
        }
      },
    });
  } finally {
    await context.close();
  }
}

test('prepares Google, TK, social and custom rules with exact company selection and never submits', async () => {
  await withFixture({}, async (page, options) => {
    const result = await prepareHiddenRules(page, {
      companyName: COMPANY,
      rules: ['谷歌', 'Google 登录', 'office365', 'TikTok跨境电商', 'WA', 'Y', 'Link', 'instagram', 'Facebook', 'Twitter', 'Telegram', 'Pinterest', 'Discord', 'Anthropic(Claude)', 'GL'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.company, COMPANY);
    assert.ok(state.searches.includes(COMPANY));
    assert.equal(state.submitClicks, 0);
    assert.equal(state.rules.length, 14, 'aliases resolving to the same package must not toggle it off');
    assert.ok(!state.rules.some(rule => /黑名单|测试|new/.test(rule)));
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(result.rules.length, 14);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('#rules-list').isVisible(), false);
  });
});

test('prepares obscured Element Plus selectors and reopens the rules dropdown after each selection', async () => {
  await withFixture({ collapseRulesAfterSelection: true }, async (page, options) => {
    await page.goto(HIDDEN_RULES_URL);
    await page.getByRole('button', { name: '添加企业隐藏规则包', exact: true }).click();
    for (const field of ['company', 'rules']) {
      const coveredByPlaceholder = await page.locator(`.${field}-field input`).evaluate((input) => {
        const rect = input.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit?.tagName === 'SPAN' && Boolean(hit.closest('.el-select__placeholder'));
      });
      assert.equal(coveredByPlaceholder, true, `${field} input must actually be covered by its placeholder`);
    }

    const result = await prepareHiddenRules(page, {
      companyName: COMPANY, rules: ['谷歌', 'TK', 'WA'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.company, COMPANY);
    assert.deepEqual(state.rules, ['Google (GL)', 'TikTok跨境电商 (TikTok跨境电商)', 'whatsapp (WA)']);
    assert.equal(state.ruleSelectionCloses, 3);
    assert.equal(state.ruleDropdownOpens, 3);
    assert.equal(await page.locator('.rules-field input').evaluate((input) => {
      const rect = input.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('#tags'));
    }), true, 'selected rule tags must cover the input when reopening the dropdown');
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(result.rules.length, 3);
    assert.equal(state.submitClicks, 0);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
    assert.equal(await page.locator('#rules-list').isVisible(), false);
  });
});

test('waits for asynchronous company search and clicks the visible exact company before opening rules', async () => {
  await withFixture({ asyncCompanySearch: true }, async (page, options) => {
    const result = await prepareHiddenRules(page, { companyName: COMPANY, rules: ['Google'] }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(state.searches, [COMPANY]);
    assert.equal(state.companyResultUpdates, 1, 'must wait for the remote search results');
    assert.equal(state.companyOptionClicks, 1, 'typing must be followed by clicking a company option');
    assert.equal(state.hiddenCompanyOptionClicks, 0, 'an old hidden company option must not be selected');
    assert.equal(state.company, COMPANY, 'the similar branch company must not be selected');
    assert.equal(state.rulesOpenedBeforeCompanySelection, false);
    assert.equal(state.ruleDropdownOpens, 1);
    assert.equal(await page.locator('.company-field input').inputValue(), '');
    assert.equal(await page.locator('.company-field input').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(state.rules, ['Google (GL)']);
    assert.equal(state.submitClicks, 0);
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
  });
});

test('types the company before waiting for remote-only results and follows the refreshed listbox', async () => {
  await withFixture({
    companies: ['test branch', 'test'], asyncCompanySearch: true, remoteCompanySearch: true,
  }, async (page, options) => {
    await page.goto(HIDDEN_RULES_URL);
    await page.getByRole('button', { name: '添加企业隐藏规则包', exact: true }).click();
    await page.locator('.company-field .el-select__wrapper').click();
    assert.equal(await page.locator('.company-field input').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#company-list').isVisible(), false,
      'expanding an empty remote selector must not reveal the company list');
    assert.equal(await page.locator('#company-list [role="option"]').count(), 2,
      'the hidden list deliberately has stale children before typing');

    const result = await prepareHiddenRules(page, {
      companyName: 'test', rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(state.searches, ['test']);
    assert.equal(state.companyResultUpdates, 1);
    assert.equal(await page.locator('.company-field input').getAttribute('aria-controls'), 'company-list-search-1');
    assert.equal(await page.locator('#company-list').isVisible(), false);
    assert.equal(state.companyOptionClicks, 1);
    assert.equal(state.hiddenCompanyOptionClicks, 0);
    assert.equal(state.company, 'test');
    assert.equal(state.rulesOpenedBeforeCompanySelection, false);
    assert.deepEqual(state.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(state.submitClicks, 0);
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('selects before the default company response and preserves the selected company when it arrives late', { timeout: 5000 }, async () => {
  await withFixture({
    companies: ['test branch', 'test'], remoteCompanySearch: true,
    fetchCompanyRequests: true, holdInitialCompanyRequest: true,
  }, async (page, options, requests) => {
    const result = await prepareHiddenRules(page, {
      companyName: 'test', rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, options);
    const before = await page.evaluate(() => window.fixtureState);
    assert.equal(requests.pendingInitialCompanyRequests, 1,
      'typing directly must not open an empty selector and send another full-company query');
    assert.equal(before.companyEvents.includes('applied:'), false);
    assert.deepEqual(before.searches, ['test']);
    assert.equal(before.company, 'test');
    assert.deepEqual(before.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(result.pendingManualSubmit, true);

    await requests.releaseInitialCompanyRequests();
    await page.waitForFunction(() => window.fixtureState.companyEvents.includes('applied:'));
    const after = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(await page.locator('#company-list [role="option"]').allTextContents(), ['unrelated initial company'],
      'the late default response must actually replace the company options');
    assert.equal(after.company, 'test', 'option replacement must not reset the committed company ID');
    assert.equal(await page.locator('.company-field .el-select__placeholder').innerText(), 'test');
    assert.equal(after.companyOptionClicks, 1);
    assert.deepEqual(after.rules, before.rules);
    assert.equal(after.rulesOpenedBeforeCompanySelection, false);
    assert.deepEqual(after.companyRequestErrors, []);
    assert.equal(after.submitClicks, 0);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('a hanging default company query does not block typing or cause additional empty queries', { timeout: 5000 }, async () => {
  await withFixture({
    companies: ['test'], remoteCompanySearch: true,
    fetchCompanyRequests: true, holdInitialCompanyRequest: true,
  }, async (page, options, requests) => {
    const result = await prepareHiddenRules(page, {
      companyName: 'test', rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(state.companyEvents, ['request:', 'input:test', 'request:test', 'applied:test']);
    assert.equal(requests.pendingInitialCompanyRequests, 1);
    assert.deepEqual(state.searches, ['test']);
    assert.equal(state.company, 'test');
    assert.equal(state.companyOptionClicks, 1);
    assert.equal(state.rulesOpenedBeforeCompanySelection, false);
    assert.deepEqual(state.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(state.submitClicks, 0);
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('selects the intended rule labels when the catalog reorders after the first selection', async () => {
  await withFixture({ reorderRulesAfterFirstSelection: true }, async (page, options) => {
    const result = await prepareHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.ruleCatalogReorders, 1);
    assert.deepEqual(await page.locator('#rules-list [role="option"]').allTextContents(), CATALOG.toReversed());
    assert.deepEqual(state.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(state.submitClicks, 0);
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
  });
});

test('recovers a login redirect during a typed company query once and reopens the drawer before selecting', async () => {
  await withFixture({
    companies: ['test branch', 'test'], remoteCompanySearch: true,
    fetchCompanyRequests: true, expireCompanyRequests: 1, initialCompanyDelayMs: 10,
  }, async (page, options) => {
    let loginCalls = 0;
    const events = ['request', 'requestfinished', 'requestfailed'];
    const listenerCounts = events.map(event => page.listenerCount(event));
    const result = await prepareHiddenRules(page, {
      companyName: 'test', rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, {
      ...options,
      async waitForLogin(loginPage, loginOptions) {
        loginCalls++;
        assert.equal(loginOptions.targetUrl, HIDDEN_RULES_URL);
        assert.ok(loginCalls <= 2, 'authentication recovery must be bounded');
        if (loginCalls === 2) {
          assert.equal(new URL(loginPage.url()).pathname, '/admin/login/account');
          assert.equal(loginOptions.reuseSharedAuth, false,
            'recovery must not restore the shared credentials that just expired');
          await loginPage.goto(HIDDEN_RULES_URL);
        }
        await loginOptions.readyLocator.waitFor({ state: 'visible' });
      },
    });
    const { current, expired } = await page.evaluate(() => ({
      current: window.fixtureState,
      expired: JSON.parse(sessionStorage.getItem('expiredFixtureStates') ?? '[]'),
    }));
    assert.equal(loginCalls, 2);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].opened, 1);
    assert.deepEqual(expired[0].searches, ['test']);
    assert.equal(expired[0].companyOptionClicks, 0);
    assert.equal(expired[0].ruleDropdownOpens, 0);
    assert.equal(expired[0].submitClicks, 0);
    assert.equal(current.opened, 1, 'the fresh post-login drawer must be opened');
    assert.deepEqual(current.searches, ['test']);
    assert.equal(current.company, 'test');
    assert.equal(current.companyOptionClicks, 1);
    assert.equal(current.rulesOpenedBeforeCompanySelection, false);
    assert.deepEqual(current.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(current.submitClicks, 0);
    assert.equal(result.pendingManualSubmit, true);
    assert.equal(await page.locator('#submit').isEnabled(), true);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
    assert.deepEqual(events.map(event => page.listenerCount(event)), listenerCounts);
  });
});

test('stops after a second login redirect without repeatedly authenticating or selecting rules', async () => {
  await withFixture({
    companies: ['test'], remoteCompanySearch: true,
    fetchCompanyRequests: true, expireCompanyRequests: 2, initialCompanyDelayMs: 10,
  }, async (page, options) => {
    let loginCalls = 0;
    const events = ['request', 'requestfinished', 'requestfailed'];
    const listenerCounts = events.map(event => page.listenerCount(event));
    await assert.rejects(prepareHiddenRules(page, {
      companyName: 'test', rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, {
      ...options,
      async waitForLogin(loginPage, loginOptions) {
        loginCalls++;
        assert.ok(loginCalls <= 2, 'a second expiry must stop instead of entering another login loop');
        if (loginCalls === 2) {
          assert.equal(new URL(loginPage.url()).pathname, '/admin/login/account');
          assert.equal(loginOptions.reuseSharedAuth, false);
          await loginPage.goto(HIDDEN_RULES_URL);
        }
        await loginOptions.readyLocator.waitFor({ state: 'visible' });
      },
    }), /登录/);
    assert.equal(loginCalls, 2);
    assert.equal(new URL(page.url()).pathname, '/admin/login/account');
    const expired = await page.evaluate(() => JSON.parse(sessionStorage.getItem('expiredFixtureStates') ?? '[]'));
    assert.equal(expired.length, 2);
    for (const state of expired) {
      assert.equal(state.opened, 1);
      assert.deepEqual(state.searches, ['test']);
      assert.equal(state.company, null);
      assert.equal(state.companyOptionClicks, 0);
      assert.equal(state.ruleDropdownOpens, 0);
      assert.deepEqual(state.rules, []);
      assert.equal(state.submitClicks, 0);
    }
    assert.deepEqual(events.map(event => page.listenerCount(event)), listenerCounts);
  });
});

test('company text alone cannot count as a selection or allow the rules dropdown to open', async () => {
  await withFixture({ rejectCompanySelection: true }, async (page, options) => {
    await assert.rejects(
      prepareHiddenRules(page, { companyName: COMPANY, rules: ['Google'] }, options),
      /公司.*未成功选中.*停止填写规则/,
    );
    const state = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(state.searches, [COMPANY]);
    assert.equal(state.companyOptionClicks, 1);
    assert.equal(state.company, null);
    assert.equal(await page.locator('.company-field .el-select__placeholder').innerText(), COMPANY,
      'the fixture must display the company name even though the selection did not commit');
    assert.equal(await page.locator('.company-field input').inputValue(), COMPANY);
    assert.equal(await page.locator('.company-field input').getAttribute('aria-expanded'), 'true');
    assert.equal(state.ruleDropdownOpens, 0);
    assert.deepEqual(state.rules, []);
    assert.equal(state.submitClicks, 0);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('missing or duplicate companies cannot select any rule or submit', async () => {
  for (const [companies, message] of [
    [[`${COMPANY}分公司`], /名称完全匹配的公司/],
    [[COMPANY, COMPANY], /多个完全同名的公司/],
  ]) {
    await withFixture({ companies }, async (page, options) => {
      await assert.rejects(prepareHiddenRules(page, { companyName: COMPANY, rules: ['Google'] }, options), message);
      const state = await page.evaluate(() => window.fixtureState);
      assert.deepEqual(state.rules, []);
      assert.equal(state.submitClicks, 0);
    });
  }
});

test('explicitly selected test and blacklist names match exactly without adding other packages', async () => {
  await withFixture({}, async (page, options) => {
    await prepareHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'TikTok跨境电商(黑名单)'],
    }, options);
    const state = await page.evaluate(() => window.fixtureState);
    assert.deepEqual(state.rules, [
      '测试规则包2 (测试规则包2)', 'TikTok跨境电商(黑名单) (TikTok跨境电商(黑名单))',
    ]);
    assert.equal(state.submitClicks, 0);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('a missing or ambiguous rule is reported before selecting any package', async () => {
  for (const [catalog, rules, message] of [
    [CATALOG, ['Google', '不存在的应用'], /没有找到对应的隐藏规则包：不存在的应用/],
    [[...CATALOG, 'Google (GL)'], ['office365', 'Google'], /存在多个精确匹配/],
  ]) {
    await withFixture({ catalog }, async (page, options) => {
      await assert.rejects(prepareHiddenRules(page, { companyName: COMPANY, rules }, options), message);
      const state = await page.evaluate(() => window.fixtureState);
      assert.deepEqual(state.rules, []);
      assert.equal(state.submitClicks, 0);
    });
  }
});

test('failed selection is not reported as ready and never clicks Add', async () => {
  await withFixture({ rejectSelections: true }, async (page, options) => {
    await assert.rejects(prepareHiddenRules(page, { companyName: COMPANY, rules: ['Google'] }, options), /未成功选中/);
    assert.equal(await page.evaluate(() => window.fixtureState.submitClicks), 0);
  });
});

test('automatically adds the selected company and three rules once and confirms the response and closed drawer', async () => {
  await withFixture({ submitBehavior: 'success' }, async (page, options, requests) => {
    const result = await completeHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, { ...options, submitTimeoutMs: 400 });
    const state = await page.evaluate(() => window.fixtureState);
    const expectedPayload = { org_id: 1001, saas_rule_package_ids: [2000, 2001, 2002] };
    assert.equal(state.submitClicks, 1);
    assert.deepEqual(state.submitPayloads, [expectedPayload]);
    assert.deepEqual(requests.submitRequests, [{ method: 'POST', payload: expectedPayload }]);
    assert.equal(state.submitResponseReceived, true);
    assert.deepEqual(state.submitErrors, []);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), false);
    assert.equal(result.companyName, COMPANY);
    assert.equal(result.rules.length, 3);
    assert.equal(result.pendingManualSubmit, false);
    assert.equal(result.submitted, true);
  });
});

test('a rejected add keeps the prepared drawer and does not submit a second time', async () => {
  await withFixture({ submitBehavior: 'business-error' }, async (page, options, requests) => {
    await assert.rejects(completeHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, { ...options, submitTimeoutMs: 400 }), /企业规则包已存在/);
    await page.waitForFunction(() => window.fixtureState.submitErrors.length === 1);
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.submitClicks, 1);
    assert.equal(requests.submitRequests.length, 1);
    assert.equal(state.company, COMPANY);
    assert.deepEqual(state.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('an HTTP error or unreadable add response cannot be treated as a confirmed addition', async () => {
  for (const submitBehavior of ['http-error', 'invalid-json']) {
    await withFixture({ submitBehavior }, async (page, options, requests) => {
      await assert.rejects(completeHiddenRules(page, {
        companyName: COMPANY, rules: ['GL'],
      }, { ...options, submitTimeoutMs: 400 }));
      const state = await page.evaluate(() => window.fixtureState);
      assert.equal(state.submitClicks, 1);
      assert.equal(requests.submitRequests.length, 1);
      assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
    });
  }
});

test('a missing add response times out without clicking Add again', async () => {
  await withFixture({ submitBehavior: 'pending' }, async (page, options, requests) => {
    await assert.rejects(completeHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, { ...options, submitTimeoutMs: 150 }));
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.submitClicks, 1);
    assert.equal(state.submitResponseReceived, false);
    assert.equal(requests.submitRequests.length, 1);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('an accepted response without a closed drawer is reported as unconfirmed and never resubmitted', async () => {
  await withFixture({ submitBehavior: 'success-with-open-drawer' }, async (page, options, requests) => {
    await assert.rejects(completeHiddenRules(page, {
      companyName: COMPANY, rules: ['GL'],
    }, { ...options, submitTimeoutMs: 150 }));
    const state = await page.evaluate(() => window.fixtureState);
    assert.equal(state.submitResponseReceived, true);
    assert.equal(state.submitClicks, 1);
    assert.equal(requests.submitRequests.length, 1);
    assert.equal(await page.locator('.ant-drawer-content-wrapper').isVisible(), true);
  });
});

test('a login redirect after Add does not restart authentication or repeat the submission', async () => {
  await withFixture({ submitBehavior: 'login' }, async (page, options, requests) => {
    let loginCalls = 0;
    await assert.rejects(completeHiddenRules(page, {
      companyName: COMPANY, rules: ['测试规则包2', 'GL', 'GLSIGNIN'],
    }, {
      ...options, submitTimeoutMs: 400,
      async waitForLogin(loginPage, loginOptions) {
        loginCalls++;
        assert.equal(loginCalls, 1, 'an uncertain submission must never enter authentication recovery');
        await options.waitForLogin(loginPage, loginOptions);
      },
    }));
    await page.waitForURL('**/admin/login/account');
    const state = await page.evaluate(() => JSON.parse(sessionStorage.getItem('submittedFixtureState')));
    assert.equal(loginCalls, 1);
    assert.equal(state.submitClicks, 1);
    assert.equal(requests.submitRequests.length, 1);
    assert.equal(state.company, COMPANY);
    assert.deepEqual(state.rules, ['测试规则包2 (测试规则包2)', 'Google (GL)', 'Google 登录 (GLSIGNIN)']);
  });
});
