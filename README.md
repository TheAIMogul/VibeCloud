# VibeCloud

VibeCloud is a SoundCloud utility app for streaming, downloading, and pushing tracks with metadata.

## What it does

- Loads liked tracks from a target SoundCloud user.
- Resolves tracks/playlists from pasted SoundCloud URLs.
- Streams tracks directly in the in-app player.
- Downloads tagged MP3 files (title, artist, artwork).
- Pushes files to Pushbullet (with optional Gemini-generated vibe text).
- Shows live operation/network logs in a foldable console.

## UI highlights

- Light/dark theme toggle.
- Always-visible bottom player.
- Auto-advance and repeat controls.
- Next-track prefetch behavior to reduce skip delay.
- Visual skip/loading indicator on next-track control.

## Tech stack

- React + TypeScript
- Vite
- Tailwind classes + custom CSS
- `browser-id3-writer` for MP3 tags
- `@google/genai` for optional summary text

## Local development

Prerequisites:

- Node.js 20+

Install and run:

```bash
npm ci
npm run dev
```

Build:

```bash
npm run build
```

Preview production build locally:

```bash
npm run preview
```

## Configuration

- `pb_access_token` is stored in browser localStorage from the app settings panel.
- Gemini API usage depends on your configured key/context for `@google/genai`.

## Deployment (Cloud Run)

Primary deployment instructions are in `DEPLOY.md`.

Quick command:

```bash
gcloud run deploy vibecloud-soundcloud-downloader \
  --source . \
  --region us-west1 \
  --project gen-lang-client-0831040732 \
  --allow-unauthenticated \
  --port 8080 \
  --quiet
```

Production URL:

- https://vibecloud.micahberkley.com
