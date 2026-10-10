/**
 * @vitest-environment jsdom
 *
 * `read`: a page's text, as the model gets it — the article, not the menus —
 * and in parts.
 */
import { describe, expect, it } from 'vitest';
import { textParts } from './commands.js';
import { readPageText } from './page.js';
import { cut } from './tree.js';

const ARTICLE = `
  <header><a href="/">Wikipedia</a><form><input placeholder="Search"></form></header>
  <nav role="navigation"><ul><li><a href="/a">Main page</a></li><li><a href="/b">Contents</a></li></ul></nav>
  <div id="sidebar" role="complementary"><p>Donate today</p></div>
  <main id="content">
    <h1>Apollo 11</h1>
    <table class="infobox"><tr><th>Operator</th><td>NASA</td></tr><tr><th>Crew</th><td>3</td></tr></table>
    <p>Apollo 11 was the first mission to land humans on the Moon.<sup class="reference">[1]</sup> It launched on July 16, 1969.</p>
    <h2>Crew <span class="mw-editsection">[edit]</span></h2>
    <ul><li>Neil Armstrong<ul><li>Commander</li></ul></li><li>Buzz Aldrin</li></ul>
    <blockquote>That's one small step for [a] man.</blockquote>
    <div style="display:none">Hidden text</div>
    <p aria-hidden="true">Screen-reader-hidden text</p>
  </main>
  <footer><p>Text is available under a licence.</p></footer>`;

describe('the text of a page', () => {
  it('is the article as light Markdown, without menus, sidebars, footers, hidden parts or footnote markers', () => {
    document.body.innerHTML = ARTICLE;
    const { text } = readPageText();
    expect(text).toBe([
      '# Apollo 11',
      '| Operator | NASA |\n| --- | --- |\n| Crew | 3 |',
      'Apollo 11 was the first mission to land humans on the Moon. It launched on July 16, 1969.',
      '## Crew',
      '- Neil Armstrong\n  - Commander\n- Buzz Aldrin',
      '> That\'s one small step for [a] man.',
    ].join('\n\n'));
  });

  it('reads the body when the page has no main or article', () => {
    document.body.innerHTML = '<nav><a href="/">Home</a></nav><div><h2>Notes</h2><p>One.</p><p>Two.</p></div>';
    expect(readPageText().text).toBe('## Notes\n\nOne.\n\nTwo.');
  });
});

describe('the parts of a long text', () => {
  it('cuts between paragraphs, each part within the size', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40).trim()}.`);
    const parts = textParts(paragraphs.join('\n\n'), 600);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(600);
    expect(parts.join('\n\n')).toBe(paragraphs.join('\n\n'));
  });

  it('cuts a paragraph longer than a part at a space', () => {
    const parts = textParts('word '.repeat(300).trim(), 500);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    expect(parts.join(' ').split(' ')).toHaveLength(300);
  });

  it('is one empty part for an empty page', () => {
    expect(textParts('')).toEqual(['']);
  });
});

describe('an observation cut to fit', () => {
  it('says so, with how much is missing and what to use instead', () => {
    expect(cut('short', 100)).toBe('short');
    expect(cut('x'.repeat(150), 100)).toBe(`${'x'.repeat(100)}\n… [observation cut: 50 more characters of this page are not shown. To read its content, use read.]`);
  });
});
