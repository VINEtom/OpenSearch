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

const namedEntities: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_entity, body: string) => {
    const key = body.toLowerCase();
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : key.startsWith('#') ? Number.parseInt(key.slice(1), 10) : NaN;
    if (Number.isInteger(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
    return namedEntities[key] ?? ' ';
  }).replace(/\u00a0/g, ' ');
}

/** Collapse layout text for display. Angle brackets stay, so clinical comparisons are not treated as tags. */
export function readableText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

/** Custom report HTML: decode entities first, then drop tags. */
export function htmlToText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  return decodeEntities(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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
