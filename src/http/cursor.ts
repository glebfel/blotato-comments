import { ValidationError } from '../domain/errors.js';
import type { PageCursor } from '../domain/types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque cursor: clients must not build or parse it. Encoded (postedAt, id) keyset position. */
export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.postedAt.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(value: string | undefined): PageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string' || !UUID.test(parsed.id))
      throw new Error('shape');
    const postedAt = new Date(parsed.t);
    if (Number.isNaN(postedAt.getTime())) throw new Error('date');
    return { postedAt, id: parsed.id };
  } catch {
    throw new ValidationError('Invalid cursor', { cursor: value });
  }
}
