/*
 * Screenshots, files and attachments: stored apart from the transcript
 * (chrome.storage.session), referenced from it by id, and kept within
 * budgets so a long conversation cannot outgrow storage. The model sees only
 * the newest screenshots; the owner can open the newest dozen.
 */

import type { AIContentPart, AIMessage, AIToolCall } from '@amenophis1er/extension-ai-connect/types';
import type { ToolResult } from '../controller/controller.js';
import type { Attachment } from './attachments.js';
import { PDF_TYPE, saveFile } from './files.js';
import type { LoopHost } from './host.js';
import type { Media, OwnerAttachment } from './protocol.js';

/** Screenshots the model still sees; older ones become a line of text. */
const MODEL_SCREENSHOTS = 2;
/** Screenshots the owner can still open in the panel: at most this many, and at most this many bytes. */
const KEPT_SCREENSHOTS = 12;
const KEPT_SCREENSHOT_BYTES = 2_500_000;
/** Files kept for download, newest first, up to this many bytes in all. */
const KEPT_FILE_BYTES = 2_000_000;

/** A stored screenshot, as its transcript entry names it. */
export type KeptImage = { id: string; width: number; height: number; bytes: number };

export function hasImage(message: AIMessage): boolean {
  return Array.isArray(message.content) && message.content.some((part) => part.type === 'image' || part.type === 'document');
}

/** The same message with its images and documents replaced by a line saying so. */
export function withoutImages<M extends AIMessage>(message: M): M {
  if (!Array.isArray(message.content) || !hasImage(message)) return message;
  const text = message.content.filter((part): part is Extract<AIContentPart, { type: 'text' }> => part.type === 'text').map((part) => part.text);
  const what = message.role === 'tool' ? '(The screenshot was not sent to you: you do not know what it shows. Use observe to read the page.)' : '(attached images and PDFs not included: this model cannot read them)';
  return { ...message, content: [...text, what].join('\n') };
}

export interface MediaDeps {
  media: { set(id: string, value: Media): Promise<void>; remove(ids: string[]): Promise<void> };
  /** Chrome prints the Markdown stored under a media id to a PDF, returned as base64 (pdf.ts). */
  pdf: { render(id: string): Promise<string> };
}

export class MediaKeeper {
  readonly #host: LoopHost;
  readonly #deps: MediaDeps;

