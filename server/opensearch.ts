import { config } from './config.js';

export class OpenSearchError extends Error {
  constructor(public status: number, public response: unknown) { super(`OpenSearch 请求失败 (${status})`); }
}

export async function osRequest<T = unknown>(route: string, method = 'GET', body?: unknown, ndjson = false): Promise<T> {
  const response = await fetch(`${config.opensearchUrl.replace(/\/$/, '')}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? String(body) : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : {};
  if (!response.ok) throw new OpenSearchError(response.status, data);
  return data as T;
}
