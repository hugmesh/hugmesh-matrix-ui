/**
 * SPEC harness for VIEWPORT-dependent layout (GUI-19).
 *
 * A component's media queries answer to the viewport, which a Karma page cannot
 * resize per test. `frameAt` clones a rendered fixture, with every stylesheet the
 * test page has (Angular's emulated component styles + styles.scss), into a
 * same-origin iframe of the requested size, so the breakpoints evaluate at that
 * width, and adds the host shell's page-level rules a federated remote really
 * renders under (see `HOST_PAGE_CSS`).
 */

/** Page-level CSS the host shell puts around every federated remote, set here
 *  rather than depending on how the test runner loads global CSS:
 *   - html/body overflow-wrap:anywhere (the host's styles.scss and this remote's
 *     own): what lets a squeezed flex item break MID-WORD;
 *   - the host's Bootstrap reboot box-sizing and GRID `.row` rules, which reach
 *     any remote element that reuses the class name (the composer's and the
 *     role actions' `.row` did: full-width controls, rows wider than their pane);
 *   - the shell's ROUTED-VIEW backpane: the routed element is a flex item of a
 *     column-flex <main> with auto side margins, so it SHRINK-WRAPS its content
 *     and any unbreakable content widens the whole panel past the viewport;
 *   - the host's (and styles.scss's) `.sr` visually-hidden utility, so screen-reader
 *     labels take no room in a row the way they take none on the page;
 *   - no classic scrollbars, which would steal width from the viewport under test. */
export const HOST_PAGE_CSS = [
  'html,body{overflow-wrap:anywhere}html{scrollbar-width:none}',
  'main.host-outlet{display:flex;flex-direction:column;width:100%;max-width:100%}',
  'main.host-outlet>*{display:block;position:relative;margin:8px auto;padding:12px;max-width:90rem;border:1px solid}',
  '*,::before,::after{box-sizing:border-box}',
  '.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.row{--bs-gutter-x:1.5rem;--bs-gutter-y:0;display:flex;flex-wrap:wrap;margin-top:calc(-1 * var(--bs-gutter-y));'
    + 'margin-right:calc(-.5 * var(--bs-gutter-x));margin-left:calc(-.5 * var(--bs-gutter-x))}',
  '.row>*{flex-shrink:0;width:100%;max-width:100%;padding-right:calc(var(--bs-gutter-x) * .5);'
    + 'padding-left:calc(var(--bs-gutter-x) * .5);margin-top:var(--bs-gutter-y)}',
].join('\n');

export interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }

export interface Frame {
  win: Window;
  doc: Document;
  root: HTMLElement;
  box(sel: string): Box;
  lineBoxes(el: Element): number;
  remove(): void;
}

/** Clone `source` + every stylesheet into an iframe `width` x `height`. */
export async function frameAt(source: HTMLElement, width: number, height: number): Promise<Frame> {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = `position:fixed;left:0;top:0;border:0;width:${width}px;height:${height}px;visibility:hidden`;
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open();
  doc.write('<!doctype html><html><head></head><body></body></html>');
  doc.close();
  const loads: Promise<unknown>[] = [];
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    if (source.contains(node)) {
      continue;
    }
    const copy = doc.importNode(node, true) as HTMLElement;
    if (copy instanceof HTMLLinkElement) {
      loads.push(new Promise((resolve) => { copy.onload = resolve; copy.onerror = resolve; }));
    }
    doc.head.appendChild(copy);
  }
  const page = doc.createElement('style');
  page.textContent = HOST_PAGE_CSS;
  doc.head.appendChild(page);
  doc.body.style.margin = '0';
  const root = doc.importNode(source, true) as HTMLElement;
  const outlet = doc.createElement('main');
  outlet.className = 'host-outlet';
  outlet.appendChild(root);
  doc.body.appendChild(outlet);
  await Promise.all(loads);
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  const win = iframe.contentWindow!;
  return {
    win,
    doc,
    root,
    box(sel: string): Box {
      const el = root.querySelector(sel);
      if (!el) {
        throw new Error(`layout frame: nothing matched "${sel}"`);
      }
      return el.getBoundingClientRect();
    },
    lineBoxes(el: Element): number {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0.5).map((r) => Math.round(r.top)));
      return tops.size;
    },
    remove: () => iframe.remove(),
  };
}
