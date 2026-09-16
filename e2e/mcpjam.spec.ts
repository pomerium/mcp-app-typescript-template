import { test, expect, type Page } from '@playwright/test';
import { MCPJAM_URL, SERVER_URL } from '../playwright.config';

const SERVER_NAME = 'e2e-server';
const MESSAGE = 'Hello from the MCPJam e2e suite';

/**
 * Shared MCPJam quirks-workarounds, needed by both the test itself and the
 * `afterAll` cleanup (which gets its own page — `afterAll` doesn't share the
 * test's `page` fixture).
 */
async function setUpMcpjamPage(page: Page) {
  // A fresh guest identity (a new one every run, since nothing persists
  // between test runs) makes MCPJam treat this as a first-run session: it
  // shows its own "Setting things up..." skeleton while auto-provisioning
  // the built-in Excalidraw demo server through Convex
  // (client/src/hooks/use-onboarding.ts), which this environment can't
  // satisfy and which has no reliable client-side escape (confirmed
  // manually — its own 12s failsafe just swaps to an equally stuck "Still
  // syncing…" dead end). `readOnboardingState()`
  // (client/src/lib/onboarding-state.ts) treats a locally-persisted
  // "dismissed" status as authoritative and skips all of this, so seed it
  // before the app's own script runs.
  await page.addInitScript(() => {
    localStorage.setItem(
      'mcp-onboarding-state',
      JSON.stringify({ status: 'dismissed' })
    );
  });

  // MCPJam's client boots from a session-scoped `/p/<id>/...` URL, so only
  // its own root load is a valid deep link; every other view has to be
  // reached by clicking through its sidebar, same as a real user. That
  // first load can also trigger a native `beforeunload` navigation guard as
  // MCPJam rewrites the URL to its session path — accept it to let that
  // proceed.
  page.on('dialog', (dialog) => dialog.accept());

  // (`POST /api/web/guest-session` mints a real Convex-backed identity that
  // the "connect" flow's own config-sync step depends on later — faking
  // that response breaks the connection instead, confirmed manually. Only
  // the first-run onboarding skeleton above needed bypassing, not this.)

  // MCPJam's own "Let agents use your browser?" consent modal is a real
  // React dialog, not a native one, and it renders on a delay (an async
  // local-computer capability check) rather than deterministically before
  // or after any of our steps — it can interrupt any of the actions below.
  // While it's open, the rest of the page is `aria-hidden`, so a one-shot
  // dismiss can race it; `addLocatorHandler` re-checks before every action
  // and dismisses it whenever it shows up.
  //
  // "Allow" (`enableLocalBrowserForAllClients` in MCPJam's
  // client/src/lib/local-browser-consent.ts) mints consent via
  // `POST .../consent/grant`, then calls `POST .../enable-clients` — both
  // gated server-side behind its hosted guest-session/bearer-auth chain,
  // which is a live call to MCPJam's own backend and can be rate-limited
  // (confirmed manually). We don't use MCPJam's browser/WebMCP feature at
  // all here, so stub both routes to the shapes MCPJam's own source expects
  // (a 16+ char `token` string; `enable-clients` only checks
  // `response.ok`) rather than depend on that chain succeeding.
  await page.route(
    '**/api/mcp/computers/local-browser/consent/grant',
    (route) =>
      route.fulfill({
        json: {
          token: 'e2e-mock-consent-token',
          grantedAt: new Date().toISOString(),
        },
      })
  );
  await page.route(
    '**/api/mcp/computers/local-browser/enable-clients',
    (route) =>
      route.fulfill({
        json: { enabledProjects: 0, skippedProjects: 0, scope: 'device' },
      })
  );
  await page.addLocatorHandler(
    page.getByRole('heading', { name: 'Let agents use your browser?' }),
    () => page.getByRole('button', { name: 'Allow browser access' }).click()
  );
}

/**
 * Drives the real MCPJam Inspector (the same tool `npm run inspect` opens)
 * against the real production server, through its own "Add Server" UI —
 * never `--url`/`--config` auto-connect, which forces MCPJam's hosted
 * sign-in wall instead of landing in the local UI (confirmed manually; the
 * same class of regression as #114). This is a rendering/interaction smoke
 * test on top of `e2e/widget.spec.ts`'s scripted-host protocol coverage,
 * which already drives every widget action precisely and fast — this suite
 * only proves the widget renders and round-trips one real action
 * (`callServerTool`) inside MCPJam's actual multi-host emulator, not a
 * spec-compliant stand-in. The remaining actions are deliberately left to
 * the scripted-host suite.
 */
