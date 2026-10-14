/*
 * The conversation as something the owner takes away: Markdown for the
 * clipboard, or one self-contained HTML file with the screenshots in it.
 * Built from the transcript the panel shows, so what is exported is what the
 * owner saw — every line is text, never markup from a page or a model.
 */

import type { Media, TranscriptEntry } from './loop/protocol.js';

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char));

/** The whole conversation as Markdown: what was said, the steps as a list under it, and the agent's notepad at the end. */
export function conversationMarkdown(transcript: TranscriptEntry[], title = 'Valet conversation', notepad?: string): string {
  const lines: string[] = [`# ${title}`, ''];
  for (const entry of transcript) {
    switch (entry.kind) {
      case 'owner': {
        lines.push(`**You:** ${entry.text}`);
        for (const attachment of entry.attachments ?? []) lines.push(`- 📎 ${attachment.name}`);
        lines.push('');
        break;
      }
      case 'agent': lines.push(`**Agent:**`, '', entry.text, ''); break;
      case 'action': lines.push(`- ${stepText(entry)}${entry.detail ? ` (${entry.detail})` : ''}`); break;
      case 'file': lines.push(`- 📄 ${entry.name} (${entry.bytes} bytes)`); break;
      case 'notice': lines.push(`- _${entry.text}_`); break;
    }
  }
  if (notepad) lines.push('', '## Agent\'s notepad', '', ...notepad.split('\n').map((line) => `> ${line}`), '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** A step as the owner reads it, in the panel and in exports: under way, done, or with its outcome. */
export function stepText(entry: { text: string; outcome: string }): string {
  if (entry.outcome === 'ok') return entry.text;
  if (entry.outcome === 'pending') return `${entry.text}…`;
  return `${entry.text} — ${entry.outcome}`;
}

/** Media by id, as the panel read it from storage; missing ones are shown as gone. */
export type MediaLookup = (id: string) => Media | undefined;

/**
 * One HTML file: the conversation in the panel's own words, screenshots and
 * attached images as data URLs, files as text (a PDF as a link to download).
 * Opens anywhere, prints as long as it is.
 */
export function conversationHtml(transcript: TranscriptEntry[], media: MediaLookup, title = 'Valet conversation', notepad?: string): string {
  const parts: string[] = [];
  const image = (id: string, alt: string) => {
    const stored = media(id);
    if (stored?.kind !== 'image') return `<p class="gone">${escapeHtml(alt)} (no longer kept)</p>`;
    return `<img src="data:${stored.mediaType};base64,${stored.data}" alt="${escapeHtml(alt)}">`;
  };
  let steps: string[] = [];
  let actions = 0;
  const flush = () => {
    if (steps.length === 0) return;
    parts.push(`<details class="steps"><summary>${actions} step${actions === 1 ? '' : 's'}</summary><ol>${steps.join('')}</ol></details>`);
    steps = [];
    actions = 0;
  };
  for (const entry of transcript) {
    if (entry.kind !== 'action' && entry.kind !== 'notice') flush();
    switch (entry.kind) {
      case 'owner': {
        const attachments = (entry.attachments ?? []).map((attachment) => attachment.id
          ? image(attachment.id, attachment.name) : `<span class="chip">📎 ${escapeHtml(attachment.name)}</span>`).join('');
        parts.push(`<div class="owner"><p>${escapeHtml(entry.text)}</p>${attachments ? `<div class="attachments">${attachments}</div>` : ''}</div>`);
        break;
      }
      case 'agent': parts.push(`<div class="agent"><pre>${escapeHtml(entry.text)}</pre></div>`); break;
      case 'action': {
        const text = stepText(entry);
        actions += 1;
        steps.push(`<li class="${entry.outcome}">${escapeHtml(text)}${entry.detail ? `<small>${escapeHtml(entry.detail)}</small>` : ''}</li>`);
        if (entry.image) { flush(); parts.push(`<figure>${image(entry.image.id, entry.text)}</figure>`); }
        break;
      }
      case 'file': {
        const stored = media(entry.id);
        const body = stored?.kind === 'file' ? `<pre>${escapeHtml(stored.content)}</pre>`
          : stored?.kind === 'pdf' ? `<p><a href="data:application/pdf;base64,${stored.data}" download="${escapeHtml(stored.name)}">Download ${escapeHtml(stored.name)}</a></p>`
            : '<p class="gone">No longer kept.</p>';
        parts.push(`<details class="file"><summary>📄 ${escapeHtml(entry.name)} (${entry.bytes} bytes)</summary>${body}</details>`);
        break;
      }
      case 'notice': steps.push(`<li class="notice">${escapeHtml(entry.text)}</li>`); break;
    }
  }
  flush();
  if (notepad) parts.push(`<details class="file notepad"><summary>🗒 Agent's notepad</summary><pre>${escapeHtml(notepad)}</pre></details>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  body { margin: 0 auto; max-width: 720px; padding: 24px 16px 48px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #17191c; background: #fff; }
  h1 { font-size: 18px; margin: 0 0 4px; } .when { color: #5d6368; font-size: 13px; margin: 0 0 20px; }
  .owner { margin: 14px 0 14px 15%; background: #0f766e; color: #fff; border-radius: 16px 16px 4px 16px; padding: 8px 13px; }
  .owner p { margin: 0; white-space: pre-wrap; } .attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .attachments img { max-width: 160px; border-radius: 8px; } .chip { background: rgba(0,0,0,.14); border-radius: 8px; padding: 2px 8px; font-size: 13px; }
  .agent pre, .file pre { white-space: pre-wrap; font: inherit; margin: 10px 0; }
  .steps { margin: 4px 0; font-size: 13.5px; color: #5d6368; } .steps summary { cursor: pointer; }
  .steps ol { margin: 4px 0 8px; padding-left: 22px; } .steps li small { display: block; font-size: 12.5px; }
  .steps .refused, .steps .skipped { color: #a15c00; } .steps .unknown, .steps .error { color: #b3261e; } .steps .notice { font-style: italic; list-style: none; margin-left: -18px; }
  figure { margin: 6px 0 12px; } figure img { max-width: 100%; border: 1px solid #dde3e4; border-radius: 10px; }
  .file { border: 1px solid #dde3e4; border-radius: 10px; padding: 8px 12px; margin: 10px 0; } .gone { color: #5d6368; font-style: italic; }
  @media print { .steps { break-inside: avoid; } figure img { max-height: 90vh; } }
</style></head><body>
<h1>${escapeHtml(title)}</h1><p class="when">Saved ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from Valet.</p>
${parts.join('\n')}
</body></html>
`;
}
