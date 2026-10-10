/*
 * The `save_file` tool: the agent writes a text file, the owner downloads it.
 *
 * Nothing touches the disk from here. The file is kept with the conversation
 * and the panel shows it with a Download button; the owner's click is the
 * download. Only plain data formats: nothing that a browser would run when
 * the owner opens it. A `.pdf` is written as Markdown too; the loop has
 * Chrome print it (pdf.ts), so the model never writes PDF syntax.
 */

import { z } from 'zod';

export const MAX_FILE_CHARS = 200_000;

const TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  pdf: 'application/pdf',
};

export const PDF_TYPE = TYPES['pdf']!;

export const SAVE_FILE_TOOL = {
  name: 'save_file',
  description: [
    'Create a file for the owner to download: a summary, notes, a table as CSV, data as JSON, or a document as PDF.',
    'The panel shows it with a Download button; it reaches their disk only when they click.',
    `Allowed extensions: ${Object.keys(TYPES).map((ext) => `.${ext}`).join(', ')}. Write the complete content in one call.`,
    'For a .pdf, write the content as Markdown (headings, lists, tables, code): Valet lays it out and makes the PDF.',
    'This is the only way to give the owner a file: never upload their content to a website to do it.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['filename', 'content'],
    properties: {
      filename: { type: 'string', minLength: 1, maxLength: 100, description: 'For example "lome-summary.txt".' },
      content: { type: 'string', maxLength: MAX_FILE_CHARS },
    },
  },
} as const;

const input = z.object({ filename: z.string().min(1).max(100), content: z.string().max(MAX_FILE_CHARS) }).strict();

/** `content` is the text of the file, or for a PDF the Markdown it is made from. */
export interface SavedFile { name: string; mimeType: string; content: string }

/** A safe file name with an allowed extension; anything else becomes .txt. */
export function fileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/[^\w .()-]+/g, '-').replace(/^[.\s-]+/, '').trim().slice(0, 80) || 'file';
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return ext in TYPES ? base : `${base}.txt`;
}

export function saveFile(args: unknown): { file: SavedFile } | { error: string } {
  const parsed = input.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `Invalid save_file call — ${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'malformed'}. Send {"filename":"notes.txt","content":"..."}.` };
  }
  const name = fileName(parsed.data.filename);
  const ext = name.split('.').pop()!.toLowerCase();
  return { file: { name, mimeType: TYPES[ext]!, content: parsed.data.content } };
}