test.describe('Echo widget in the real MCPJam Inspector', () => {
  test('renders and round-trips a tool call through the Inspector UI', async ({
    page,
  }) => {
    await setUpMcpjamPage(page);
    await page.goto(MCPJAM_URL);

    // The sidebar's servers-view nav item is labeled "Connect" or "Servers"
    // depending on MCPJam's own live feature flags (confirmed varying
    // between loads of the same pinned version) — tolerate either.
    const serversViewNav = page.getByRole('button', {
      name: /^(Connect|Servers)$/,
    });
    const addServerButton = page.getByRole('button', { name: 'Add Server' });
    const serverCard = page.getByRole('heading', { name: SERVER_NAME });
    await serversViewNav.click();
    await addServerButton.or(serverCard).first().waitFor({ state: 'visible' });

    if ((await serverCard.count()) === 0) {
      await addServerButton.click();
      const dialog = page.getByRole('dialog', { name: 'Add MCP Server' });
      await dialog
        .getByRole('textbox', { name: 'my-mcp-server' })
        .fill(SERVER_NAME);
      await dialog
        .getByRole('textbox', { name: 'http://localhost:8080/mcp' })
        .fill(`${SERVER_URL}/mcp`);
      await dialog.getByRole('button', { name: 'Add Server' }).click();
    }

    // MCPJam's own connect flow has a confirmed, intermittent bug (its
    // "Finishing setup." transitional status toast is sometimes miscaught
    // as the connection's error message, surfaced as "Unknown error" with
    // "New error class the inspector hasn't been taught about yet" — not
    // anything about our server or config). Its own "Reconnect" action
    // reliably clears it, so retry through that a few times rather than
    // treating the transient failure as a real one.
    const connectedToast = page.getByText('Connected successfully!');
    const actionsMenuButton = page.getByRole('button', {
      name: `Open actions menu for ${SERVER_NAME}`,
    });
    let connected = false;
    for (let attempt = 0; attempt < 3 && !connected; attempt++) {
      if (attempt > 0) {
        await actionsMenuButton.click();
        await page.getByRole('menuitem', { name: 'Reconnect' }).click();
      }
      connected = await connectedToast
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(connected).toBe(true);

    await page.getByRole('button', { name: 'Playground' }).click();
    // When more than one server is connected, the tool button's accessible
    // name inserts each tool's source server between its name and
    // description (e.g. "echo e2e-server Echoes back…") — tolerate either
    // form rather than assuming this is the only connected server.
    await page.getByRole('button', { name: /^echo\b.*Echoes back/ }).click();
    await page.getByRole('textbox', { name: 'Enter message' }).fill(MESSAGE);
    await page.getByRole('button', { name: 'Run' }).click();

    // The Playground previews the same tool call across every emulated
    // host (Claude, ChatGPT, Cursor) at once; the first pane is enough to
    // prove the widget rendered for real.
    const sandboxProxy = page
      .frameLocator('iframe[title="MCP App: echo"]')
      .first();
    const widget = sandboxProxy.frameLocator('iframe');

    await expect(
      widget.getByRole('heading', { name: 'Echo', exact: true })
    ).toBeVisible();
    await expect(widget.getByText(MESSAGE)).toBeVisible();

    // One round-trip through the real host, proving the widget's own
    // `callServerTool()` actually reaches the server via MCPJam's client —
    // every other action is exhaustively covered against the scripted host.
    await widget.getByRole('button', { name: 'Call Echo Tool' }).click();
    await expect(widget.getByRole('status').first()).toContainText(
      'Echoing: "Hello from the echo widget!"'
    );
  });

  test.afterAll(async ({ browser }) => {
    // Best-effort: `reuseExistingServer` (local dev only) keeps the same
    // MCPJam instance — and its local server list — alive across runs, so
    // leaving our own entry behind would make the next run silently reuse a
    // stale connection instead of adding fresh. Scoped strictly to
    // `SERVER_NAME`: a locally-reused instance may well have other, unrelated
    // servers in its list that must be left alone. Never lets a cleanup
    // failure mask the test's own result.
    try {
      const page = await browser.newPage();
      await setUpMcpjamPage(page);
      await page.goto(MCPJAM_URL);
      await page.getByRole('button', { name: /^(Connect|Servers)$/ }).click();

      const actionsMenuButton = page.getByRole('button', {
        name: `Open actions menu for ${SERVER_NAME}`,
      });
      const found = await actionsMenuButton
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (found) {
        await actionsMenuButton.click();
        await page.getByRole('menuitem', { name: 'Remove server' }).click();
      }
      await page.close();
    } catch {
      // Best-effort cleanup; a failure here doesn't affect the test result.
    }
  });
});
