import { describe, expect, it } from 'vitest';
import { kindOf, readAttachment } from './composer.js';

describe('composer attachments', () => {
  it('tells images, PDFs, text and everything else apart', () => {
    expect(kindOf('mug.png', 'image/png')).toBe('image');
    expect(kindOf('scan.PDF', '')).toBe('pdf');
    expect(kindOf('logo.svg', 'image/svg+xml')).toBe('text');
    expect(kindOf('data.csv', '')).toBe('text');
    expect(kindOf('main.py', 'application/octet-stream')).toBe('text');
    expect(kindOf('config', 'application/json')).toBe('text');
    expect(kindOf('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('other');
  });

  it('reads text as text, a PDF as base64, and anything else by name only', async () => {
    expect(await readAttachment(new File(['a,b\n1,2'], 'data.csv', { type: 'text/csv' }))).toMatchObject({ kind: 'text', name: 'data.csv', data: 'a,b\n1,2', bytes: 7 });
    expect(await readAttachment(new File(['%PDF-'], 'r.pdf', { type: 'application/pdf' }))).toMatchObject({ kind: 'pdf', data: 'JVBERi0=' });
    const other = await readAttachment(new File(['zip'], 'a.zip', { type: 'application/zip' }));
    expect(other).toMatchObject({ kind: 'other', name: 'a.zip' });
    expect(other).not.toHaveProperty('data');
  });

  it('refuses a PDF over 2 MB and text over 200,000 characters', async () => {
    expect(await readAttachment(new File([new Uint8Array(2_200_000)], 'big.pdf', { type: 'application/pdf' }))).toEqual({ error: 'big.pdf is larger than 2 MB, the limit for PDFs.' });
    expect(await readAttachment(new File(['x'.repeat(200_001)], 'big.txt', { type: 'text/plain' }))).toEqual({ error: 'big.txt is longer than 200,000 characters.' });
  });
});
