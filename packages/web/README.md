# Phantom web

The Phantom web client is a Vite single-page application deployed as static assets to Cloudflare Workers at [phantompane.dev](https://phantompane.dev).

## Local development

From the repository root, start the web client and Phantom API together:

```bash
pnpm dev
```

Build only the web package with:

```bash
pnpm --filter @phantompane/web build
```

The static output is written to `packages/web/dist`.

## Cloudflare deployment

Validate the production build and Wrangler configuration without publishing:

```bash
pnpm --filter @phantompane/web deploy:dry-run
```

Deploy manually after authenticating Wrangler:

```bash
pnpm --filter @phantompane/web deploy
```

Pushes to `main` are deployed by `.github/workflows/deploy-web.yml`. Configure these secrets on the protected `production` GitHub environment:

- `CLOUDFLARE_ACCOUNT_ID`: the account that owns the `phantompane.dev` zone
- `CLOUDFLARE_API_TOKEN`: a token scoped to that account and zone with only the permissions required to edit Workers and the custom domain

The deployment is assets-only: `wrangler.jsonc` has no Worker entry point, and unmatched navigation requests fall back to `index.html` for React Router.
