# VibeCloud — Deployment Guide

## Current host: Cloudflare Workers (static assets + edge proxy)

VibeCloud runs as a **single Cloudflare Worker** that serves the built Vite SPA
as static assets **and** hosts the SoundCloud CORS proxy at `/proxy`. This
replaced two Google Cloud Run services (a static-site container and a Node CORS
proxy). See "Legacy (retired)" at the bottom for the old setup.

### Service details

| Field | Value |
|-------|-------|
| **Worker name** | `vibecloud` |
| **Cloudflare account** | `Micahberkley@gmail.com` (`a6a9f59cc2ed7f627d40af5d7eefae0f`) |
| **Custom domain** | https://vibecloud.theaimogul.com |
| **Zone** | `theaimogul.com` (`34dcd79e3d0bf73802a30b729005aa6e`) |
| **Config** | `wrangler.jsonc` |
| **Worker code** | `worker/index.js` |
| **Static assets** | `dist/` (Vite build output, served via the `ASSETS` binding) |

### Prerequisites

- `wrangler` CLI (v4+), authenticated to the account above. Check with
  `wrangler whoami`. (No `gcloud` needed anymore.)
- Node.js 20+.

### One-command deploy

From the project root (`~/dev/VibeCloud`):

```bash
npm run deploy        # = vite build && wrangler deploy
```

This will:
1. Build the SPA with Vite into `dist/`.
2. Upload the static assets to Cloudflare.
3. Bundle and deploy `worker/index.js`.
4. (Re)attach the `vibecloud.theaimogul.com` custom-domain route. Because the
   zone is on the same Cloudflare account, Cloudflare auto-creates the DNS
   record and provisions the TLS cert on first deploy.

### How routing works

`wrangler.jsonc` declares:

- `assets.directory: "./dist"` + `assets.binding: "ASSETS"` — serve the SPA.
- `assets.not_found_handling: "single-page-application"` — unmatched navigation
  paths return `index.html` (client-side routing fallback).
- `assets.run_worker_first: ["/proxy", "/health"]` — these paths always hit the
  Worker (the proxy + a health check) before the SPA asset fallback. Everything
  else is served as a static asset without invoking the Worker.

The Worker (`worker/index.js`) is an allow-listed CORS proxy: `/proxy?url=<enc>`
forwards to SoundCloud's API (`api-v2.soundcloud.com`, `api.soundcloud.com`,
`cf-media.sndcdn.com`, `api.pushbullet.com` only) and streams the response back
with CORS headers. It strips the upstream `content-encoding`/`content-length`
because workerd auto-decompresses gzip/br bodies (forwarding them stale would
break browser decoding).

### Secrets / env

- `GEMINI_API_KEY` is read from `.env.local` at **build time** and inlined into
  the client bundle by Vite (`vite.config.ts` `define`). Note: any key baked
  into the client bundle is publicly extractable. To make it private, move the
  Gemini call into the Worker and store the key with `wrangler secret put`.

### Local development

```bash
npm run dev           # vite dev on :5175
node cors-proxy/server.js   # optional: local proxy on :8080 (dev only)
```

In `vite dev` the client points at `http://localhost:8080` (the local Node
proxy). In a production build the proxy base is empty, so the app calls
`/proxy` same-origin on the Worker.

### Troubleshooting

- **Auth**: `wrangler whoami` should show `micahberkley@gmail.com`. Re-auth with
  `wrangler login` if needed.
- **Config validation**: `wrangler deploy --dry-run` validates `wrangler.jsonc`
  and bundles without deploying.
- **Live checks**:
  ```bash
  curl https://vibecloud.theaimogul.com/health           # -> ok
  curl "https://vibecloud.theaimogul.com/proxy?url=<encoded SoundCloud API URL>"
  ```
- **Logs**: `wrangler tail vibecloud` (observability is enabled in the config).

---

## Legacy (retired): Google Cloud Run

> Kept for reference. These two services were retired after the Cloudflare
> migration. The custom domain `vibecloud.micahberkley.com` (a Cloud Run domain
> mapping) is no longer the primary host.

| Field | Value |
|-------|-------|
| Static site service | `vibecloud-soundcloud-downloader` |
| CORS proxy service | `vibecloud-cors-proxy` |
| GCP Project ID | `gen-lang-client-0831040732` (Primary Account - Free Credits) |
| Project Number | `765441234018` |
| Region | `us-west1` |
| Old custom domain | https://vibecloud.micahberkley.com |

Old deploy (do not use):

```bash
gcloud run deploy vibecloud-soundcloud-downloader \
  --source . --region us-west1 --project gen-lang-client-0831040732 \
  --allow-unauthenticated --port 8080 --quiet
```

The old build used `Dockerfile` (Node build → `nginx:alpine` serving `dist/` on
8080, SPA routing via `nginx.conf`) and `cors-proxy/` (a Node `http` proxy).
Those files remain in the repo for history but are no longer part of the deploy.
