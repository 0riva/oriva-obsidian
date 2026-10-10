/**
 * Oriva's notes API (`/api/vault-sync/notes`), called with the person's own personal
 * access token (`oriva_pk_…`, minted at oriva.io/settings/personal-access-tokens).
 */
import type { NotesApi, PushNote, PushResult, RemoteNote } from './engine/folderSync';
import { errorFrom, type Http, type HttpResponse } from './request';

/** The API takes at most 200 notes per save. */
export const SAVE_BATCH = 200;

export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || 'https://oriva.io';
}

export function tokenNotesApi(baseUrl: string, token: string, http: Http): NotesApi {
  const url = `${normaliseBaseUrl(baseUrl)}/api/vault-sync/notes`;
  const key = token.trim();
  if (!key.startsWith('oriva_pk_')) {
    throw new Error('Add your Oriva personal access token in this plugin\'s settings first.');
  }
  const headers = { Authorization: `Bearer ${key}` };

  const read = (response: HttpResponse): unknown => {
    if (response.status >= 400) throw new Error(errorFrom(response) ?? `Oriva answered ${response.status}.`);
    return response.json;
  };

  return {
    async listNotes(): Promise<RemoteNote[]> {
      const body = read(await http({ url, headers, throw: false })) as { notes?: RemoteNote[] };
      return body.notes ?? [];
    },
    async saveNotes(notes: PushNote[]): Promise<PushResult[]> {
      const results: PushResult[] = [];
      for (let i = 0; i < notes.length; i += SAVE_BATCH) {
        const response = await http({
          url,
          method: 'POST',
          headers,
          contentType: 'application/json',
          body: JSON.stringify({ notes: notes.slice(i, i + SAVE_BATCH) }),
          throw: false,
        });
        results.push(...((read(response) as { results?: PushResult[] }).results ?? []));
      }
      return results;
    },
  };
}
