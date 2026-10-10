/* Small pieces shared by the extension's pages. */

export const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>';

export function iconButton(svg: string, label: string, onclick: () => void, extra = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `icon ${extra}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = svg; // Our own constant markup, never page or model text.
  button.onclick = (event) => { event.stopPropagation(); onclick(); };
  return button;
}
