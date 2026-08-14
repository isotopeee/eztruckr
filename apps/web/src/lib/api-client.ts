const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

/** One field-level complaint from the API's Zod validation. */
export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The most specific thing the API said, in one sentence.
   *
   * FIELD ERRORS COME FIRST, and that is the whole point. A refused write
   * arrives as `{ message: 'Validation failed', errors: [{ path, message }] }`
   * — the wrapper is generic and the reason is in `errors`. Reading `message`
   * alone showed "Validation failed" at people who then had no idea which
   * field, or why. Assigning a driver with no licence expiry on file was the
   * case that surfaced it: the API says exactly that, and the screen said
   * nothing.
   *
   * Only 5 of the ~34 places that render this also show `fieldErrors` beside
   * the inputs, so for the rest this is the only explanation the user gets.
   * Those five now repeat the text in the toast, which is redundant rather
   * than wrong — and much better than the alternative.
   *
   * Falls back to the wrapper, then to the HTTP status, so a 403 or a 500
   * still reads as it did and nothing ever renders "undefined".
   */
  get displayMessage(): string {
    const fields = Object.values(this.fieldErrors);
    if (fields.length > 0) return fields.join(' ');

    const body = this.body;

    if (typeof body === 'object' && body !== null && 'message' in body) {
      const { message } = body as { message: unknown };
      if (typeof message === 'string') return message;
      if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
    }

    return this.message;
  }

  /** Field-level errors, keyed by field name, for rendering beside inputs. */
  get fieldErrors(): Record<string, string> {
    const body = this.body;

    if (typeof body !== 'object' || body === null || !('errors' in body)) {
      return {};
    }

    const { errors } = body as { errors: unknown };
    if (!Array.isArray(errors)) return {};

    const result: Record<string, string> = {};
    for (const entry of errors as FieldError[]) {
      if (entry?.path && entry?.message && !result[entry.path]) {
        result[entry.path] = entry.message;
      }
    }
    return result;
  }
}

/**
 * Thin fetch wrapper for the NestJS API.
 *
 * `credentials: 'include'` carries the Better Auth session cookie, which in
 * development is set by a different origin (:4000) from the one the app is
 * served on (:3000).
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(`Request to ${path} failed with ${response.status}`, response.status, body);
  }

  return body as T;
}

/**
 * Uploads a file.
 *
 * Separate from `apiFetch` for one reason: the Content-Type header must NOT be
 * set. `fetch` generates `multipart/form-data; boundary=…` itself, and a header
 * we set by hand has no boundary, so the server sees a body it cannot parse and
 * reports no file at all.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    body: form,
  });

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(`Upload to ${path} failed with ${response.status}`, response.status, body);
  }

  return body as T;
}

/**
 * Where a receipt's bytes live.
 *
 * A plain API URL, opened in a new tab rather than fetched — the session cookie
 * rides along on a top-level navigation, and the API re-checks who is asking.
 * There is deliberately no presigned bucket link to hand around.
 */
export function receiptContentUrl(receiptId: string): string {
  return `${API_BASE_URL}/receipts/${receiptId}/content`;
}

/** Builds a query string, omitting empty and default-ish values. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }

  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}
