import { describe, expect, it } from 'vitest';
import { MAX_SKILLS, applicable, asSkill, exportSkills, importSkills, matchesSite, normalizeSite, parseSites, skillsFrom, skillsText, validateSkill, type Skill } from './skills.js';

const skill = (over: Partial<Skill>): Skill => ({ id: 'k', name: 'Note', sites: [], text: 'Do it well.', enabled: true, updatedAt: 1, ...over });

describe('sites', () => {
  it('normalizes what the owner typed to a host pattern', () => {
    expect(normalizeSite(' Mail.Google.com ')).toBe('mail.google.com');
    expect(normalizeSite('https://mail.google.com/mail/u/0/#inbox')).toBe('mail.google.com');
    expect(normalizeSite('mail.google.com/inbox')).toBe('mail.google.com');
    expect(normalizeSite('*.atlassian.net')).toBe('*.atlassian.net');
    expect(normalizeSite('localhost:5173')).toBe('localhost');
    for (const bad of ['', 'not a host', 'a..b', '-x.com', 'chrome://settings']) expect(normalizeSite(bad)).toBeNull();
  });

  it('matches a host exactly, and a wildcard to the domain and everything under it', () => {
    expect(matchesSite('mail.google.com', 'mail.google.com')).toBe(true);
    expect(matchesSite('mail.google.com', 'google.com')).toBe(false);
    expect(matchesSite('*.atlassian.net', 'acme.atlassian.net')).toBe(true);
    expect(matchesSite('*.atlassian.net', 'atlassian.net')).toBe(true);
    expect(matchesSite('*.atlassian.net', 'notatlassian.net')).toBe(false);
  });

  it('parses a comma list and names the part that is not a site', () => {
    expect(parseSites('mail.google.com, *.atlassian.net,mail.google.com')).toEqual({ sites: ['mail.google.com', '*.atlassian.net'] });
    expect(parseSites('')).toEqual({ sites: [] });
    expect(parseSites('gmail, what is this')).toEqual({ error: expect.stringContaining('"what is this" is not a site') });
  });
});

describe('applicable', () => {
  const general = skill({ id: 'g', name: 'General' });
  const gmail = skill({ id: 'm', name: 'Gmail', sites: ['mail.google.com'] });
  const off = skill({ id: 'o', name: 'Off', enabled: false });
  it('picks the general skills and those naming the page\'s host; never a disabled one', () => {
    expect(applicable([general, gmail, off], 'https://mail.google.com/mail/').map((s) => s.id)).toEqual(['g', 'm']);
    expect(applicable([general, gmail, off], 'https://shop.test/').map((s) => s.id)).toEqual(['g']);
    expect(applicable([general, gmail, off], null).map((s) => s.id)).toEqual(['g']);
    expect(applicable([general, gmail, off], 'chrome://newtab').map((s) => s.id)).toEqual(['g']);
  });

  it('formats them for the model under one heading, sites named', () => {
    const text = skillsText([general, gmail]);
    expect(text).toMatch(/^Owner's notes for this task/);
    expect(text).toContain('## General\nDo it well.');
    expect(text).toContain('## Gmail (mail.google.com)\nDo it well.');
    expect(skillsText([])).toBe('');
  });
});

describe('validation and storage shape', () => {
  it('refuses an empty name or text, too much text, and too many skills', () => {
    expect(validateSkill({ name: 'A', sites: [], text: 'x' }, 0)).toBeNull();
    expect(validateSkill({ name: ' ', sites: [], text: 'x' }, 0)).toMatch(/name/);
    expect(validateSkill({ name: 'A', sites: [], text: ' ' }, 0)).toMatch(/Write/);
    expect(validateSkill({ name: 'A', sites: [], text: 'x'.repeat(2_001) }, 0)).toMatch(/2,000/);
    expect(validateSkill({ name: 'A', sites: [], text: 'x' }, MAX_SKILLS)).toMatch(/at most/);
    expect(validateSkill({ name: 'A', sites: [], text: 'x' }, MAX_SKILLS, 'existing')).toBeNull();
  });

  it('reads only well-formed skills from storage, newest first, and cleans their sites', () => {
    const stored = {
      'agent:skill:a': { id: 'a', name: 'A', sites: ['Mail.Google.com', 'junk!!'], text: 't', updatedAt: 1 },
      'agent:skill:b': { id: 'b', name: 'B', sites: [], text: 't', enabled: false, updatedAt: 5 },
      'agent:skill:c': { name: 'no id' },
      'agent:pace': 'natural',
    };
    const skills = skillsFrom(stored);
    expect(skills.map((s) => s.id)).toEqual(['b', 'a']);
    expect(skills[1]).toMatchObject({ sites: ['mail.google.com'], enabled: true });
    expect(skills[0]!.enabled).toBe(false);
    expect(asSkill(null)).toBeNull();
  });
});

describe('export and import', () => {
  it('round-trips without ids, and replaces a skill with the same name on import', () => {
    const existing = [skill({ id: 'k1', name: 'Gmail', text: 'old' }), skill({ id: 'k2', name: 'Other' })];
    const file = exportSkills([skill({ id: 'x', name: 'gmail', text: 'new', sites: ['mail.google.com'] }), skill({ id: 'y', name: 'Fresh' })]);
    expect(file).not.toContain('"id"');
    const result = importSkills(file, existing);
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ added: 1, replaced: 1 });
    expect(result.skills.find((s) => s.id === 'k1')).toMatchObject({ name: 'gmail', text: 'new', sites: ['mail.google.com'] });
    expect(result.skills).toHaveLength(3);
  });

  it('names what is wrong with a file', () => {
    expect(importSkills('nope', [])).toEqual({ error: expect.stringContaining('not JSON') });
    expect(importSkills('{"valetSkills": 1, "skills": 3}', [])).toEqual({ error: expect.stringContaining('not a Valet skills export') });
    // Only Valet's own exports: a file under another name is not read.
    expect(importSkills('{"otherSkills": 1, "skills": [{"name": "a", "text": "b"}]}', [])).toEqual({ error: expect.stringContaining('not a Valet skills export') });
    expect(importSkills('{"valetSkills": 1, "skills": [{"name": "", "text": ""}]}', [])).toEqual({ error: expect.stringContaining('No skills') });
    const many = Array.from({ length: MAX_SKILLS }, (_, i) => skill({ id: `s${i}`, name: `S${i}` }));
    expect(importSkills(exportSkills([skill({ name: 'One more' })]), many)).toEqual({ error: expect.stringContaining('at most') });
  });
});
