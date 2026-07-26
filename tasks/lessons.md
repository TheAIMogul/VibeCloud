# Lessons

## preview_start "reused: true" is not proof of correctness
- **Mistake**: Told user the dev server was running on :5174 because `preview_start` returned `"reused": true`. Actually, a *different project's* Vite (bookmark-brain) was bound to `[::1]:5174` while ours was on `*:5174` IPv4 — browsers prefer `::1`, so the user was hitting the wrong app.
- **Rule**: When `preview_start` returns `reused: true`, run `lsof -i :<port> -P -n` and `ps -p <pid> -o command=` to confirm the listening process belongs to *this* project (matches working directory / binary path). Only then claim success.
- **Bonus rule**: Before picking a port for a new dev server, `lsof -i :<port>` first. Don't assume `vite.config.ts`'s declared port is free system-wide.

## requestAnimationFrame never fires in the Browser-pane preview
- **Mistake**: Wrote a scroll-restore that scheduled its work in `requestAnimationFrame`. It silently never ran, and I burned several cycles inferring causes (effect ordering, dep arrays, cache clobbering) from indirect evidence before instrumenting.
- **Cause**: The preview tab renders offscreen. `requestAnimationFrame` callbacks are throttled to never; `setTimeout` still fires. Proven with a 2-line probe: schedule one of each, await 600ms, compare.
- **Rule**: For deferred DOM work that must survive a background/offscreen tab (scroll restore, measure-then-position), use `setTimeout`, not rAF. This is a correctness fix, not just a test workaround — real background tabs throttle rAF the same way.
- **Rule**: In that same context `window.innerHeight` and `clientHeight` read as `0`, so `calc(100vh - Xpx)` computes to `0px`. Don't diagnose layout from those numbers there — measure `scrollHeight` or take a screenshot instead.
- **Meta-rule**: Two failed inferences about *why* something didn't run = stop inferring, add a temporary `window.__debug` write, and read the truth.
