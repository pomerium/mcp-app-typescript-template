# Repository Guidelines

Guidance for AI assistants working in this repo. This file covers operational conventions and agent-specific notes; for setup walkthroughs, full code samples, and narrative explanations (dev serving, App API, CSP, deployment), see README.md — that is the authoritative source and this file avoids restating it.

## Project Overview

This is an MCP Apps template built with the MCP Apps spec and Model Context Protocol (MCP). npm workspaces split the codebase: `server/` is the MCP backend (Node.js + Express), `widgets/` houses React widgets rendered in host iframes via the MCP Apps `App` API. Vite auto-discovers and builds widgets with content-hashed assets.

## Commands

| Command                                                       | Purpose                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                                                 | MCP server + widget dev server, no build step, HMR everywhere |
| `npm run dev:server` / `npm run dev:widgets`                  | Start just one half, in watch mode                            |
| `npm run inspect`                                             | MCP Inspector against the local server                        |
| `npm run build` / `build:widgets` / `build:server`            | Production builds                                             |
| `npm test` / `test:server` / `test:widgets` / `test:coverage` | Vitest suites                                                 |
| `npm run test:e2e`                                            | Playwright suite against a production build (Chromium only)   |
| `npm run lint` / `format` / `format:check` / `type-check`     | Code quality                                                  |
| `npm run storybook` / `build:storybook`                       | Storybook                                                     |

Dev-serving mechanics (`BASE_URL`, tunnels, HMR over websockets) are documented in README's "How Development Serving Works" — read that before touching the widget resource callback in `server/src/server.ts` or `widgets/vite-plugin-widgets.ts`.

## Key Architectural Patterns

- **MCP Apps server usage** — `McpServer` + `createMcpHandler` with `registerAppResource` / `registerAppTool`; tools bind UI via `_meta.ui.resourceUri`.
- **Stateless HTTP** — `createMcpHandler` creates a fresh server/transport per request (MCP 2026-07-28). No `Mcp-Session-Id`; older 2025-era requests go through the SDK's stateless fallback. Anything that must survive a request needs to live in tool arguments or an external store.
- **Widget resource MIME type** — must be exactly `text/html;profile=mcp-app`:

  ```typescript
  mimeType: 'text/html;profile=mcp-app'; // CRITICAL - must be exact
  ```

- **Tool response shape**:

  ```typescript
  {
    content: [{ type: 'text', text: 'Human-readable message' }],
    structuredContent: { /* keep under 4,000 tokens */ },
  }
  ```

- **Widget build** — Vite scans `widgets/src/widgets/*.{tsx,jsx}`; the filename is the widget id (`echo.tsx` → `ui://echo`); each entry must include its own mounting code. For the full walkthrough, use the `add-widget` / `create-mcp-tool` skills or README's "Adding New Tools" / "Widget Development" sections.
- **Zod validation** — schemas live in `server/src/types.ts` and are passed directly as `inputSchema` (the Zod object itself, e.g. `inputSchema: MyToolInputSchema`, never `.shape`); handlers receive typed args plus a `ServerContext` `ctx`; types are inferred via `z.infer`.
- **UI capability negotiation** — tools always carry MCP Apps metadata plus a text fallback; `getUiCapability()` / `clientCanRenderUi()` gate `structuredContent` for hosts that can't render UI, automatically.

## File Organization

### Server

- `server/src/server.ts` - exports `createMcpServer()` / `createHandler()`; only calls `main()` and listens on a port when run directly (`import.meta.main`), so tests can drive the handler without binding one
- `server/src/types.ts` - Zod schemas and TypeScript interfaces
- `server/tests/*.test.ts` - Vitest specs; `server/tests/server.test.ts` drives the real handler end-to-end via `createHandler().fetch(...)`

### Widgets

- `widgets/src/widgets/{name}.tsx` - widget entry point (auto-discovered, includes mounting code)
- `widgets/src/{name}/` - supporting components, styles, stories for that widget
- `widgets/src/components/` - shared components (incl. shadcn/ui)
- `widgets/src/types/mcp-app.ts` - `AppLike` types for UI wiring
- `widgets/src/mocks/mock-app.ts` - `createMockApp()` for tests/Storybook
- `widgets/vite-plugin-widgets.ts` - widget auto-discovery/build plugin
- `assets/` - generated widget bundles (gitignored, never edit by hand)

