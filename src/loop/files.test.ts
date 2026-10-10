import { describe, expect, it } from 'vitest';
import { MAX_FILE_CHARS, SAVE_FILE_TOOL, fileName, saveFile } from './files.js';

describe('save_file', () => {
  it('keeps a plain name with an allowed extension', () => {
    expect(fileName('lome-summary.txt')).toBe('lome-summary.txt');
    expect(fileName('Data (2026).CSV')).toBe('Data (2026).CSV');
  });

  it('drops folders, hidden-file dots and odd characters, and makes anything runnable plain text', () => {
    expect(fileName('../../etc/passwd')).toBe('passwd.txt');
    expect(fileName('C:\\\\Users\\\\x\\\\run.bat')).toBe('run.bat.txt');
    expect(fileName('page.html')).toBe('page.html.txt');
    expect(fileName('.bashrc')).toBe('bashrc.txt');
    expect(fileName('')).toBe('file.txt');
  });

  it('types the file from its extension', () => {
    expect(saveFile({ filename: 'a.json', content: '{}' })).toEqual({ file: { name: 'a.json', mimeType: 'application/json', content: '{}' } });
    expect(saveFile({ filename: 'a.md', content: '#' })).toMatchObject({ file: { mimeType: 'text/markdown' } });
  });

  it('takes a .pdf, whose content is the Markdown Chrome will print', () => {
    expect(saveFile({ filename: 'report.pdf', content: '# Report' })).toEqual({ file: { name: 'report.pdf', mimeType: 'application/pdf', content: '# Report' } });
    expect(SAVE_FILE_TOOL.description).toContain('.pdf');
    expect(SAVE_FILE_TOOL.description).toMatch(/For a \.pdf, write the content as Markdown/);
  });

  it('refuses a call without a name, with extra fields, or with too much content', () => {
    expect(saveFile({ content: 'x' })).toHaveProperty('error');
    expect(saveFile({ filename: 'a.txt', content: 'x', path: '/tmp' })).toHaveProperty('error');
    expect(saveFile({ filename: 'a.txt', content: 'x'.repeat(MAX_FILE_CHARS + 1) })).toHaveProperty('error');
  });
});
