# Changelog

All notable changes to this project are tracked in this file.

## 2026-02-17

### Added

- Light mode visual treatment with Miami background styling.
- Dark mode Miami-at-night background styling.
- Gold glassmorphism theme toggle styling.
- Palm-tree app icon treatment in header and no-track player state.
- Always-visible bottom player shell (placeholder state when no active source).

### Changed

- Project branding updated to **VibeCloud** across app UI and docs.
- Theme preference key normalized to `vibecloud-theme`.
- Console readability improved (full timestamp display, larger visible area, better wrapping).
- Infinite-scroll load guard improved to prevent duplicate load spam.
- Next-track UX improved with prefetch/loading indicators.

### Fixed

- Player section disappearing after reload behavior.
- Stream-mode control guards (play/pause and footer visibility issues).
- Download-while-playing bug where playback restarted from the beginning.
  - Download/push extraction now avoids interrupting an actively playing track.

## 2026-02-13

### Added

- Cloud Run deployment setup (`Dockerfile`, `nginx.conf`, `DEPLOY.md`).

## 2026-02-12

### Added

- Direct SoundCloud streaming flow with feed + inline player.
- Foldable console panel and infinite-scroll likes loading.
