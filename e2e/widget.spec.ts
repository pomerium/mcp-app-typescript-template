import { test, expect } from '@playwright/test';
import { HOST_PAGE_URL, SERVER_URL } from '../playwright.config';

const INITIAL_MESSAGE = 'Hello from the E2E host';
const POMERIUM_DOCS_URL =
  'https://www.pomerium.com/docs/capabilities/mcp/develop-mcp-app';

/**
 * Drives the real Echo widget, in a real sandboxed iframe, through the real
 * ext-apps 2 `AppBridge` — automating the manual host validation from PR
 * #137 (MCPJam, Claude.ai, ChatGPT) against a scripted test host instead.
 */
test.describe('Echo widget in a real ext-apps host', () => {
  test('renders, round-trips every host API call, and logs no console errors', async ({
    page,
  }) => {
    // Scoped to the widget's own sandboxed iframe (`srcdoc`, so Chromium
    // reports its console location as `about:srcdoc`) — the host script's
    // own MCP client legitimately sees one console warning from a stateless
    // server rejecting its standalone SSE GET (405, matching the manual
    // curl check in PR #137), which isn't a widget error.
    const widgetConsoleErrors: string[] = [];
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        message.location().url === 'about:srcdoc'
      ) {
        widgetConsoleErrors.push(message.text());
      }
    });

    const hostUrl = new URL(`${HOST_PAGE_URL}/index.html`);
    hostUrl.searchParams.set('server', `${SERVER_URL}/mcp`);
    hostUrl.searchParams.set('message', INITIAL_MESSAGE);
    await page.goto(hostUrl.href);

    await page.waitForFunction(() => window.__e2e?.ready === true, undefined, {
      timeout: 15_000,
    });
    expect(await page.evaluate(() => window.__e2e.error)).toBeNull();
    expect(await page.evaluate(() => window.__e2e.initialized)).toBe(true);

    const widget = page.frameLocator('#widget-frame');

    await test.step('renders and shows the echoed message from the initial tool result', async () => {
      await expect(widget.getByText(INITIAL_MESSAGE)).toBeVisible();
    });

    await test.step('"Call Echo Tool" round-trips callServerTool() and updates the result text', async () => {
      await widget.getByRole('button', { name: 'Call Echo Tool' }).click();
      // `<output>`'s implicit ARIA role is "status", not "output".
      await expect(widget.getByRole('status').first()).toContainText(
        'Echoing: "Hello from the echo widget!"'
      );
      await expect(
        widget.getByText('Hello from the echo widget!', { exact: true })
      ).toBeVisible();
    });

    await test.step('"Update Context" triggers updateModelContext() with the widget state', async () => {
      await widget.getByRole('button', { name: 'Update Context' }).click();
      await expect
        .poll(() => page.evaluate(() => window.__e2e.contextUpdates.length))
        .toBeGreaterThan(0);

      const [update] = await page.evaluate(() => window.__e2e.contextUpdates);
      expect(update.structuredContent).toMatchObject({
        echoedMessage: 'Hello from the echo widget!',
      });
      await expect(widget.getByText('"echoedMessage"')).toBeVisible();
    });

    await test.step('"Send to Chat" triggers sendMessage()', async () => {
      await widget.getByRole('button', { name: 'Send to Chat' }).click();
      await expect
        .poll(() => page.evaluate(() => window.__e2e.messages.length))
        .toBeGreaterThan(0);

      const [message] = await page.evaluate(() => window.__e2e.messages);
      const [firstBlock] = message.content ?? [];
      expect(
        firstBlock?.type === 'text' ? firstBlock.text : undefined
      ).toContain('Sent this chat message from the echo widget');
      await expect(widget.getByText('Message sent to chat')).toBeVisible();
    });

    await test.step('"Full screen" calls requestDisplayMode() and the widget flips its label', async () => {
      const fullscreenButton = widget.getByRole('button', {
        name: 'Full screen',
      });
      await expect(fullscreenButton).toBeVisible();
      await fullscreenButton.click();

      await expect
        .poll(() =>
          page.evaluate(() => window.__e2e.displayModeRequests.length)
        )
        .toBeGreaterThan(0);
      const [request] = await page.evaluate(
        () => window.__e2e.displayModeRequests
      );
      expect(request.mode).toBe('fullscreen');

      await expect(
        widget.getByRole('button', { name: 'Exit full screen' })
      ).toBeVisible();
    });

    await test.step('"Open Docs" calls openLink() with the Pomerium docs URL', async () => {
      await widget.getByRole('button', { name: 'Open Docs' }).click();
      await expect
        .poll(() => page.evaluate(() => window.__e2e.openLinks.length))
        .toBeGreaterThan(0);

      const [openLink] = await page.evaluate(() => window.__e2e.openLinks);
      expect(openLink.url).toBe(POMERIUM_DOCS_URL);
    });

    await test.step('theme toggle switches to dark', async () => {
      await widget
        .getByRole('button', { name: 'Switch to dark theme' })
        .click();
      await expect(
        widget.getByRole('button', { name: 'Switch to light theme' })
      ).toBeVisible();
    });

    expect(widgetConsoleErrors).toEqual([]);
  });
});
