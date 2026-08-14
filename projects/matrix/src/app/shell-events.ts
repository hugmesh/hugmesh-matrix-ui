/**
 * The `window` event names the HOST SHELL publishes and this remote consumes.
 *
 * These are a CONTRACT duplicated by value, not an import: a native-federation
 * remote is built and deployed independently of hugmesh-host-shell, so there is
 * no module to import from — and each remote bootstraps with its own injector,
 * so the shell's services are not reachable either. `window` is the one seam the
 * two genuinely share (the same seam SessionService already uses for its
 * cross-instance 'hug-session-change' broadcast). Keep these strings in step
 * with hugmesh-host-shell's `view-reload.service.ts` /
 * `notification-toast.service.ts`.
 */

/** Dispatched by the shell's Reload button. A listening remote should re-run its
 *  own fetches IN PLACE — no teardown, no scroll-position loss. The shell also
 *  re-navigates the outlet, so ignoring this event degrades to a re-mount rather
 *  than to nothing happening. */
export const VIEW_RELOAD_EVENT = 'hug:view-reload';

/** Dispatched by the shell for each frame of the ONE
 *  `/bff/user/notifications/events` SSE stream it holds open, so remotes get
 *  live server pushes without each opening a second stream of their own.
 *  `detail` is `{ id, category, title, body? }`. */
export const SSE_NOTIFICATION_EVENT = 'hug:sse-notification';

/** The shape carried on {@link SSE_NOTIFICATION_EVENT}'s `detail`. */
export interface ShellSseNotification {
  id: string;
  category: string;
  title: string;
  body?: string | null;
}
