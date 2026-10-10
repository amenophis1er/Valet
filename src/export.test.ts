import { describe, expect, it } from 'vitest';
import { conversationHtml, conversationMarkdown } from './export.js';
import type { Media, TranscriptEntry } from './loop/protocol.js';

const transcript: TranscriptEntry[] = [
  { kind: 'owner', text: 'Find the <blue> mug', attachments: [{ kind: 'image', name: 'shot.jpg', bytes: 10, id: 'attached-1', width: 4, height: 3 }, { kind: 'text', name: 'notes.txt', bytes: 3 }] },
  { kind: 'notice', text: 'Using skill: Shop tips' },
  { kind: 'action', text: 'Opened https://shop.test', outcome: 'ok', detail: 'Shop — https://shop.test/' },
  { kind: 'action', text: 'Took a screenshot', outcome: 'ok', image: { id: 'shot-1', width: 1280, height: 800 } },
  { kind: 'action', text: 'Click button "Pay"', outcome: 'refused', detail: 'The owner did not allow it.' },
  { kind: 'file', id: 'file-1', name: 'mugs.csv', mimeType: 'text/csv', bytes: 12 },
  { kind: 'file', id: 'file-2', name: 'mugs "report".pdf', mimeType: 'application/pdf', bytes: 4 },
  { kind: 'agent', text: 'The **blue** mug costs $12.40.' },
];
const stored = new Map<string, Media>([
  ['shot-1', { kind: 'image', mediaType: 'image/jpeg', data: 'AAAA' }],
  ['file-1', { kind: 'file', name: 'mugs.csv', mimeType: 'text/csv', content: 'name,price\nmug,12.40' }],
  ['file-2', { kind: 'pdf', name: 'mugs "report".pdf', data: 'JVBERg==' }],
]);

describe('conversationMarkdown', () => {
  it('writes what was said, with the steps as a list, and never loses the outcome of a refused one', () => {
    const md = conversationMarkdown(transcript);
    expect(md).toContain('**You:** Find the <blue> mug\n- 📎 shot.jpg\n- 📎 notes.txt');
    expect(md).toContain('- _Using skill: Shop tips_');
    expect(md).toContain('- Opened https://shop.test (Shop — https://shop.test/)');
    expect(md).toContain('- Click button "Pay" — refused (The owner did not allow it.)');
    expect(md).toContain('- 📄 mugs.csv (12 bytes)');
    expect(md).toContain('**Agent:**\n\nThe **blue** mug costs $12.40.');
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('conversationHtml', () => {
  it('is one self-contained page: text escaped, screenshots as data URLs, files inline, missing media named as gone', () => {
    const html = conversationHtml(transcript, (id) => stored.get(id));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Find the &lt;blue&gt; mug');
    expect(html).not.toContain('<blue>');
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA" alt="Took a screenshot">');
    expect(html).toContain('shot.jpg (no longer kept)');
    expect(html).toContain('<pre>name,price\nmug,12.40</pre>');
    expect(html).toContain('<a href="data:application/pdf;base64,JVBERg==" download="mugs &quot;report&quot;.pdf">Download mugs &quot;report&quot;.pdf</a>');
    expect(html).toContain('<li class="refused">Click button &quot;Pay&quot; — refused<small>The owner did not allow it.</small></li>');
    expect(html).toContain('<summary>2 steps</summary>');
    expect(html).toContain('<pre>The **blue** mug costs $12.40.</pre>');
    // Nothing outside the file: no scripts, no external URLs.
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/src="https?:/);
  });
});
