// apps/web/src/api/client.ts
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function errMessage(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init?.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(path, {
    ...init,
    headers,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const apiErr = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      apiErr?.code ?? 'HTTP_ERROR',
      apiErr?.message ?? `Request failed (${res.status})`,
    );
  }
  return body as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T,>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'DELETE',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};