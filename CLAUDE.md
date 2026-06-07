# VibeCloud - SoundCloud Downloader

## Project Overview
SoundCloud downloader/streamer built with React + TypeScript + Vite. Resolves
tracks via the SoundCloud API v2, downloads audio directly from SoundCloud's own
HLS streams, enriches downloads with ID3 metadata, and optionally generates AI
summaries via Gemini before pushing to devices via Pushbullet. Hosted on
**Cloudflare Workers** (static SPA + an edge CORS proxy) at
`vibecloud.theaimogul.com`.

## Tech Stack
- **React 19** + **TypeScript** — Single-component SPA in `index.tsx`
- **Vite** — Dev server and build tool
- **Tailwind CSS** (CDN) — Styling via utility classes
- **Lucide React** — Icons
- **@google/genai** — Gemini for AI "vibe check" summaries
- **browser-id3-writer** (ESM import from esm.sh) — MP3 ID3 tagging
- **Cloudflare Worker** (`worker/index.js`) — serves the SPA's static assets and
  hosts the `/proxy` CORS bridge to SoundCloud. (Audio segments, artwork,
  Pushbullet and Gemini calls still go directly from the browser.)

## Architecture
Single-file front end (`index.tsx`). No component splitting, no router, no state
management library. One Cloudflare Worker backs it (static assets + `/proxy`).

### Data Flow
1. User pastes a SoundCloud URL or picks from the liked/reposted feed.
2. Metadata resolved via SoundCloud API v2 (through the Worker `/proxy`).
3. Stream URL resolved from the track's HLS transcoding (through `/proxy`); the
   HLS manifest + segments are then fetched **directly** from `*.sndcdn.com` and
   concatenated into an MP3/MP4 blob in the browser.
4. ID3 tags injected (title, artist, cover art).
5. Output: direct download OR Pushbullet push with optional AI summary.

> Note: SoundCloud is migrating some tracks to **encrypted-only HLS**
> (`cbc/ctr-encrypted-hls`). Those can't be played/downloaded by this app (no
> AES-HLS decryption); tracks that still expose plain `hls`/`progressive`
> transcodings work normally.

### External Services
- **SoundCloud API v2** — track metadata, liked/reposted feeds, stream
  resolution (all proxied via the Worker `/proxy`).
- **SoundCloud CDN** (`*.sndcdn.com`) — HLS manifest + audio segments + artwork
  (fetched directly by the browser, not proxied).
- **Cloudflare Worker `/proxy`** — first-party allow-listed CORS proxy (replaces
  the old public proxies and the Cloud Run Node proxy).
- **Google Gemini** — AI summaries (optional, key baked into the client bundle).
- **Pushbullet** — Cloud push notifications + S3 file upload (called directly).

## Commands
```bash
npm run dev      # Start dev server (port 5175); optionally run cors-proxy/server.js on :8080
npm run build    # Production build -> dist/
npm run preview  # Preview production build
npm run deploy   # vite build && wrangler deploy (to Cloudflare)
```

## Key Files
- `index.tsx` — Entire front end (components, state, API calls, UI)
- `worker/index.js` — Cloudflare Worker: static asset host + `/proxy` CORS bridge
- `wrangler.jsonc` — Worker/assets config + `vibecloud.theaimogul.com` custom domain
- `index.html` — Entry point (loads Tailwind CDN, esm.sh importmap)
- `vite.config.ts` — Build config, env var injection, path aliases
- `.env.local` — GEMINI_API_KEY (build-time, inlined into the bundle)
- `DEPLOY.md` — Deployment guide (Cloudflare; legacy Cloud Run noted at bottom)
- `cors-proxy/`, `Dockerfile`, `nginx.conf` — legacy Cloud Run artifacts (retired)

## Conventions
- **Constants**: UPPER_SNAKE_CASE
- **Functions/vars**: camelCase
- **Types**: PascalCase
- **All styling**: Tailwind utility classes (glass morphism aesthetic)
- **Logging**: Structured LogEntry with types (info, success, error, process, warning, network)
- **Networking**: client calls `/proxy?url=<encoded>` (same-origin in prod via the
  Worker; `http://localhost:8080` in `vite dev`). `robustFetch` iterates
  `PROXY_GATES`.

## Known Considerations
- Hardcoded SoundCloud client ID and user ID in source
- Pushbullet default token in source (user can override via settings)
- GEMINI_API_KEY is inlined into the client bundle (publicly extractable) — move
  the Gemini call into the Worker + `wrangler secret put` if it must be private
- Some SoundCloud tracks are encrypted-only HLS and cannot be played/downloaded
- No test suite configured; no linting configured
