/*
 * The composer's attachments: what kind of file each one is, and reading it
 * into what the worker sends the model. Images are scaled and re-encoded as
 * JPEG here, in the panel, where there is a DOM canvas; PDFs go as they are;
 * text as text; anything else by name only.
 */

import { MAX_IMAGE_CHARS, MAX_PDF_CHARS, MAX_TEXT_CHARS, type Attachment } from './loop/attachments.js';

/** The longest side of an attached image after scaling: large enough to read, small enough to send every turn. */
const MAX_IMAGE_SIDE = 1568;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml|x-ndjson))/;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'svg', 'yaml', 'yml', 'toml', 'ini', 'log',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'sql', 'env']);

export function kindOf(name: string, mimeType: string): Attachment['kind'] {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  // SVG is text (XML): canvases do not always decode it, and the model reads the markup fine.
  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') return 'image';
  if (TEXT_TYPES.test(mimeType) || TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'other';
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The small copy kept for the owner's message in the panel. */
const THUMB_SIDE = 480;

/** One JPEG of the image with its longest side at most `side`. */
async function encode(bitmap: ImageBitmap, side: number, quality: number): Promise<{ data: string; width: number; height: number } | null> {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  // JPEG has no transparency: a white page behind it, as a viewer would show.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  return blob ? { data: base64(new Uint8Array(await blob.arrayBuffer())), width, height } : null;
}

/** Scale an image so its longest side fits, and encode it as JPEG; smaller again if still too big to send. Plus its thumbnail. */
async function prepareImage(file: Blob): Promise<{ data: string; width: number; height: number; thumb?: string }> {
  const bitmap = await createImageBitmap(file);
  for (const [side, quality] of [[MAX_IMAGE_SIDE, 0.85], [1200, 0.75], [900, 0.7]] as const) {
    const image = await encode(bitmap, side, quality);
    if (!image) break;
    if (image.data.length <= MAX_IMAGE_CHARS) {
      const thumb = await encode(bitmap, THUMB_SIDE, 0.7);
      return { ...image, ...(thumb ? { thumb: thumb.data } : {}) };
    }
  }
  throw new Error('image too large');
}

/** A thumbnail of an image that is already base64 JPEG (a tab screenshot). */
export async function thumbnailOf(jpeg: string): Promise<string | undefined> {
  try {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(jpeg), (char) => char.charCodeAt(0))], { type: 'image/jpeg' }));
    return (await encode(bitmap, THUMB_SIDE, 0.7))?.data;
  } catch {
    return undefined;
  }
}

/** Read one picked, dropped or pasted file. A file that cannot be sent comes back as an error to show. */
export async function readAttachment(file: File): Promise<Attachment | { error: string }> {
  const name = file.name || (file.type.startsWith('image/') ? `pasted-image.${file.type.split('/')[1] ?? 'png'}` : 'file');
  const kind = kindOf(name, file.type);
  const base = { kind, name, mimeType: file.type || 'application/octet-stream', bytes: file.size };
  try {
    if (kind === 'image') return { ...base, ...(await prepareImage(file)) };
    if (kind === 'pdf') {
      const data = base64(new Uint8Array(await file.arrayBuffer()));
      if (data.length > MAX_PDF_CHARS) return { error: `${name} is larger than 2 MB, the limit for PDFs.` };
      return { ...base, data };
    }
    if (kind === 'text') {
      const data = await file.text();
      if (data.length > MAX_TEXT_CHARS) return { error: `${name} is longer than 200,000 characters.` };
      return { ...base, data };
    }
    return base;
  } catch {
    return { error: `${name} could not be read.` };
  }
}
