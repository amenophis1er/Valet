/** @vitest-environment jsdom */
/** The panel's Markdown: structure renders, and model text can never become HTML. */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

const html = (text: string) => {
  const box = document.createElement('div');
  box.append(renderMarkdown(document, text));
  return box;
};

describe('renderMarkdown', () => {
  it('renders headings, lists, emphasis, code and paragraphs', () => {
    const box = html('## Fun Facts\n\n**Name** and *origin*\n- one `x`\n- two\n\n1. first\n2. second\n\nLast line');
    expect(box.innerHTML).toBe('<h4>Fun Facts</h4><p><strong>Name</strong> and <em>origin</em></p><ul><li>one <code>x</code></li><li>two</li></ul><ol><li>first</li><li>second</li></ol><p>Last line</p>');
  });

  it('uses a document\'s own heading levels when asked, as document.html does for a PDF', () => {
    const box = document.createElement('div');
    box.append(renderMarkdown(document, '# Title\n## Part\n### Section', { headings: ['h1', 'h2', 'h3'] }));
    expect(box.innerHTML).toBe('<h1>Title</h1><h2>Part</h2><h3>Section</h3>');
  });

  it('keeps HTML in model text as text', () => {
    const box = html('Hello <img src=x onerror="alert(1)"> **<b>bold</b>**');
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('b')).toBeNull();
    expect(box.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('links only http(s), in a new tab, and never javascript:', () => {
    const box = html('[safe](https://en.wikipedia.org/wiki/Togo) and [bad](javascript:alert(1))');
    const links = box.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Togo');
    expect(links[0]!.target).toBe('_blank');
    expect(links[0]!.rel).toBe('noopener noreferrer');
    expect(box.textContent).toContain('[bad](javascript:alert(1))');
  });

  it('never fetches an image: it is a link to it, or what the host makes of it', () => {
    const box = html('Flag: ![The flag of Togo](https://upload.wikimedia.org/togo.svg) and ![](https://x.test/pixel.gif?data=secret)');
    expect(box.querySelectorAll('img')).toHaveLength(0);
    const links = box.querySelectorAll('a');
    expect([...links].map((link) => [link.textContent, link.getAttribute('href'), link.target])).toEqual([
      ['Image: The flag of Togo', 'https://upload.wikimedia.org/togo.svg', '_blank'],
      ['Image', 'https://x.test/pixel.gif?data=secret', '_blank'],
    ]);
    expect(box.textContent).not.toContain('!');
    const custom = document.createElement('div');
    custom.append(renderMarkdown(document, '| a |\n|---|\n| ![pic](https://a.test/p.png) |', { image: (doc, alt, src) => { const el = doc.createElement('button'); el.textContent = `${alt}@${src}`; return el; } }));
    expect(custom.querySelector('td button')?.textContent).toBe('pic@https://a.test/p.png');
  });

  it('renders a table like the Gmail summary, with inline formatting in cells and alignment', () => {
    const box = html('Here:\n\n| # | From | Subject |\n|---|:-----|------:|\n| 1 | **TikTok** | *pushso posted* |\n| 2 | X1 Card | `a\\|b` and a \\| pipe |\n\nAfter.');
    const table = box.querySelector('.table-wrap > table')!;
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['#', 'From', 'Subject']);
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toEqual([['1', 'TikTok', 'pushso posted'], ['2', 'X1 Card', 'a|b and a | pipe']]);
    expect(table.querySelector('td strong')?.textContent).toBe('TikTok');
    expect((table.querySelectorAll('th')[2] as HTMLElement).style.textAlign).toBe('right');
    expect(box.querySelector('p:last-child')!.textContent).toBe('After.');
  });

  it('a bare rule under a line with a pipe is a paragraph and a rule, not a table', () => {
    const box = html('a | b\n---\nafter');
    expect(box.querySelector('table')).toBeNull();
    expect(box.querySelector('hr')).not.toBeNull();
    expect(box.textContent).toContain('a | b');
  });

  it('leaves pipes in ordinary text alone', () => {
    const box = html('a | b\nstill a paragraph');
    expect(box.querySelector('table')).toBeNull();
    expect(box.innerHTML).toBe('<p>a | b<br>still a paragraph</p>');
  });

  it('renders fenced code verbatim, quotes and rules', () => {
    const box = html('```\n<b>**not bold**</b>\n```\n> quoted *text*\n> more\n\n---\nend');
    expect(box.querySelector('pre code')!.textContent).toBe('<b>**not bold**</b>');
    expect(box.querySelector('b')).toBeNull();
    expect(box.querySelector('blockquote')!.innerHTML).toBe('quoted <em>text</em><br>more');
    expect(box.querySelector('hr')).not.toBeNull();
  });
});
