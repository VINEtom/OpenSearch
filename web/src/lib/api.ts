import type { ApiError } from '../../../shared/types';

export class RequestError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
    this.name = 'RequestError';
  }
}

async function requestApi<T>(path: string, method: 'GET' | 'POST', signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/prototype${path}`, { method, signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new RequestError('NETWORK_ERROR', '无法连接原型服务，请检查服务是否已启动后重试。');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as ApiError | null)?.error;
    throw new RequestError(error?.code || `HTTP_${response.status}`, error?.message || '服务暂时不可用，请稍后重试。', response.status);
  }
  return body as T;
}

export function readApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestApi(path, 'GET', signal);
}

export function postApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestApi(path, 'POST', signal);
}

export function errorInfo(error: unknown) {
  return error instanceof RequestError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: 'UNKNOWN', message: '读取失败，请稍后重试。', status: 0 };
}

export type ErrorInfo = ReturnType<typeof errorInfo>;
