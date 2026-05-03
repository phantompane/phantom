# Migration Plan: Split `packages/app` into `packages/server` and `packages/web`

## Goals

- Replace the combined TanStack Start/Nitro application in `packages/app` with two packages:
  - `packages/server`: backend API and production static-file host.
  - `packages/web`: Vite SPA frontend.
- Use Hono RPC for client/server API typing instead of raw REST-style `fetchJson` calls.
- Use React Router for SPA routing.
- Use TanStack Query for fetch state, cache invalidation, loading states, and mutations.
- Preserve the current Phantom Serve user experience and `DESIGN.md` constraints.
- Keep `phantom serve` working from the bundled CLI artifact.

## Current State

- `packages/app` currently owns both frontend and backend code.
- `packages/app/vite.config.ts` uses `@tanstack/react-start/plugin/vite` and `nitro/vite`.
- API route handlers live under `packages/app/src/routes/api/**` and call `getServeServices()`.
- Backend service logic already has a useful boundary under `packages/app/src/server/**`.
- The frontend route is mostly `packages/app/src/routes/index.tsx`; it uses local React state, effects, `EventSource`, and a local `fetchJson` helper.
- `packages/cli` builds `packages/app`, copies `.output`, and `phantom serve` imports `.output/server/index.mjs`.
- `turbo.json` has special `app-private#build` dependencies and `.output/**` outputs.

## Target Package Layout

```text
packages/
  server/
    package.json
    tsconfig.json
    src/
      index.ts          # Node entrypoint used by CLI and local production runs
      app.ts            # Hono app assembly
      rpc.ts            # Hono RPC route tree and exported AppType
      services.ts       # moved from packages/app/src/server/services.ts
      event-hub.ts      # moved from packages/app/src/server/event-hub.ts
      types.ts          # shared API/domain response types
      http.ts           # Hono response/error helpers, if still useful
      static.ts         # production SPA static serving fallback
      *.test.ts
  web/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      router.tsx
      routes/
        root.tsx
        home.tsx
      api/
        client.ts       # hc<AppType>() setup
        query-keys.ts
        queries.ts
        mutations.ts
        events.ts       # EventSource helpers
      components/
      lib/
      styles.css
      *.test.ts
```

Delete `packages/app` only after `packages/server`, `packages/web`, `packages/cli`, and root Turbo references are updated.

## Package Dependencies

- `packages/server`
  - Runtime: `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod`.
  - Existing workspace dependencies: `@phantompane/codex`, `@phantompane/core`, `@phantompane/git`, `@phantompane/state`.
  - Dev/build dependencies: `typescript`, `vitest`, `tsdown` if a bundled Node entry is required.
- `packages/web`
  - Runtime: `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `hono`, `lucide-react`, Radix UI packages currently used by local UI components.
  - Type-only dependency: `@phantompane/server` for the Hono RPC `AppType`.
  - No dependency on backend runtime internals except exported RPC types.

Prefer package names `@phantompane/server` and `@phantompane/web` with `"private": true`, matching the existing internal package naming style.

## Hono RPC Server Plan

Create the RPC route tree in `packages/server/src/rpc.ts` and export its type:

```ts
export const rpcRoutes = new Hono()
  .get("/health", ...)
  .get("/auth", ...)
  .get("/models", ...)
  .get("/projects", ...)
  .post("/projects", ...)
  .delete("/projects/:projectId", ...);

