# Serve Package Architecture

## Overview

Phantom Serve is split into dedicated backend and frontend packages:

- `packages/server`: Hono backend, RPC API, server-side services, event streams, and production static-file hosting.
- `packages/web`: Vite React SPA, React Router routes, TanStack Query data access, local UI components, and styles.
- `packages/cli`: builds both Serve packages, copies their artifacts into the bundled CLI output, and starts the production server for `phantom serve`.

This keeps runtime service logic separate from browser UI code while preserving a single bundled Serve experience for CLI users.

## Package Layout

```text
packages/
  server/
    package.json
    tsconfig.json
    src/
      index.ts          # Node entrypoint used by CLI and local production runs
      app.ts            # Hono app assembly
      rpc.ts            # Hono RPC route tree and exported AppType
      services.ts       # Serve service orchestration
      event-hub.ts      # SSE event fan-out
      types.ts          # shared API/domain response types
      http.ts           # Hono response/error helpers
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
      components/
      lib/
      styles.css
      *.test.ts
```

## Server

`packages/server` owns the Hono application and exports the RPC type consumed by the web package.

- API routes are mounted under `/api`.
- Static web assets are served for non-API paths in production.
- Unknown non-API `GET` requests fall back to `index.html` for SPA routing.
- The static root is resolved from the bundled artifact location or the explicit `PHANTOM_WEB_DIST_DIR` environment variable.
- Service construction stays injectable so route tests can use mock `ServeServices` instances.

The server package should keep the exported RPC type narrow. Export the RPC route tree for the client type surface, not the static-serving app.

## Web

`packages/web` owns the browser application.

- Vite builds the SPA from `index.html` and `src/main.tsx`.
- React Router defines browser routes in `src/router.tsx`.
- TanStack Query owns fetch state, cache invalidation, loading states, and mutations.
- The API client uses `hc<AppType>()` from Hono and imports `AppType` from `@phantompane/server`.
- UI-only state stays local to the relevant route or component.
- Styling follows `DESIGN.md`; shared UI primitives live under `packages/web/src/components/ui`.

Use targeted query invalidation for project, worktree, chat, and message mutations. Avoid broad `queryClient.invalidateQueries()` calls unless an event truly affects all server state.

## CLI Bundling

The CLI continues to ship a self-contained Phantom Serve experience.

- `packages/cli` builds `@phantompane/server` and `@phantompane/web` before bundling.
- Server artifacts are copied to `packages/cli/dist/app/server`.
- Web artifacts are copied to `packages/cli/dist/app/web`.
- `phantom serve` imports the bundled server entry and sets `HOST`, `PORT`, `PHANTOM_SERVE_CODEX_BIN`, `PHANTOM_SERVE_DATA_DIR`, and `PHANTOM_WEB_DIST_DIR`.

Keep CLI help text, tests, and artifact-copy logic aligned with those bundled paths.

## Turbo And Scripts

Root scripts should remain `turbo run ...` delegators.

- `@phantompane/server#build` emits the production Node entry to `dist`.
- `@phantompane/web#build` runs the Vite production build and type check.
- `@phantompane/cli-private#build` and `@phantompane/cli-private#compile` depend on both Serve package builds.
- `dev` remains persistent and uncached.

## Verification

Use scoped checks while changing one package and the full ready command before shipping broader Serve changes:

- `pnpm --filter @phantompane/server test`
- `pnpm --filter @phantompane/web test`
- `pnpm --filter @phantompane/cli-private test`
- `pnpm --filter @phantompane/server typecheck`
- `pnpm --filter @phantompane/web typecheck`
- `pnpm --filter @phantompane/cli-private build`
- `pnpm ready`

For user-facing Serve changes, also run a manual smoke test:

- Start server and web in dev mode.
- Add a project.
- Select a worktree or chat.
- Send a message.
- Confirm SSE updates refresh messages and chat status.
- Confirm approval events render and can be answered.
- Run `phantom serve --port 9640` from the built CLI and open the UI.

## References

- Hono RPC: https://hono.dev/docs/guides/rpc
- Hono Node.js adapter and static serving: https://hono.dev/docs/getting-started/nodejs
- React Router routing: https://reactrouter.com/start/data/routing
- TanStack Query `QueryClientProvider`: https://tanstack.com/query/latest/docs/framework/react/reference/QueryClientProvider
- Vite dev server proxy: https://vite.dev/config/server-options#server-proxy
- Vite production build: https://main.vite.dev/guide/build
