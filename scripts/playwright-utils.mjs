const DEFAULT_NAVIGATION_TIMEOUT_MS = 6000;
const DEFAULT_PAGE_READY_TIMEOUT_MS = 10000;
const DEFAULT_PAGE_SETTLE_DELAY_MS = 500;

export function getPlaywrightSlowMo(value = process.env.PLAYWRIGHT_SLOW_MO) {
  if (value === undefined || value === '') return 0;

  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : 0;
}

/**
 * Wait until the current page has finished its network activity, then allow
 * the client-side list rendering to settle before interacting with it.
 */
export async function waitForPageFullyLoaded(page, {
  timeoutMs = DEFAULT_PAGE_READY_TIMEOUT_MS,
  settleMs = DEFAULT_PAGE_SETTLE_DELAY_MS,
} = {}) {
  if (typeof page?.waitForLoadState === 'function') {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => null);
  }

  if (settleMs > 0 && typeof page?.waitForTimeout === 'function') {
    await page.waitForTimeout(settleMs);
  }
}

export async function runAndWaitForActivePage(context, page, action, {
  timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
} = {}) {
  const initialUrl = page.url();
  let resolveActivePage;
  const activePagePromise = new Promise((resolve) => { resolveActivePage = resolve; });
  const onPopup = (popup) => resolveActivePage(popup);
  const onNavigation = (frame) => {
    if (frame === page.mainFrame() && page.url() !== initialUrl) resolveActivePage(page);
  };
  let timeoutId;
  const cleanup = () => {
    clearTimeout(timeoutId);
    context.off('page', onPopup);
    page.off('framenavigated', onNavigation);
  };

  context.on('page', onPopup);
  page.on('framenavigated', onNavigation);
  timeoutId = setTimeout(() => resolveActivePage(page), timeoutMs);

  try {
    await action();
    const activePage = await activePagePromise;
    cleanup();
    await activePage.bringToFront();
    await activePage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => null);
    return activePage;
  } finally {
    cleanup();
  }
}