export type AppType = typeof rpcRoutes;
```

Then mount it in the full server app:

```ts
export function createApp() {
  const app = new Hono();
  app.route("/api", rpcRoutes);
  mountStaticWebAssets(app);
  return app;
}
```

Recommended RPC members:

| Current behavior                 | Hono RPC member                                                            |
| -------------------------------- | -------------------------------------------------------------------------- |
| Health check                     | `client.health.$get()`                                                     |
| Auth read                        | `client.auth.$get()`                                                       |
| List/create projects             | `client.projects.$get()` / `client.projects.$post({ json })`               |
| Delete project                   | `client.projects[":projectId"].$delete({ param })`                         |
| List project chats and worktrees | `client.projects[":projectId"].chats.$get({ param, query })`               |
| Create chat                      | `client.projects[":projectId"].chats.$post({ param, json })`               |
| Delete worktree                  | `client.projects[":projectId"].worktrees.$delete({ param, json })`         |
| Sync worktree branch             | `client.projects[":projectId"].worktrees.sync.$post({ param, json })`      |
| Read chat / skills / file search | `client.chats[":chatId"].$get({ param, query })`                           |
| Read/send messages               | `client.chats[":chatId"].messages.$get()` / `$post({ json })`              |
| Interrupt or steer chat          | `client.chats[":chatId"].interrupt.$post()` / `steer.$post({ json })`      |
| Answer approval                  | `client.chats[":chatId"].approvals[":requestId"].$post({ param, json })`   |
| Chat event stream                | keep as Hono `GET /api/chats/:chatId/events`; consume with `EventSource`   |
| Global event stream              | keep as Hono `GET /api/events`; consume with `EventSource` if still needed |

Implementation notes:

- Move `packages/app/src/server/**` to `packages/server/src/**` first, preserving tests.
- Convert route request parsing to Zod validators with `zValidator("json" | "query" | "param", schema)` where practical.
- Return `c.json(body, literalStatus)` for success and error responses so Hono RPC can infer response types.
- Avoid `c.notFound()` for RPC routes unless the `NotFoundResponse` type is augmented; prefer typed JSON errors.
- Keep `createSseResponse`, `parseLastEventId`, and `EventHub` for streaming. TanStack Query should react to SSE events by invalidating relevant queries, not by storing the event stream itself as query data.
- Be careful with Hono RPC path params: `hc` does not URL-encode path params. If any param may contain `/`, either encode explicitly and test it, use a route regex, or move that value into the request body.
- Keep service construction injectable so server route tests can use mock `ServeServices` instances.

## Web SPA Plan

Replace TanStack Start with a normal Vite SPA:

- Remove `@tanstack/react-start`, `@tanstack/react-router`, Nitro, `routeTree.gen.ts`, and `src/routes/api/**` from the frontend package.
- Add `index.html` with the current metadata currently produced by `__root.tsx`.
- Add `src/main.tsx` with `createRoot`, `QueryClientProvider`, and `RouterProvider`.
- Use React Router route objects via `createBrowserRouter`.
- Keep the current app shell and UI components; do not redesign the interface during the framework migration.
- Move the current `Home` component out of `src/routes/index.tsx` into `src/routes/home.tsx` or a feature module.
- Keep UI-only state local: selected project, selected worktree, selected chat, composer text, dialogs, selected files/skills, scroll restoration refs, and expanded sidebar rows.
- Use `packages/web/vite.config.ts` with `@vitejs/plugin-react` and `@tailwindcss/vite` only.
- Configure Vite dev proxy for `/api` to the server dev port so local development stays same-origin from the web app perspective.

React Router can start with one route:

```ts
createBrowserRouter([
  {
    path: "/",
    Component: RootRoute,
    children: [{ index: true, Component: HomeRoute }],
  },
]);
```

Add more routes later only if the product actually needs URL-addressable subviews.

## TanStack Query Plan

Create a typed RPC client:

```ts
import { hc } from "hono/client";
import type { AppType } from "@phantompane/server";

export const api = hc<AppType>(getApiBaseUrl());
```

Add a small response wrapper:

- Accept the `Response` returned by Hono RPC.
- Parse JSON.
- Throw an `Error` using `{ error: { message } }` when `!response.ok`.
- Return typed JSON on success.

Suggested query keys:

```ts
export const queryKeys = {
  auth: ["auth"] as const,
  models: ["models"] as const,
  projects: ["projects"] as const,
  projectData: (projectId: string, sync: boolean) =>
    ["projects", projectId, "data", { sync }] as const,
  chat: (chatId: string) => ["chats", chatId] as const,
  messages: (chatId: string) => ["chats", chatId, "messages"] as const,
  chatSkills: (chatId: string) => ["chats", chatId, "skills"] as const,
  fileSearch: (chatId: string, query: string) =>
    ["chats", chatId, "files", query] as const,
};
```

Convert manual fetch functions to hooks:

- `refreshProjects` -> `useProjects()` plus `useQueries` or a dedicated `useProjectData(projectId, sync)`.
- `refreshModels` -> `useModels()`.
- `refreshSelectedChat` -> `useChat(chatId)`.
- `refreshMessages` -> `useMessages(chatId)`.
- `refreshChatContext` -> `useChatSkills(chatId)`.
- Debounced file search -> `useFileSearch(chatId, query)` with `enabled`.
- Add project/create chat/delete worktree/sync worktree/send message/interrupt/approval -> `useMutation` hooks with targeted invalidation.

Mutation invalidation rules:

- Project create/delete: invalidate `projects` and affected `projectData`.
- Chat create/send/interrupt/steer/approval: invalidate `chat`, `messages`, and the selected project's `projectData`.
- Worktree delete/sync: invalidate the selected project's `projectData`.
- SSE chat events: invalidate `messages(chatId)`, `chat(chatId)`, and affected `projectData`; set pending approval local state from event payloads.
- Avoid broad `queryClient.invalidateQueries()` without a key unless the event type truly affects all server state.

Keep the current skeleton components, but drive them from TanStack Query state (`isPending`, `isFetching`, `isError`, mutation `isPending`) instead of bespoke loading booleans where possible.

## Server Static Hosting and CLI Bundling

The CLI should continue to ship one self-contained Phantom Serve experience.

Production serving:

- `packages/server` should start the Hono Node server via `@hono/node-server`.
- It should serve `/api/**` from Hono RPC.
- It should serve `packages/web/dist` assets for non-API paths.
- It should fallback unknown non-API `GET` requests to `index.html` for SPA routing.
- The static root should be resolved from `import.meta.url` or an explicit `PHANTOM_WEB_DIST_DIR`, not from `process.cwd()`.

CLI changes:

- Replace `packages/cli` references to `packages/app/.output`.
- Build `packages/server` and `packages/web` before the CLI bundle.
- Copy `packages/server/dist` and `packages/web/dist` into `packages/cli/dist/app`.
- Update `serveHandler` to import the new bundled server entry, for example `dist/app/server/index.js`.
- Set `HOST`, `PORT`, `PHANTOM_SERVE_CODEX_BIN`, `PHANTOM_SERVE_DATA_DIR`, and `PHANTOM_WEB_DIST_DIR` before importing the server entry.
- Update `packages/cli/build-executable.ts`, `copy-app-assets.ts`, help text, and tests to remove `.output/server/index.mjs` and TanStack Start wording.

## Turbo and Scripts Plan

Do not add root task logic. Keep root scripts as `turbo run ...` delegators.

Package scripts:

- `packages/server`
  - `dev`: start the Hono Node server locally.
  - `build`: emit the production Node entry to `dist`.
  - `lint`, `fix`, `typecheck`, `test`: match existing package patterns.
- `packages/web`
  - `dev`: `vite dev`.
  - `build`: `vite build && tsc --noEmit`.
  - `preview`: `vite preview`.
  - `lint`, `fix`, `typecheck`, `test`: match existing package patterns.
- `packages/cli`
  - Replace `build-app` with a script that builds both `@phantompane/server` and `@phantompane/web`.
  - Replace `copy-app` with a script that copies both server and web artifacts.

`turbo.json` changes:

- Remove `app-private#build`.
- Add package-specific outputs for `@phantompane/server#build` and `@phantompane/web#build`.
- Make `@phantompane/cli-private#build` and `@phantompane/cli-private#compile` depend on both server and web builds.
- Keep `dev` persistent and uncached.
- If Hono RPC type inference becomes slow in the web package, add a server declaration-generation task and make web typecheck/build depend on that generated type surface.

## Migration Phases

1. **Scaffold packages**
   - Create `packages/server` and `packages/web` with package manifests, tsconfigs, scripts, and minimal entries.
   - Keep `packages/app` intact until the new package boundaries build.

2. **Move backend services**
   - Move `src/server/**` and its tests into `packages/server/src`.
   - Fix imports from `../server/types` to local server package imports.
   - Run the moved server service tests.

3. **Port API handlers to Hono RPC**
   - Convert each `src/routes/api/**` handler into `rpcRoutes`.
   - Add Zod validators and typed JSON errors.
   - Add Hono route tests using `app.request()` and mocked services.
   - Keep SSE endpoints as Hono routes.

4. **Create Vite SPA shell**
   - Move frontend components, styles, lib utilities, and the home route into `packages/web`.
   - Replace TanStack Router root document with `index.html`, `main.tsx`, and React Router.
   - Verify the UI renders with static/mock data before connecting all queries.

5. **Replace manual fetch state**
   - Add Hono RPC client setup.
   - Add TanStack Query provider, query keys, query hooks, and mutation hooks.
   - Replace `fetchJson`, `refresh*` functions, and bespoke fetch loading state.
   - Wire SSE events to targeted query invalidation.

6. **Integrate build and CLI**
   - Update package scripts and `turbo.json`.
   - Update `packages/cli` build/copy/serve paths.
   - Update CLI tests and help text.
   - Remove `packages/app` and generated TanStack Start files.

7. **Cleanup and verification**
   - Remove unused dependencies from the lockfile.
   - Run scoped tests during each phase.
   - Run `pnpm ready` before finalizing the migration.

## Verification Checklist

- `pnpm --filter @phantompane/server test`
- `pnpm --filter @phantompane/web test`
- `pnpm --filter @phantompane/cli-private test`
- `pnpm --filter @phantompane/server typecheck`
- `pnpm --filter @phantompane/web typecheck`
- `pnpm --filter @phantompane/cli-private build`
- `pnpm ready`
- Manual smoke test:
  - Start server and web in dev mode.
  - Add a project.
  - Select a worktree/chat.
  - Send a message.
  - Confirm SSE updates refresh messages and chat status.
  - Confirm approval events still render and can be answered.
  - Run `phantom serve --port 9640` from the built CLI and open the UI.

## Risks and Mitigations

- **Hono RPC type inference can become heavy.**
  - Keep the exported RPC type narrow.
  - Export only the RPC route tree, not the static-serving app.
  - Consider generated declarations if web typecheck slows down.

- **SSE does not map cleanly to TanStack Query.**
  - Keep SSE as a separate event subscription.
  - Use events to update local transient state and invalidate query keys.

- **CLI artifact paths will change substantially.**
  - Update copy/build scripts and fixture tests in the same phase.
  - Keep `serveHandler` environment behavior compatible with existing options.

- **SPA fallback can accidentally capture API misses.**
  - Mount `/api` before static middleware.
  - Return typed JSON errors for `/api/**`.
  - Only fallback to `index.html` for non-API `GET` requests.

- **Framework migration could accidentally redesign the UI.**
  - Keep the existing components, CSS tokens, and layout intact.
  - Apply `DESIGN.md`: dense developer workspace, subdued surfaces, accessible compact controls, no decorative layout changes.

## References

- Hono RPC: https://hono.dev/docs/guides/rpc
- Hono Node.js adapter and static serving: https://hono.dev/docs/getting-started/nodejs
- React Router data routing: https://reactrouter.com/start/data/routing
- TanStack Query `QueryClientProvider`: https://tanstack.com/query/latest/docs/framework/react/reference/QueryClientProvider
- Vite dev server proxy: https://vite.dev/config/server-options#server-proxy
- Vite production build: https://main.vite.dev/guide/build
