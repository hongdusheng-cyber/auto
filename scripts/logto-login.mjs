import {
  acquireAuthLock,
  canApplyAuthState,
  getAuthStateFile,
  loadAuthState,
  mergeAuthState,
  saveAuthState,
  waitForAuthState,
} from './auth-state.mjs';

const ADMIN_LOGIN_URL = 'https://console.osase.net/admin/login/account';
const LOGTO_HOST = 'id.internal.osase.net';
const LOGIN_PATH_PATTERN = /\/(?:admin\/)?login(?:\/|$)|\/sign-in(?:\/|$)/;
const DEFAULT_MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** The administrator SPA renders its buttons before /user/info accepts its token. */
export async function verifyAdminSession(page, { targetUrl }) {
  const target = parseUrl(targetUrl);
  if (target?.origin !== 'https://console.osase.net' || !target.pathname.startsWith('/admin/')) return true;

  // Return only the verdict. Credentials and user details stay in the browser.
  const result = await page.evaluate(async () => {
    if (location.origin !== 'https://console.osase.net') return { authenticated: false };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = localStorage.getItem('admin-token');
      if (!token) return { authenticated: false };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch('https://api.osase.net/admin/user/info', {
          headers: { 'LOGIN-TOKEN': token },
          cache: 'no-store',
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        // The application may refresh the token while this request is pending.
        if (localStorage.getItem('admin-token') !== token) continue;
        if (response.status === 401 || Number(body?.code) === 401) return { authenticated: false };
        if (response.ok && body?.code === 0 && body.data?.id) return { authenticated: true };
        return { error: true, status: response.status, code: body?.code ?? null };
      } catch {
        return { error: true };
      } finally {
        clearTimeout(timer);
      }
    }
    return { authenticated: false };
  });
  if (result.error) {
    const error = new Error(`无法验证管理员登录态（HTTP ${result.status ?? '连接失败'}，业务码 ${result.code ?? '未知'}），请检查后台服务后重试。`);
    error.code = 'AUTH_VERIFICATION_FAILED';
    throw error;
  }
  return result.authenticated === true;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const current = locator.nth(index);
      if (await current.isVisible().catch(() => false)) return current;
    }
  }

  return null;
}

async function waitForFirstVisible(page, locators, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const visible = await firstVisible(locators);
    if (visible) return visible;
    await page.waitForTimeout(250);
  }

  return null;
}

async function waitForReadyOrLogin(page, locator, timeoutMs, isReady) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (isLoginUrl(page.url())) return false;
    if (await locator.isVisible().catch(() => false)) return isReady();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    const ready = await locator.waitFor({ state: 'visible', timeout: Math.min(250, remainingMs) })
      .then(() => true)
      .catch(() => false);
    if (ready) return isReady();
  } while (Date.now() < deadline);
  return false;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoginUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return url.hostname === LOGTO_HOST || LOGIN_PATH_PATTERN.test(url.pathname);
}

export function isLogtoLoginUrl(value) {
  return isLoginUrl(value);
}

function isConsolePageOutsideLogin(value) {
  const url = parseUrl(value);
  return url?.hostname === 'console.osase.net' && !isLoginUrl(value);
}

async function waitForLogtoPageOrReady(page, isReady, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isReady()) return 'ready';
    if (parseUrl(page.url())?.hostname === LOGTO_HOST) return 'logto';
    if (isConsolePageOutsideLogin(page.url())) return 'console';
    await page.waitForTimeout(300);
  }

  return 'timeout';
}

async function waitForReadyAfterLogin(page, {
  targetUrl,
  readyLocator,
  readyDescription,
  userDataDir,
  timeoutMs,
  isReady,
}) {
  const deadline = Date.now() + timeoutMs;
  let targetNavigationAttempted = false;
  let manualNoticeShown = false;
  const automaticWaitDeadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (await isReady()) return;

    const currentUrl = page.url();
    if (isConsolePageOutsideLogin(currentUrl) && !targetNavigationAttempted) {
      targetNavigationAttempted = true;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
      continue;
    }

    if (!manualNoticeShown && Date.now() >= automaticWaitDeadline) {
      manualNoticeShown = true;
      console.log('已自动点击 Logto 的“登录”，但页面尚未完成登录。');
      console.log('如页面要求填写账号、密码或完成验证，请在浏览器中操作；脚本会自动继续。');
      console.log(`登录态会保存在浏览器目录：${userDataDir}，并同步到：${getAuthStateFile()}`);
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`等待登录完成超时，仍未看到“${readyDescription}”。`);
}

