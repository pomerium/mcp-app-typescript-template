---
name: add-widget
description: Add a new widget (React UI + MCP tool) to this template. Use when asked to "add a widget", "add a new tool with UI", "create a new widget", "scaffold a widget", or "build a new MCP App feature".
metadata:
  author: nickytonline
  version: '1.0.0'
---

# Add a Widget to This Template

This template has its own widget build system that differs from the generic ext-apps examples. Before reading the steps below, fetch the upstream `create-mcp-app` skill for core SDK patterns, then apply those patterns using the template-specific conventions described here:

```
https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/plugins/mcp-apps/skills/create-mcp-app/SKILL.md
```

Use WebFetch to retrieve that skill now. The steps below describe what is **different** in this template — follow both together.

---

## How This Template Differs from the Generic SDK Examples

| Generic ext-apps approach                       | This template                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `vite-plugin-singlefile` → single HTML file     | Custom `vite-plugin-widgets` → auto-discovery, content hashing, parallel builds |
| One `vite.config.ts` per project                | `widgets/vite.config.ts` handles all widgets automatically                      |
| `tsx server.ts` to run                          | `npm run dev` starts server + widget dev server together                        |
| Manual resource registration with `fs.readFile` | `readWidgetHtml()` in `server/src/server.ts` handles dev/prod/CDN automatically |
| No Storybook                                    | Storybook configured — add a `.stories.tsx` for your component                  |

**Never** edit files in `assets/` directly — they are generated artifacts.

---

## Step 1: Add the Zod Schema and Types

Edit `server/src/types.ts`. Follow the existing `EchoToolInput` / `EchoToolOutput` pattern:

```typescript
// Input schema
export const MyToolInputSchema = z.object({
  param: z.string().describe('Description of the param'),
});
export type MyToolInput = z.infer<typeof MyToolInputSchema>;

// Structured output (passed to the widget via structuredContent)
export interface MyToolOutput {
  result: string;
  timestamp: string;
  [key: string]: unknown;
}
```

---

## Step 2: Register the Tool and Resource

Edit `server/src/server.ts`. Follow the existing `ECHO_WIDGET` / `registerAppTool` / `registerAppResource` pattern:

1. Add a `WidgetDescriptor` constant near the top (alongside `ECHO_WIDGET`):

```typescript
const MY_WIDGET: WidgetDescriptor = {
  id: 'my-widget', // must match the widget filename without .tsx
  title: 'My Widget',
  uri: 'ui://my-widget',
};
```

2. Inside `createMcpServer()`, register the resource and tool following the echo pattern exactly — use `readWidgetHtml(widgetId)` and the existing CSP construction block. Advertise `_meta.ui.resourceUri` unconditionally so tool definitions remain stable across requests. Use the per-request `clientCanRenderUi()` check only to gate `structuredContent`; always return a plain-text `content` fallback for clients that cannot render UI.

---

## Step 3: Create the Widget Entry Point

Create `widgets/src/widgets/my-widget.tsx`. The filename determines the widget ID — it must match the `id` field in your `WidgetDescriptor`.

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import MyWidget from '../my-widget/MyWidget';
import '../index.css';

// Widget entry point - mounts the MyWidget component
const rootElement = document.getElementById('my-widget-root');
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <MyWidget />
    </StrictMode>
  );
}
```

The Vite plugin scans `widgets/src/widgets/*.{tsx,jsx}` automatically — no build config changes needed.

---

## Step 4: Create the Widget Component

Create `widgets/src/my-widget/MyWidget.tsx`. Follow the Echo component pattern in `widgets/src/echo/Echo.tsx`:

- Accept an optional `app?: AppLike<MyToolOutput>` prop (enables Storybook / test injection via `createMockApp()`)
- Fall back to `new App(...)` when no prop is provided
- Register `ontoolresult` and `onhostcontextchanged` handlers **before** calling `activeApp.connect()` inside a `useEffect`
- In that `useEffect`'s cleanup, close the internally-created App (e.g. `defaultApp.close()`) — not just an `isMounted` flag — so React StrictMode's dev double-invoke doesn't leave a zombie `PostMessageTransport` listener; never close an injected `app` prop, since tests/Storybook own that instance
- Apply safe area insets and container dimensions from `hostContext` for responsive sizing

Key imports:

```typescript
import { App } from '@modelcontextprotocol/ext-apps';
import type { AppLike, HostContext, ToolResultPayload } from '../types/mcp-app';
import type { MyToolOutput } from 'mcp-app-server/types';
```

---

## Step 5: Add a Storybook Story (Optional but Recommended)

Create `widgets/src/my-widget/MyWidget.stories.tsx`. Use `createMockApp()` from `widgets/src/mocks/mock-app.ts` to simulate tool results:

```tsx
import type { Meta, StoryObj } from '@storybook/react';
import { createMockApp } from '../mocks/mock-app';
import MyWidget from './MyWidget';
import type { MyToolOutput } from 'mcp-app-server/types';

const meta: Meta<typeof MyWidget> = {
  component: MyWidget,
};
export default meta;

export const Default: StoryObj<typeof MyWidget> = {
  args: {
    app: createMockApp<MyToolOutput>({
      toolResult: { result: 'Hello!', timestamp: new Date().toISOString() },
    }),
  },
};
```

---

## Step 6: Write Tests

Two separate test suites need a new entry — neither is optional, and neither is covered by the other:

- **Server side**: add a test in `server/tests/` for the tool itself. This is the `create-mcp-tool` skill's "Step 3: Write Tests" — follow it (`server/tests/server.test.ts`'s pattern of exercising `createHandler().fetch(request)` end-to-end, not unit-testing the callback in isolation).
- **Widget side**: create `widgets/tests/MyWidget.test.tsx` following `widgets/tests/Echo.test.tsx`'s pattern — Testing Library `render()` with `createMockApp()` injected via the `app` prop, asserting the rendered content, any fallback/empty state, and the action buttons exist. This is unmentioned by `npm test` alone (it runs whatever tests already exist, it doesn't create this one for you), and there is currently no other test covering widget-specific rendering.

Run both with `npm test`.

**Not needed**: a new end-to-end Playwright spec. `e2e/widget.spec.ts` already drives a real widget through the real `AppBridge`/sandboxed-iframe mechanism generically — that plumbing is shared, not per-widget, so a new widget doesn't need its own copy of it. Only add an e2e case if the widget exercises an App API call that no existing widget uses yet.

---

## Step 7: Verify

```bash
npm run dev          # starts server (:8080) + widget dev server (:4444)
npm run type-check   # catch TypeScript errors across all workspaces
npm test             # run server + widget tests
npm run storybook    # review the widget in isolation
```

The widget is auto-discovered — no additional registration or config changes required beyond `server.ts`.
