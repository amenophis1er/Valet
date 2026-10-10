/*
 * The owner's skills in a conversation: which ones the model is given, when,
 * and "Save as skill", which asks the model to write a new one.
 *
 * A skill reaches the model once per conversation: with the goal when it is
 * for the page the run starts on (or the owner named it), or in the result of
 * the first action that lands on its site. Each use is a line in the
 * transcript, so the owner sees which notes the agent was following.
 */

import type { AIChatRequest, AIChatResult, AIMessage } from '@amenophis1er/byok/types';
import { MAX_SKILL_CHARS, applicable, skillsText, type Skill } from '../skills/skills.js';
import type { Connection } from './state.js';
import type { LoopHost } from './host.js';
import { SYSTEM_PROMPT } from './prompt.js';

/** What "Save as skill" proposes; the owner edits and saves it, or not. */
export interface SkillDraft { name: string; sites: string[]; text: string }
/** The most the model may write for a skill draft: what a skill may hold, so nothing it writes is lost. */
export const DRAFT_CHARS = MAX_SKILL_CHARS;

/** At most `max` characters, cut at a line break when the text runs over, so a step is never left half written. */
export function trimDraft(text: string, max = DRAFT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return (cut > max / 2 ? text.slice(0, cut) : text.slice(0, max)).trim();
}

export interface SkillNoteDeps {
  skills: { get(): Promise<Skill[]> };
  chat(request: AIChatRequest, options: { signal: AbortSignal }): Promise<AIChatResult>;
  activeConnection(): Promise<Connection | null>;
  /** The history as the model sees it (compacted, images dropped for a model without vision). */
  view(): AIMessage[];
}

export class SkillNotes {
  readonly #host: LoopHost;
  readonly #deps: SkillNoteDeps;
  /** This run's view of the owner's skills; read again when a run starts or resumes. */
  #skills: Skill[] = [];

  constructor(host: LoopHost, deps: SkillNoteDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  /** Read the owner's skills again: they may have changed since the last run. */
  async refresh(): Promise<void> {
    this.#skills = await this.#deps.skills.get().catch(() => []);
  }

  /** The text with the notes for it under it: the skills the owner named, and those for this page, each once per conversation. */
  withNotes(text: string, named: string[], url: string | null): string {
    const skills = this.#pick(named, url);
    if (skills.length === 0) return text;
    this.#used(skills);
    return `${text}\n\n${skillsText(skills)}`;
  }

  /** A page the agent landed on: its skills, if new to this conversation, to ride along in the tool result. */
  notesFor(url: string | undefined): string | undefined {
    const skills = url ? this.#pick([], url) : [];
    if (skills.length === 0) return undefined;
    this.#used(skills);
    return skillsText(skills);
  }

  #pick(named: string[], url: string | null): Skill[] {
    const used = new Set(this.#host.state().usedSkillIds ?? []);
    const picked = [...this.#skills.filter((skill) => named.includes(skill.id)), ...applicable(this.#skills, url).filter((skill) => !used.has(skill.id))];
    return [...new Map(picked.map((skill) => [skill.id, skill])).values()];
  }

  /** Recorded as used, and named in the transcript. */
  #used(skills: Skill[]): void {
    const state = this.#host.state();
    state.usedSkillIds = [...new Set([...(state.usedSkillIds ?? []), ...skills.map((skill) => skill.id)])];
    this.#host.note(`Using ${skills.length === 1 ? 'skill' : 'skills'}: ${skills.map((skill) => skill.name).join(', ')}`);
  }

  /**
   * "Save as skill": the model writes, from this conversation, a short note
   * for next time — what worked, as steps — for the owner to edit and keep.
   * One request; nothing is saved here.
   */
  async draft(options: { focus?: string; previous?: string } = {}): Promise<SkillDraft | { error: string }> {
    const s = this.#host.state();
    const goal = s.transcript.find((entry) => entry.kind === 'owner');
    if (goal?.kind !== 'owner' || s.status === 'running') return { error: s.status === 'running' ? 'Wait for the agent to finish first.' : 'There is no conversation to learn from yet.' };
    const connection = s.connection ?? await this.#deps.activeConnection();
    if (!connection) return { error: 'Add an AI connection in Settings first.' };
    // The sites it was about: the page handed over, the one it works in, and every page it read.
    const hosts = new Set<string>();
    const add = (url: string | undefined) => { if (url) { try { hosts.add(new URL(url).hostname); } catch { /* not a url */ } } };
    add(s.handedTab?.url);
    add(s.workspace?.url);
    for (const message of s.history) {
      if (message.role === 'tool' && typeof message.content === 'string') add(/"url":"(https?:\/\/[^"]+)"/.exec(message.content)?.[1]);
    }
    const focus = options.focus?.trim();
    const previous = options.previous?.trim();
    const ask = 'Write a note for a future run of a task like this one, for the owner to keep as a skill. In at most '
      + `${DRAFT_CHARS} characters: what the task was, the steps that worked (imperative, in order), and what to avoid. `
      + 'Name pages and controls, never the values the owner filled in or anything personal. Plain text only, no preamble. '
      + 'Then, on a last line, "NAME: " followed by a title of at most five words.'
      // The owner's steer: what the note is about, or what to change in the draft they have.
      + (previous ? `\n\nThe note as written before:\n${previous}\n\nWrite it again${focus ? `, changed as the owner asks: ${focus}` : ''}.` : '')
      + (focus && !previous ? `\n\nThe owner asks that the note be about this in particular: ${focus}` : '');
    const result = await this.#deps.chat({
      system: SYSTEM_PROMPT, messages: [...this.#deps.view(), { role: 'user', content: ask }],
      connectionId: connection.id, connectionRevision: connection.revision, model: connection.model, maxTokens: 1000,
    }, { signal: new AbortController().signal });
    if (!result.ok || !result.text) return { error: `The model could not write the note: ${result.error ?? 'no answer'}` };
    const lines = result.text.trim().split('\n');
    const nameLine = [...lines].reverse().find((line) => /^\s*NAME:/i.test(line));
    const name = (nameLine ? nameLine.replace(/^\s*NAME:\s*/i, '').trim() : goal.text).replace(/["*]/g, '').slice(0, 60);
    const text = trimDraft(lines.filter((line) => line !== nameLine).join('\n').trim());
    return { name: name || 'New skill', sites: [...hosts], text };
  }
}