export async function waitForPageWithLogtoLogin(page, {
  targetUrl,
  readyLocator,
  readyDescription,
  userDataDir,
  initialTimeoutMs = 15000,
  manualLoginTimeoutMs = DEFAULT_MANUAL_LOGIN_TIMEOUT_MS,
  reuseSharedAuth = true,
  restoreSharedAuthOnStart = false,
  verifySession = verifyAdminSession,
}) {
  let sessionRejected = false;
  const isReady = async () => {
    if (isLoginUrl(page.url()) || !(await readyLocator.isVisible().catch(() => false))) return false;
    const verified = await verifySession(page, { targetUrl });
    if (!verified) sessionRejected = true;
    return verified;
  };
  const persistCurrentAuthState = async () => {
    try {
      const context = typeof page.context === 'function' ? page.context() : null;
      const filePath = await saveAuthState(context);
      if (filePath) console.log(`已保存共享登录态：${filePath}`);
    } catch (error) {
      console.warn(`保存共享登录态失败：${error.message}`);
    }
  };

  // Keep a server-validated profile by default. A shared file may contain an
  // older refresh token, even when its file modification time is recent.
  const pageContext = typeof page.context === 'function' ? page.context() : null;
  const canCoordinateAuth = Boolean(
    pageContext && canApplyAuthState(pageContext) && typeof page.goto === 'function',
  );
  // A business page redirected by the server can request fresh authentication
  // without reapplying the snapshot that was just rejected. Keep that snapshot
  // as the baseline when waiting for another browser to finish authentication.
  let sharedState = canCoordinateAuth ? await loadAuthState() : null;
  let lastAttemptedSharedState = null;
  if (restoreSharedAuthOnStart && reuseSharedAuth && canCoordinateAuth && sharedState) {
    lastAttemptedSharedState = sharedState;
    try {
      await mergeAuthState(pageContext, sharedState);
      // Reload so the application consumes the merged localStorage/IndexedDB
      // values before its initial API calls.
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    } catch {
      // An expired or malformed snapshot is handled by the normal login flow.
    }
  }

  if (await waitForReadyOrLogin(page, readyLocator, initialTimeoutMs, isReady)) {
    await persistCurrentAuthState();
    return;
  }

  const currentUrl = page.url();
  const logtoButtonOnCurrentPage = await firstVisible([
    page.getByRole('button', { name: '使用 Logto 登录', exact: true }),
    page.locator('button', { hasText: /^\s*使用 Logto 登录\s*$/ }),
  ]);
  if (!sessionRejected && !isLoginUrl(currentUrl) && !logtoButtonOnCurrentPage) {
    throw new Error(`页面未进入“${readyDescription}”，当前也不是登录页：${currentUrl}`);
  }

  // A browser that started before the first login can pick up the state as
  // soon as another browser finishes authenticating.
  if (reuseSharedAuth && canCoordinateAuth) {
    const latestSharedState = await loadAuthState();
    // When startup restoration is disabled, a healthy profile is retained and
    // a signed-out profile can still apply this snapshot once after detection.
    if (latestSharedState && JSON.stringify(latestSharedState) !== JSON.stringify(lastAttemptedSharedState)) {
      sharedState = latestSharedState;
      lastAttemptedSharedState = sharedState;
      try {
        await mergeAuthState(pageContext, sharedState);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
        if (await waitForReadyOrLogin(page, readyLocator, initialTimeoutMs, isReady)) {
          await persistCurrentAuthState();
          return;
        }
      } catch (error) {
        if (error.code === 'AUTH_VERIFICATION_FAILED') throw error;
        // Treat an expired or otherwise invalid snapshot like a normal login.
      }
    }
  }

  let authLock = null;
  if (canCoordinateAuth) {
    authLock = await acquireAuthLock();
    if (!authLock) {
      console.log('检测到其他浏览器正在认证，正在等待共享登录态。');
      const restored = await waitForAuthState({
        page,
        targetUrl,
        readyLocator,
        timeoutMs: manualLoginTimeoutMs,
        initialState: sharedState,
        isReady,
      });
      if (restored) {
        await persistCurrentAuthState();
        console.log('已复用其他浏览器刚完成的登录态。');
        return;
      }

      // The previous owner may have crashed. Try to become the next owner
      // before giving up, so a stale lock never forces a manual retry.
      authLock = await acquireAuthLock();
      if (!authLock) {
        throw new Error(`等待其他浏览器完成登录超时；请检查共享登录态：${getAuthStateFile()}`);
      }
    }
  }

  try {
    if (sessionRejected && !isLoginUrl(page.url())) {
      console.log('后台已拒绝当前管理员登录态，正在重新认证。');
      await page.goto(ADMIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    }
    await completeLoginFlow(page, {
      targetUrl,
      readyLocator,
      readyDescription,
      userDataDir,
      manualLoginTimeoutMs,
      isReady,
    });
    await persistCurrentAuthState();
  } finally {
    await authLock?.release();
  }
}

async function completeLoginFlow(page, {
  targetUrl,
  readyLocator,
  readyDescription,
  userDataDir,
  manualLoginTimeoutMs,
  isReady,
}) {
  const currentUrl = page.url();

  const logtoButtonOnCurrentPage = await firstVisible([
    page.getByRole('button', { name: '使用 Logto 登录', exact: true }),
    page.locator('button', { hasText: /^\s*使用 Logto 登录\s*$/ }),
  ]);

  if (!isLoginUrl(currentUrl) && !logtoButtonOnCurrentPage) {
    throw new Error(`页面未进入“${readyDescription}”，当前也不是登录页：${currentUrl}`);
  }

  console.log(`检测到登录页，正在使用 Logto 登录以进入“${readyDescription}”。`);

  if (parseUrl(page.url())?.hostname !== LOGTO_HOST && !logtoButtonOnCurrentPage) {
    await page.goto(ADMIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  }

  if (parseUrl(page.url())?.hostname !== LOGTO_HOST) {
    const logtoButton = logtoButtonOnCurrentPage ?? await waitForFirstVisible(page, [
      page.getByRole('button', { name: '使用 Logto 登录', exact: true }),
      page.locator('button', { hasText: /^\s*使用 Logto 登录\s*$/ }),
    ]);

    if (!logtoButton) {
      await page.goto(ADMIN_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    }

    const visibleLogtoButton = logtoButton ?? await waitForFirstVisible(page, [
      page.getByRole('button', { name: '使用 Logto 登录', exact: true }),
      page.locator('button', { hasText: /^\s*使用 Logto 登录\s*$/ }),
    ]);
    if (!visibleLogtoButton) throw new Error('管理员登录页里没有找到“使用 Logto 登录”按钮。');

    await visibleLogtoButton.click();
    const nextState = await waitForLogtoPageOrReady(page, isReady);
    if (nextState === 'ready') return;
    if (nextState === 'timeout') throw new Error('点击“使用 Logto 登录”后没有进入 Logto 登录页。');
  }

  const loginButton = parseUrl(page.url())?.hostname === LOGTO_HOST
    ? await waitForFirstVisible(page, [
      page.getByRole('button', { name: '登录', exact: true }),
      page.locator('button[type="submit"]', { hasText: /^\s*登录\s*$/ }),
    ])
    : null;

  if (loginButton) {
    console.log('已跳转到 Logto，正在点击“登录”。');
    await loginButton.click();
  }

  await waitForReadyAfterLogin(page, {
    targetUrl,
    readyLocator,
    readyDescription,
    userDataDir,
    timeoutMs: manualLoginTimeoutMs,
    isReady,
  });
}
