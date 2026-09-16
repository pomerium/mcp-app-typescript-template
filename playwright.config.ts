import { defineConfig, devices } from '@playwright/test';

/**
 * Non-default ports so this suite never clashes with a local `npm run dev`
 * (server: 8080, widgets: 4444).
 */
export const SERVER_PORT = 8390;
export const WIDGET_PORT = 4390;
export const HOST_PAGE_PORT = 5390;
export const MCPJAM_PORT = 6390;

export const SERVER_URL = `http://localhost:${SERVER_PORT}`;
export const WIDGET_BASE_URL = `http://localhost:${WIDGET_PORT}`;
export const HOST_PAGE_URL = `http://localhost:${HOST_PAGE_PORT}`;
export const MCPJAM_URL = `http://localhost:${MCPJAM_PORT}`;

/**
 * `npm run test:e2e` runs `pretest:e2e` first (production build of both
 * workspaces plus the AppBridge test host bundle); this config only starts
 * already-built servers against those fixed ports.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node server/dist/server.js',
      url: `${SERVER_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        NODE_ENV: 'production',
        PORT: String(SERVER_PORT),
        BASE_URL: WIDGET_BASE_URL,
        WIDGET_PORT: String(WIDGET_PORT),
        LOG_LEVEL: 'silent',
      },
    },
    {
      command: 'npm run start:widgets',
      url: `${WIDGET_BASE_URL}/echo.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        WIDGET_PORT: String(WIDGET_PORT),
      },
    },
    {
      command: 'node e2e/host/serve.mjs',
      url: `${HOST_PAGE_URL}/index.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        HOST_PAGE_PORT: String(HOST_PAGE_PORT),
      },
    },
    {
      // No `--url`/`--config` auto-connect: that path forces MCPJam's hosted
      // sign-in wall (confirmed manually), the same class of regression as
      // #114. `e2e/mcpjam.spec.ts` instead adds the server through the real
      // "Add Server" UI, exactly like the manual flow in README's
      // "Local Testing with MCP Inspector" section.
      command: `node_modules/.bin/inspector --port ${MCPJAM_PORT} --no-open`,
      url: `${MCPJAM_URL}/api/mcp/servers`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
