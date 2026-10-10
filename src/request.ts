/**
 * The one network call shape the plugin needs. In Obsidian it is `requestUrl` (which is not bound by
 * the browser's cross-origin rules, so it can reach Oriva and an AI provider directly); in tests it
 * is a fake. Keeping the modules on this shape is what lets them be tested without Obsidian.
 */
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string;
  /** Always false here: callers read the status and word their own error. */
  throw?: boolean;
}

export interface HttpResponse {
  status: number;
  json: unknown;
  text: string;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** The `error` a JSON body carries, if any. */
export function errorFrom(response: HttpResponse): string | null {
  try {
    const body = response.json as { error?: unknown } | null;
    if (body && typeof body.error === 'string') return body.error;
    if (body && body.error && typeof (body.error as { message?: unknown }).message === 'string') {
      return (body.error as { message: string }).message;
    }
  } catch {
    // A body that is not JSON: fall through to the status.
  }
  return null;
}