### End-to-End

- `playwright.config.ts` - webServer config: production server + static widget host + `e2e/host`, all on non-default ports
- `e2e/transport.spec.ts` - real HTTP requests against the built server (no mocked handler)
- `e2e/widget.spec.ts` - drives the real Echo widget in a sandboxed iframe through `e2e/host`
- `e2e/host/host.entry.ts` - a minimal `AppBridge`-based host (bundled by `npm run build:e2e-host`, esbuild); not part of either workspace

## Coding Style & Conventions

- TypeScript strict mode; prefer explicit types at module boundaries
- React components in PascalCase modules (e.g., `Echo.tsx`)
- `npm run lint` enforces import order, unused vars, and hook usage (React/hooks/a11y plugins)
- `npm run format` (Prettier: 2-space indent, double quotes)

## Testing Guidelines

- Vitest for both workspaces; keep widget specs as `.test.ts[x]` under Testing Library, server specs under `server/tests/`
- `npm run test:e2e` (Playwright, Chromium only) runs against a production build and is additive to the Vitest suites, not a replacement — see README's "End-to-End Testing" section
- For manual host testing (MCP Inspector, ChatGPT/Claude.ai via a Pomerium tunnel), follow README's "Testing Your App" section

## Commit & Pull Request Guidelines

- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <subject>` (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`)
- Imperative subject, under 72 characters; scope optional but helpful (`feat(widgets):`, `fix(server):`)
- Explain the _why_ in the commit body when it isn't obvious from the subject
- In PRs: describe user impact, flag risks, note manual test commands, attach screenshots/logs for widget or tooling changes

## Environment & Deployment

Env vars, production build/deploy steps, and the Docker workflow are documented in README's "Configuration" and "Production Deployment" sections — treat those as authoritative rather than duplicating them here. One agent-relevant addition: after tunneling or redeploying, hit `/health` and rerun `npm run inspect` to confirm the MCP manifest is current.

## Troubleshooting

See README's "Troubleshooting" section for standard fixes (widget not loading, build failures, port conflicts, stateless HTTP transport notes).

## Important Notes for AI Assistants

- Always read `server/src/server.ts` to understand current tool implementations before modifying it
- `_meta.ui.resourceUri` is critical for UI binding — never omit it
- Widget components accept an `app` prop typed as `AppLike<T>` so the real `App` or `createMockApp()` can be injected; the internally-created instance must be closed on unmount (never an injected one) — see the `add-widget` skill for the full pattern
- Use `containerDimensions.maxHeight` (not viewport height) for responsive widget sizing
- When adding a new App API call (`openLink`, `sendMessage`, `updateModelContext`, etc.), add its signature to `AppLike` in `widgets/src/types/mcp-app.ts` and the mock in `widgets/src/mocks/mock-app.ts`
- `npm run dev` has no build step; hosted clients (Claude.ai, ChatGPT) need `BASE_URL` set to an https tunnel of port 4444 to load widgets and get HMR
- Widget build (`npm run build:widgets`) is only needed for production, not local dev
- MCP HTTP handling is stateless — each request gets a fresh server instance, no session affinity
- Node.js 24+ is required for ES2023 features and native type stripping
- `@modelcontextprotocol/ext-apps` 2.x sits on the split v2 SDK packages — never add the monolithic v1 `@modelcontextprotocol/sdk` back as a dependency; server-side types (e.g. `ServerContext`) come from `@modelcontextprotocol/server`, widget-side MCP wire types (e.g. `TextContent`) come from `@modelcontextprotocol/client`
- Two TypeScript compilers are installed side by side: `typescript` is aliased to the TS6-compatible package for `typescript-eslint` (which doesn't support TS7 yet — see README's "Why Two TypeScript Compilers?"), while `@typescript/native` (aliased to real TS7) provides the `tsc` binary used for builds/type-checking. If either alias is edited, delete `package-lock.json` before `npm install` so both fully re-resolve.
