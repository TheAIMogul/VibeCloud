# Lessons

## preview_start "reused: true" is not proof of correctness
- **Mistake**: Told user the dev server was running on :5174 because `preview_start` returned `"reused": true`. Actually, a *different project's* Vite (bookmark-brain) was bound to `[::1]:5174` while ours was on `*:5174` IPv4 — browsers prefer `::1`, so the user was hitting the wrong app.
- **Rule**: When `preview_start` returns `reused: true`, run `lsof -i :<port> -P -n` and `ps -p <pid> -o command=` to confirm the listening process belongs to *this* project (matches working directory / binary path). Only then claim success.
- **Bonus rule**: Before picking a port for a new dev server, `lsof -i :<port>` first. Don't assume `vite.config.ts`'s declared port is free system-wide.
