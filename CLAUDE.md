# VibeCloud - SoundCloud Downloader

## Project Overview
Client-side SoundCloud downloader built with React + TypeScript + Vite. Uses Cobalt API as a remote audio extraction bridge, enriches downloads with ID3 metadata, and optionally generates AI summaries via Gemini before pushing to devices via Pushbullet.

## Tech Stack
- **React 19** + **TypeScript** — Single-component SPA in `index.tsx`
- **Vite** — Dev server and build tool
- **Tailwind CSS** (CDN) — Styling via utility classes
- **Lucide React** — Icons
- **@google/genai** — Gemini Flash for AI "vibe check" summaries
- **browser-id3-writer** (ESM import) — MP3 ID3 tagging
- **No backend** — All orchestration is client-side

## Architecture
Single file app (`index.tsx`, ~580 lines). No component splitting, no router, no state management library.

### Data Flow
1. User pastes SoundCloud URL or picks from liked tracks feed
2. Metadata resolved via SoundCloud API v2 (through CORS proxy)
3. Audio extracted via Cobalt API (community instances with fallback)
4. ID3 tags injected (title, artist, cover art)
5. Output: direct download OR Pushbullet push with AI summary

### External Services
- **Cobalt API** — Audio extraction (community instances, no auth required)
- **SoundCloud API v2** — Track metadata + liked tracks feed
- **CORS Proxies** — corsproxy.io and allorigins.win for SoundCloud API
- **Google Gemini** — AI summaries (optional, needs API key)
- **Pushbullet** — Cloud push notifications + S3 file upload

## Commands
```bash
npm run dev      # Start dev server (port 5174)
npm run build    # Production build
npm run preview  # Preview production build
```

## Key Files
- `index.tsx` — Entire app (components, state, API calls, UI)
- `index.html` — Entry point (loads Tailwind CDN)
- `vite.config.ts` — Build config, env var injection, path aliases
- `.env.local` — GEMINI_API_KEY

## Conventions
- **Constants**: UPPER_SNAKE_CASE
- **Functions/vars**: camelCase
- **Types**: PascalCase
- **All styling**: Tailwind utility classes (glass morphism aesthetic)
- **Logging**: Structured LogEntry with types (info, success, error, process, warning, network)
- **Secrets**: Dual buffer pattern — `secrets` (committed) + `tempSecrets` (form buffer)
- **API calls**: Fallback chains (multiple Cobalt instances, multiple CORS proxies)

## Known Considerations
- Hardcoded SoundCloud client ID and user ID in source
- Pushbullet default token in source (user can override via settings)
- No test suite configured
- No linting configured
