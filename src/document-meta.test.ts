import { describe, expect, it } from 'vitest';
import { documentParts, paperFor, sourceLink } from './document-meta.js';

describe('what a document says about itself', () => {
  it('reads the header block: title, subtitle and a list of sources', () => {
    const parts = documentParts([
      '---',
      'title: Apollo 11',
      'subtitle: "The mission in eight points"',
      'sources:',
      '  - Wikipedia, "Apollo 11" — https://en.wikipedia.org/wiki/Apollo_11',
      '  - NASA — https://www.nasa.gov/mission/apollo-11/',
      '---',
      '',
      '## Summary',
      'First crewed landing.',
    ].join('\n'), 'apollo-11');
    expect(parts).toEqual({
      title: 'Apollo 11',
      subtitle: 'The mission in eight points',
      sources: ['Wikipedia, "Apollo 11" — https://en.wikipedia.org/wiki/Apollo_11', 'NASA — https://www.nasa.gov/mission/apollo-11/'],
      body: '## Summary\nFirst crewed landing.',
    });
  });

  it('takes a leading # heading as the title, once', () => {
    expect(documentParts('# Shop report\n\nPrices below.', 'file')).toEqual({ title: 'Shop report', sources: [], body: 'Prices below.' });
  });

  it('falls back to the file name, and leaves a body without a header alone', () => {
    expect(documentParts('Just text.\n\n## Later', 'notes')).toEqual({ title: 'notes', sources: [], body: 'Just text.\n\n## Later' });
  });

  it('ignores keys it does not know, and a single source line', () => {
    const parts = documentParts('---\ntitle: T\nauthor: someone\nsource: https://example.com\n---\nBody', 'f');
    expect(parts).toEqual({ title: 'T', sources: ['https://example.com'], body: 'Body' });
  });

  it('does not take a rule in the middle of a document for a header', () => {
    expect(documentParts('Intro\n---\ntitle: no\n---\n', 'f').title).toBe('f');
  });
});

describe('a source line', () => {
  it('splits the words from the web address', () => {
    expect(sourceLink('Wikipedia, "Apollo 11" — https://en.wikipedia.org/wiki/Apollo_11.')).toEqual({ text: 'Wikipedia, "Apollo 11"', url: 'https://en.wikipedia.org/wiki/Apollo_11' });
    expect(sourceLink('https://example.com/a')).toEqual({ text: '', url: 'https://example.com/a' });
  });

  it('links nothing but http and https', () => {
    expect(sourceLink('Notes — javascript:alert(1)')).toEqual({ text: 'Notes — javascript:alert(1)' });
  });
});

describe('the paper size', () => {
  it('is Letter where it is used, A4 elsewhere', () => {
    expect(paperFor('en-US')).toBe('letter');
    expect(paperFor('fr-CA')).toBe('letter');
    expect(paperFor('en-GB')).toBe('A4');
    expect(paperFor('fr')).toBe('A4');
  });
});
