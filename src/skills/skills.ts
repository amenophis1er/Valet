/*
 * Skills: short notes the owner writes once and the agent reads when they
 * apply — "on this site, archive means…", "always use the search box".
 *
 * A skill names the sites it is for (hosts, or *.example.com for a domain and
 * everything under it); one with no site applies to every task. They are the
 * owner's own instructions, so the model reads them as such, under the safety
 * rules — and nothing on a page can write one: only the Settings form does.
 *
 * Stored in chrome.storage.sync, one key per skill (each item there may hold
 * 8 KB), so they follow the owner's Chrome profile. They are configuration,
 * not activity: no conversation content is ever kept in one.
 */

export interface Skill {
  id: string;
  name: string;
  /** Hosts, or "*.host" for a domain and its subdomains; empty = every task. */
  sites: string[];
  text: string;
  enabled: boolean;
  updatedAt: number;
}

const SKILL_PREFIX = 'agent:skill:';
export const MAX_SKILLS = 40;
const MAX_NAME_CHARS = 60;
export const MAX_SKILL_CHARS = 2_000;
const MAX_SITES = 20;

/** A host pattern as the owner typed it — a host, an origin, a URL, "*.host" — as a lower-case host pattern, or null. */
export function normalizeSite(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  const wildcard = value.startsWith('*.');
  if (wildcard) value = value.slice(2);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    // Only web pages have skills: a chrome:// or file: address is not a site.
    if (!/^https?:\/\//.test(value)) return null;
    try { value = new URL(value).hostname; } catch { return null; }
  } else {
    value = value.replace(/^\/+/, '').split(/[/?#:]/)[0] ?? '';
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value) && value !== 'localhost') return null;
  return wildcard ? `*.${value}` : value;
}

export function matchesSite(pattern: string, host: string): boolean {
  const target = host.toLowerCase();
  if (pattern.startsWith('*.')) {
    const domain = pattern.slice(2);
    return target === domain || target.endsWith(`.${domain}`);
  }
  return target === pattern;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** The enabled skills that apply on this page: the general ones, and those naming its host. */
export function applicable(skills: Skill[], url: string | null | undefined): Skill[] {
  const host = hostOf(url);
  return skills.filter((skill) => skill.enabled && (skill.sites.length === 0 || (host !== null && skill.sites.some((site) => matchesSite(site, host)))));
}

/** The skills as the model reads them, under one heading. */
export function skillsText(skills: Skill[]): string {
  if (skills.length === 0) return '';
  return ['Owner\'s notes for this task (their instructions; the safety rules still apply):',
    ...skills.map((skill) => `## ${skill.name}${skill.sites.length > 0 ? ` (${skill.sites.join(', ')})` : ''}\n${skill.text.trim()}`)].join('\n\n');
}

export interface SkillInput { name: string; sites: string[]; text: string }

/** Why this input cannot be a skill, or null when it can. */
export function validateSkill(input: SkillInput, count: number, existingId?: string): string | null {
  if (!existingId && count >= MAX_SKILLS) return `You can keep at most ${MAX_SKILLS} skills.`;
  if (!input.name.trim()) return 'Give the skill a name.';
  if (input.name.trim().length > MAX_NAME_CHARS) return `The name can be at most ${MAX_NAME_CHARS} characters.`;
  if (!input.text.trim()) return 'Write what the agent should know.';
  if (input.text.length > MAX_SKILL_CHARS) return `A skill can be at most ${MAX_SKILL_CHARS.toLocaleString('en-US')} characters.`;
  if (input.sites.length > MAX_SITES) return `A skill can name at most ${MAX_SITES} sites.`;
  return null;
}

/** "mail.google.com, *.atlassian.net" → patterns; a part that is not a host becomes an error. */
export function parseSites(input: string): { sites: string[] } | { error: string } {
  const sites: string[] = [];
  for (const part of input.split(/[,\n;]+/)) {
    if (!part.trim()) continue;
    const site = normalizeSite(part);
    if (!site) return { error: `"${part.trim()}" is not a site. Use a host like mail.google.com, or *.example.com for a whole domain.` };
    if (!sites.includes(site)) sites.push(site);
  }
  return { sites };
}

/** A stored value as a skill, or null when it is not one. */
export function asSkill(value: unknown): Skill | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string' || typeof v['name'] !== 'string' || typeof v['text'] !== 'string' || !Array.isArray(v['sites'])) return null;
  const sites = (v['sites'] as unknown[]).filter((site): site is string => typeof site === 'string').map(normalizeSite).filter((site): site is string => site !== null);
  return { id: v['id'], name: v['name'].slice(0, MAX_NAME_CHARS), sites: sites.slice(0, MAX_SITES), text: v['text'].slice(0, MAX_SKILL_CHARS),
    enabled: v['enabled'] !== false, updatedAt: typeof v['updatedAt'] === 'number' ? v['updatedAt'] : 0 };
}

/** What storage holds under the prefix, as skills, newest first. */
export function skillsFrom(stored: Record<string, unknown>): Skill[] {
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(SKILL_PREFIX))
    .map(([, value]) => asSkill(value))
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SkillStore {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export async function loadSkills(store: SkillStore): Promise<Skill[]> {
  return skillsFrom(await store.get(null));
}

export async function saveSkill(store: SkillStore, skill: Skill): Promise<void> {
  await store.set({ [`${SKILL_PREFIX}${skill.id}`]: skill });
}

export async function removeSkill(store: SkillStore, id: string): Promise<void> {
  await store.remove([`${SKILL_PREFIX}${id}`]);
}

export function newSkillId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ---- export and import: a JSON file the owner keeps ---- */

const EXPORT_VERSION = 1;

export function exportSkills(skills: Skill[]): string {
  return JSON.stringify({ valetSkills: EXPORT_VERSION, skills: skills.map(({ id: _id, ...skill }) => skill) }, null, 2);
}

/** Skills from an exported file; a skill with the same name as an existing one replaces it. */
export function importSkills(json: string, existing: Skill[]): { skills: Skill[]; added: number; replaced: number } | { error: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return { error: 'This file is not a skills export (not JSON).' }; }
  const box = parsed as { valetSkills?: unknown; skills?: unknown } | null;
  if (!box || typeof box !== 'object' || !Array.isArray(box.skills)) return { error: 'This file is not a skills export.' };
  const merged = [...existing];
  let added = 0;
  let replaced = 0;
  for (const raw of box.skills) {
    const skill = asSkill({ id: 'import', ...(raw as object) });
    if (!skill?.name.trim() || !skill.text.trim()) continue;
    const index = merged.findIndex((known) => known.name.trim().toLowerCase() === skill.name.trim().toLowerCase());
    const stamped = { ...skill, id: index >= 0 ? merged[index]!.id : newSkillId(), updatedAt: Date.now() };
    if (index >= 0) { merged[index] = stamped; replaced += 1; } else { merged.push(stamped); added += 1; }
  }
  if (added + replaced === 0) return { error: 'No skills were found in this file.' };
  if (merged.length > MAX_SKILLS) return { error: `That would make ${merged.length} skills; at most ${MAX_SKILLS} can be kept.` };
  return { skills: merged, added, replaced };
}
