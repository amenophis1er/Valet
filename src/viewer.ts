/*
 * viewer.html: an image from the conversation, large, in a window of its own
 * beside the browser instead of inside the narrow side panel. It reads the
 * image from session storage by id; nothing is fetched. Click to toggle
 * between fitted and actual size.
 */

import { MEDIA_PREFIX, type Media } from './loop/protocol.js';

declare const chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>>; remove(keys: string[]): Promise<void> } } };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const name = params.get('name') || 'image.jpg';
/** A preview of an attachment not sent yet is stored only for this window: it goes when the window closes. */
const temporary = params.get('temporary') === '1';

const stored = (await chrome.storage.session.get(`${MEDIA_PREFIX}${id}`))[`${MEDIA_PREFIX}${id}`] as Media | undefined;
$('name').textContent = name;
document.title = `${name} — Valet`;
if (!stored || stored.kind !== 'image') {
  $('gone').hidden = false;
} else {
  const blob = new Blob([Uint8Array.from(atob(stored.data), (char) => char.charCodeAt(0))], { type: stored.mediaType });
  const url = URL.createObjectURL(blob);
  const image = $<HTMLImageElement>('image');
  image.src = url;
  image.alt = name;
  image.hidden = false;
  image.onclick = () => $('stage').classList.toggle('actual');
  const download = $('download');
  download.hidden = false;
  download.onclick = () => { const link = document.createElement('a'); link.href = url; link.download = name; link.click(); };
}
if (temporary) addEventListener('pagehide', () => { void chrome.storage.session.remove([`${MEDIA_PREFIX}${id}`]); });
addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
