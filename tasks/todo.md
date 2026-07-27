# PWA + Download Notifications

Goal: installable PWA that fires a system notification when a download finishes
while the user is in another app.

## Plan

- [x] Generate icons (192, 512, maskable 512, apple-touch 180) into `public/`
- [x] `public/manifest.webmanifest` — standalone display, brand colors
- [x] `public/sw.js` — app-shell cache + `notificationclick` + `showNotification` bridge
- [x] Register SW from `index.tsx`; handle updates
- [x] Notification helper: only fire when `document.visibilityState === 'hidden'`
- [x] Permission request behind a user gesture (Settings toggle)
- [x] Wire notifications into: single download, push, bulk batch summary
- [x] `index.html` — manifest link + apple-touch-icon
- [x] Install prompt (`beforeinstallprompt`) surfaced as a button
- [x] Verify: SW active/controlling, manifest valid, cache bypass, offline shell
- [x] Build + deploy

## Constraints that shape the design

- **SW cache must never touch `/proxy`, `/api/*`, `/health`** — those are
  authenticated API calls, not cacheable assets.
- **Android requires `registration.showNotification()`** — plain
  `new Notification()` throws on mobile Chrome.
- **iOS only allows notifications once installed to the Home Screen** (16.4+),
  so the UI has to say so rather than silently failing.
- Hashed `/assets/*` are immutable → cache-first. HTML → network-first so a
  deploy lands immediately instead of being pinned to a stale shell.

## Known limitation (must be stated, not hidden)

Mobile browsers suspend page JS when backgrounded. The HLS fetch + blob assembly
runs in the page, so switching apps mid-download can pause it until you return.
The notification is therefore reliable for downloads that *complete*, but
backgrounding does not guarantee the download keeps progressing on mobile.
Fixing that properly means moving the fetch into the service worker — separate,
larger piece of work.

## Verified

- SW registers at scope `/`, reaches `activated`, controls the page.
- Manifest parses; 3 icons incl. maskable; `/sw.js` served as `text/javascript`.
- Cache bypass holds: after hitting `/health`, no `/proxy`, `/api/*` or `/health`
  entry appeared in any cache. Only shell + icons cached.
- `registration.showNotification()` exists and fails *only* on permission, so the
  code path is sound where permission is granted.
- Full download still works with notifications wired in (46.6 MB saved, no error)
  and still does not auto-play.
- Offline shell: `/`, icons and manifest all resolve from cache.

## Not verifiable here — needs the owner's device

The harness browser hard-denies notification permission, so the actual OS banner
was never rendered. Everything up to the permission gate is verified; the banner
itself needs a real grant on a real device.

## Done
