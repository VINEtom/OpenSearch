const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pieces(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(pieces);
  if (typeof value !== 'string') return [];
  const trimmed = value.trim().replace(/\^+$/u, '');
  if (!trimmed || trimmed === '[]' || trimmed === 'null') return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.flatMap(pieces);
    } catch { /* Keep the original text when it is not JSON. */ }
  }
  if (uuid.test(trimmed)) return [];
  const text = trimmed.replace(/^[A-Za-z][A-Za-z0-9]*:/u, '').trim();
  return text ? [text] : [];
}

export function fieldValues(value: unknown): string[] {
  return [...new Set(pieces(value).map(text => text.normalize('NFKC')))].sort();
}

/** Join the supplied values in order. Empty values and empty JSON arrays are omitted. */
export function joinText(values: unknown[]): string | null {
  const text = values.flatMap(pieces);
  return text.length ? text.join('\n') : null;
}

export function plain(value: unknown): string | null {
  const [first] = pieces(value);
  return first ?? null;
}

export function calendarDate(value: unknown): string | null {
  const text = plain(value);
  if (!text) return null;
  const date = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : null;
}

export function timestamp(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/u.test(text)) return text.replace(' ', 'T').slice(0, 19);
  return fallback;
}
