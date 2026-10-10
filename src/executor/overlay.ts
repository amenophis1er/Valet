/*
 * The overlay, painted inside the page the agent works in. It runs in the
 * page, not in the worker: `chrome.scripting.executeScript` serializes it, so
 * it closes over nothing in this module.
 */

/*
 * The overlay: a halo around the page the agent works in, and the agent's own
 * cursor — a teal arrow labelled "Valet", distinct from the owner's pointer.
 * One custom element with a closed shadow root, so page styles cannot reach
 * it; it ignores the pointer entirely, and tree.ts skips it.
 */
export function paintOverlay(state: { halo: boolean; cursor?: { x: number; y: number }; note?: { text: string; why?: string; waiting: boolean } | null }): void {
  const TAG = 'valet-overlay';
  const holder = globalThis as unknown as Record<string, ShadowRoot | undefined>;
  let host = document.querySelector(TAG) as HTMLElement | null;
  if (!state.halo) { host?.remove(); holder['__valetOverlay'] = undefined; return; }
  let root = holder['__valetOverlay'];
  if (!host || !root) {
    host?.remove();
    host = document.createElement(TAG);
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;';
    root = host.attachShadow({ mode: 'closed' });
    // The design system's overlay: the same in every site, light or dark with the system.
    root.innerHTML = `<style>
      :host { all: initial; }
      .ov { --surface: #FFFFFF; --text: #1B1924; --muted: #5D5970; --accent: #6544D6; --accent-hover: #5737C2; --accent-text: #5A3BC9;
        --accent-line: #D3C7F7; --on-accent: #FFFFFF; --hover: #F2F0F8; --focus: #6544D6; --ring: rgba(255,255,255,.7);
        --shadow: 0 18px 44px -12px rgba(30,18,80,.34), 0 3px 10px rgba(30,18,80,.12);
        position: fixed; inset: 0; pointer-events: none; color: var(--text); -webkit-font-smoothing: antialiased;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", sans-serif; }
      @media (prefers-color-scheme: dark) {
        .ov { --surface: #1D1B26; --text: #ECEAF3; --muted: #A9A4BB; --accent: #A08AFF; --accent-hover: #B19EFF; --accent-text: #B7A6FF;
          --accent-line: #4A3F80; --on-accent: #160F2E; --hover: #272535; --focus: #B7A6FF; --ring: rgba(255,255,255,.08);
          --shadow: 0 20px 48px -12px rgba(0,0,0,.7), 0 3px 10px rgba(0,0,0,.4); }
      }
      .halo { position: absolute; inset: 0;
        box-shadow: inset 0 0 0 2px #7C5CF0, inset 0 0 0 3px rgba(255,255,255,.5), inset 0 0 26px 4px rgba(124,92,240,.24);
        animation: halo 2400ms cubic-bezier(.45,0,.2,1) infinite; }
      @keyframes halo { 50% { box-shadow: inset 0 0 0 2px #7C5CF0, inset 0 0 0 3px rgba(255,255,255,.5), inset 0 0 40px 8px rgba(124,92,240,.42); } }
      .cursor { position: absolute; left: 0; top: 0; width: 24px; height: 24px; transform: translate(-100px, -100px); transition: transform 260ms cubic-bezier(.2,.8,.2,1); }
      .cursor svg { display: block; filter: drop-shadow(0 2px 3px rgba(20,10,60,.4)); }
      .cursor .tag { position: absolute; left: 18px; top: 20px; padding: 2px 7px; border-radius: 6px; white-space: nowrap;
        background: #5A3BC9; color: #fff; font-size: 11px; line-height: 14px; font-weight: 600; box-shadow: 0 0 0 1.5px #fff, 0 2px 6px rgba(20,10,60,.3); }
      .note { position: absolute; left: 0; top: 0; width: 290px; max-width: calc(100vw - 24px); padding: 12px 14px 14px; border-radius: 12px; pointer-events: auto;
        background: var(--surface); border: 1px solid var(--accent-line); box-shadow: 0 0 0 1px var(--ring), var(--shadow);
        display: none; flex-direction: column; gap: 6px; transition: left 260ms cubic-bezier(.2,.8,.2,1), top 260ms cubic-bezier(.2,.8,.2,1); }
      .note.on { display: flex; animation: rise 260ms cubic-bezier(.2,.8,.2,1); }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      .note .lead { font-size: 11px; line-height: 14px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--accent-text); }
      .note .what { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
      .note .why { margin: 0; font-size: 12px; line-height: 17px; color: var(--muted); }
      .note .doing { font-size: 12px; line-height: 17px; font-style: italic; color: var(--accent-text); }
      .note .actions { display: flex; gap: 6px; margin-top: 4px; }
      .note button { appearance: none; display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 0 14px; border-radius: 10px; border: 1px solid transparent; background: transparent;
        color: var(--muted); font: inherit; font-size: 13px; line-height: 18px; font-weight: 600; cursor: pointer; }
      .note button:hover { background: var(--hover); color: var(--text); }
      .note button.next { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
      .note button.next:hover { background: var(--accent-hover); color: var(--on-accent); }
      .note button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        .halo { animation: none; box-shadow: inset 0 0 0 2px #7C5CF0, inset 0 0 0 3px rgba(255,255,255,.5), inset 0 0 30px 6px rgba(124,92,240,.3); }
        .cursor, .note { transition: none; } .note.on { animation: none; }
      }
    </style><div class="ov"><div class="halo"></div><div class="cursor"><svg width="24" height="24" viewBox="0 0 24 24">
      <path d="M4.6 3.9 19.8 10.7 12.9 12.9 10.7 19.8Z" fill="#6A48E6" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="tag">Valet</span></div>
      <div class="note"><span class="lead">Next step</span><p class="what"></p><p class="why"></p><span class="doing">Doing it…</span>
      <div class="actions"><button type="button" class="next">Next step</button><button type="button" class="stop">Stop</button></div></div></div>`;
    // The owner's Next or Stop, straight from the page: the worker takes them only from this extension's own scripts.
    const runtime = (globalThis as unknown as { chrome?: { runtime?: { sendMessage(message: unknown): Promise<unknown> } } }).chrome?.runtime;
    (root.querySelector('.note .next') as HTMLButtonElement).onclick = () => { runtime?.sendMessage({ type: 'agent:step' }).catch(() => undefined); };
    (root.querySelector('.note .stop') as HTMLButtonElement).onclick = () => { runtime?.sendMessage({ type: 'agent:stop' }).catch(() => undefined); };
    document.documentElement.append(host);
    holder['__valetOverlay'] = root;
  }
  const cursor = root.querySelector('.cursor') as HTMLElement;
  // The arrow's tip is at (4.6, 3.9) in its 24-unit box: that point goes on the target.
  if (state.cursor) cursor.style.transform = `translate(${state.cursor.x - 5}px, ${state.cursor.y - 4}px)`;
  // The bubble: what comes next and why, with Next while the agent waits; built from text only.
  const note = root.querySelector('.note') as HTMLElement;
  note.classList.toggle('on', !!state.note);
  if (state.note) {
    (note.querySelector('.what') as HTMLElement).textContent = state.note.text;
    const why = note.querySelector('.why') as HTMLElement;
    why.textContent = state.note.why ?? '';
    why.style.display = state.note.why ? 'block' : 'none';
    (note.querySelector('.next') as HTMLElement).style.display = state.note.waiting ? 'inline-flex' : 'none';
    (note.querySelector('.doing') as HTMLElement).style.display = state.note.waiting ? 'none' : 'block';
    // Beside the cursor, kept on screen: below and to the right when there is room, else above or to the left.
    // With no cursor yet (the first step), at the top centre.
    const gap = 16;
    const width = note.offsetWidth;
    const height = note.offsetHeight;
    let left = state.cursor ? state.cursor.x + gap : (innerWidth - width) / 2;
    let top = state.cursor ? state.cursor.y + 36 : 12;
    if (left + width > innerWidth - 8) left = state.cursor ? state.cursor.x - width - gap : innerWidth - width - 8;
    if (top + height > innerHeight - 8) top = state.cursor ? state.cursor.y - height - gap : innerHeight - height - 8;
    note.style.left = `${Math.max(8, Math.round(left))}px`;
    note.style.top = `${Math.max(8, Math.round(top))}px`;
    host.dataset['step'] = state.note.waiting ? state.note.text : '';
  } else {
    delete host.dataset['step'];
  }
}
