import { DestroyRef, inject, signal, Signal } from '@angular/core';

/**
 * The viewport width at which a companion column earns its place.
 *
 * 1200px ($bp-xl) is deliberately not the tablet breakpoint. The chat shell already
 * spends width on a room list and a timeline whose bubbles cap at 46rem, so a third pane
 * only fits once there is genuinely SPARE width beside those two — below it, adding one
 * would squeeze the timeline narrower than it is today, which is a downgrade dressed as a
 * feature. Landscape tablets and desktops clear it; portrait tablets and phones do not.
 */
export const WIDE_VIEWPORT_QUERY = '(min-width: 1200px)';

/**
 * True while the viewport is wide enough for a second column.
 *
 * WHY A SIGNAL RATHER THAN PURE CSS. Hiding a pane with `display: none` still CONSTRUCTS
 * the component, and these panes fetch: a phone would pull a room's full member list it
 * never shows, on someone's data. Gating construction on the signal means narrow
 * viewports do no work at all. It also keeps the DOM honest for assistive tech, which is
 * not fooled by a hidden landmark it can still reach.
 *
 * Falls back to FALSE wherever `matchMedia` is unavailable (SSR, older test
 * environments). Single column is the safe default: it is what every viewport can
 * display, so a missing API degrades to the layout that always works.
 */
export function wideViewport(query: string = WIDE_VIEWPORT_QUERY): Signal<boolean> {
  const mm = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;

  const wide = signal(mm?.matches ?? false);
  if (!mm) {
    return wide.asReadonly();
  }

  const onChange = (e: MediaQueryListEvent) => wide.set(e.matches);
  // addEventListener is the modern API; addListener is kept for older WebKit, which some
  // of the fleet's kiosk/tablet targets still ship.
  if (typeof mm.addEventListener === 'function') {
    mm.addEventListener('change', onChange);
  } else if (typeof (mm as unknown as { addListener?: unknown }).addListener === 'function') {
    (mm as unknown as { addListener: (l: unknown) => void }).addListener(onChange);
  }

  inject(DestroyRef).onDestroy(() => {
    if (typeof mm.removeEventListener === 'function') {
      mm.removeEventListener('change', onChange);
    } else if (typeof (mm as unknown as { removeListener?: unknown }).removeListener === 'function') {
      (mm as unknown as { removeListener: (l: unknown) => void }).removeListener(onChange);
    }
  });

  return wide.asReadonly();
}
