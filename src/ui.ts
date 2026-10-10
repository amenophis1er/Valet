/* Small pieces shared by the extension's pages. */

export const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" /></svg>';

export function iconButton(svg: string, label: string, onclick: () => void, extra = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = `icon ${extra}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = svg; // Our own constant markup, never page or model text.
  button.onclick = (event) => { event.stopPropagation(); onclick(); };
  return button;
}