  constructor(host: LoopHost, deps: MediaDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  /**
   * Store the screenshot for the owner, and answer the call with it: the image
   * goes to the model as part of the tool result. Only the newest few stay in
   * the history and in storage.
   */
  async keepScreenshot(call: AIToolCall, result: Extract<ToolResult, { screenshot: unknown }>): Promise<KeptImage> {
    const { data, mediaType, width, height, masked, id: shotId } = result.screenshot;
    const id = this.id('shot');
    await this.#deps.media.set(id, { kind: 'image', mediaType, data });
    const state = this.#host.state();
    const text = JSON.stringify({ completed: true, screenshot: { id: shotId, width, height, ...(masked ? { maskedFrames: masked } : {}) },
      message: state.noVision
        ? 'You did not receive this image: you know nothing about what it shows. The owner sees it. To learn what is on the page, use observe.'
        : 'The screenshot is attached and was also shown to the owner.',
      notice: result.notice });
    const content: AIContentPart[] = [{ type: 'text', text }, { type: 'image', mediaType, data }];
    state.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
    return { id, width, height, bytes: data.length };
  }

  /** Keep the newest screenshots and files within their budgets; the rest are forgotten. */
  async prune(): Promise<void> {
    const state = this.#host.state();
    // Only screenshots age out; what the owner attached stays with their message.
    const withImages = state.history.filter((message) => message.role === 'tool' && hasImage(message));
    for (const message of withImages.slice(0, -MODEL_SCREENSHOTS)) {
      if (message.role === 'tool') message.content = withoutImages(message).content;
    }
    const expired: string[] = [];
    let shots = 0;
    let shotBytes = 0;
    let fileBytes = 0;
    for (const entry of [...state.transcript].reverse()) {
      if (entry.kind === 'action' && entry.image && !entry.image.expired) {
        shots += 1;
        shotBytes += entry.image.bytes ?? 0;
        if (shots > KEPT_SCREENSHOTS || shotBytes > KEPT_SCREENSHOT_BYTES) { entry.image.expired = true; expired.push(entry.image.id); }
      } else if (entry.kind === 'file' && !entry.expired) {
        fileBytes += entry.bytes;
        if (fileBytes > KEPT_FILE_BYTES) { entry.expired = true; expired.push(entry.id); }
      }
    }
    if (expired.length > 0) await this.#deps.media.remove(expired).catch(() => undefined);
  }

  /** A file the model made (save_file): kept for the owner to download; a .pdf printed by Chrome from the model's Markdown. */
  async saveFile(call: AIToolCall): Promise<void> {
    const saved = saveFile(call.args);
    if ('error' in saved) {
      this.#host.answer(call, { error: saved.error, notice: 'No file was made.' }, true);
      await this.#host.save();
      return;
    }
    const state = this.#host.state();
    const { name, mimeType, content } = saved.file;
    const id = this.id('file');
    const shown = 'The owner sees the file in the panel with a Download button. It is on their disk only once they click it; do not say it was downloaded.';
    if (mimeType === PDF_TYPE) {
      // The Markdown goes in first: document.html renders it from storage for Chrome to print,
      // and it stays, as a .md, when the PDF cannot be made.
      const source = `${name.replace(/\.pdf$/i, '')}.md`;
      await this.#deps.media.set(id, { kind: 'file', name: source, mimeType: 'text/markdown', content });
      let data: string | undefined;
      let reason = '';
      try { data = await this.#deps.pdf.render(id); }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
      if (data) {
        await this.#deps.media.set(id, { kind: 'pdf', name, data });
        const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        state.transcript.push({ kind: 'file', id, name, mimeType, bytes });
        await this.prune();
        this.#host.answer(call, { saved: name, bytes, message: shown }, false);
      } else {
        const bytes = new TextEncoder().encode(content).length;
        state.transcript.push({ kind: 'file', id, name: source, mimeType: 'text/markdown', bytes });
        await this.prune();
        this.#host.answer(call, { saved: source, bytes, message: `The PDF could not be made (${reason || 'unknown reason'}), so the document was saved as Markdown instead; tell the owner. ${shown}` }, false);
      }
      await this.#host.save();
      return;
    }
    await this.#deps.media.set(id, { kind: 'file', name, mimeType, content });
    const bytes = new TextEncoder().encode(content).length;
    state.transcript.push({ kind: 'file', id, name, mimeType, bytes });
    await this.prune();
    this.#host.answer(call, { saved: name, bytes, message: shown }, false);
    await this.#host.save();
  }

  /** Store image attachments so the panel can show them in the owner's message; other files by name only. */
  async keepAttachments(attachments: Attachment[]): Promise<OwnerAttachment[]> {
    const shown: OwnerAttachment[] = [];
    for (const attachment of attachments) {
      const entry: OwnerAttachment = { kind: attachment.kind, name: attachment.name, bytes: attachment.bytes };
      if (attachment.kind === 'image' && attachment.data) {
        const id = this.id('attached');
        try {
          // The panel's small copy when it sent one: the full image is already in the history once.
          const data = attachment.thumb && attachment.thumb.length < attachment.data.length ? attachment.thumb : attachment.data;
          await this.#deps.media.set(id, { kind: 'image', mediaType: 'image/jpeg', data });
          Object.assign(entry, { id, width: attachment.width, height: attachment.height });
        } catch { /* shown by name only */ }
      }
      shown.push(entry);
    }
    return shown;
  }

  /** Every screenshot and file this conversation stored. */
  ids(): string[] {
    return this.#host.state().transcript.flatMap((entry) => entry.kind === 'file' ? [entry.id]
      : entry.kind === 'action' && entry.image ? [entry.image.id]
        : entry.kind === 'owner' ? (entry.attachments ?? []).flatMap((attachment) => (attachment.id ? [attachment.id] : [])) : []);
  }

  /** Forget everything this conversation stored. */
  async forget(): Promise<void> {
    await this.#deps.media.remove(this.ids()).catch(() => undefined);
  }

  id(kind: string): string {
    return `${kind}-${this.#host.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
