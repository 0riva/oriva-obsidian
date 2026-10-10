/**
 * Two-way sync between a folder of markdown files (a plain folder, or an Obsidian vault) and the
 * person's Oriva notes.
 *
 * One engine, two hosts: the desktop app (Electron, which can read and write a folder the person
 * picks) and the Oriva plugin for Obsidian. Each host supplies a {@link FolderAdapter} for its files
 * and a {@link NotesApi} for `/api/vault-sync/notes`, and keeps the returned {@link FolderSyncState}
 * between runs. Nothing here touches a file system or the network itself, so the rules are the same
 * on both hosts and are tested once.
 *
 * The rules, as the person is told them:
 *  - A note changed on one side only: that side's version is copied to the other.
 *  - A note changed on BOTH sides since the last sync: the most recent edit wins, and the other
 *    version is kept beside it as "<name> (conflicted copy, Oriva|this device, <date>).md". The
 *    report names every such note.
 *  - A file carries its note's id in its properties block (`oriva_id`), so renaming or moving the
 *    file keeps it linked to the same note.
 *  - Deleting is never copied across. A note deleted on one side is kept on the other, stops being
 *    synced, and the report says so.
 */
import { extractOrivaId, injectOrivaId } from './frontmatterInjector';

/** A markdown file in the synced folder. `path` is relative to the folder, with `/` separators. */
export interface LocalNote {
  path: string;
  text: string;
  /** Last modified, in milliseconds since the epoch. */
  modifiedAt: number;
}

/** A synced note as Oriva holds it. `text` never carries `oriva_id`. */
export interface RemoteNote {
  id: string;
  path: string;
  text: string;
  updatedAt: string;
}

export interface PushNote {
  path: string;
  text: string;
  /** Absent for a new note. */
  id?: string;
  /** The Oriva version this edit was made from; a mismatch is refused as a conflict. */
  baseUpdatedAt?: string;
}

export type PushResult =
  | { path: string; status: 'created' | 'updated'; id: string; updatedAt: string }
  | { path: string; status: 'conflict'; id: string; remote: RemoteNote }
  | { path: string; status: 'error'; message: string };

export interface NotesApi {
  listNotes(): Promise<RemoteNote[]>;
  saveNotes(notes: PushNote[]): Promise<PushResult[]>;
}

export interface FolderAdapter {
  list(): Promise<LocalNote[]>;
  write(path: string, text: string): Promise<void>;
}

/** What the last sync agreed for one note. */
export interface SyncedRecord {
  id: string;
  path: string;
  hash: string;
  updatedAt: string;
}

export interface FolderSyncState {
  version: 1;
  records: Record<string, SyncedRecord>;
  /** Files that no longer have a note in Oriva; skipped until the person shares them again. */
  unlinkedPaths: string[];
  /** Notes whose file was deleted here; kept in Oriva and no longer synced. */
  unlinkedIds: string[];
}

export interface SyncReport {
  sentToOriva: string[];
  updatedHere: string[];
  conflicts: Array<{ path: string; winner: 'this device' | 'Oriva'; copyPath: string }>;
  unlinked: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; message: string }>;
}

export const emptyFolderSyncState = (): FolderSyncState => ({ version: 1, records: {}, unlinkedPaths: [], unlinkedIds: [] });

/** Remove the `oriva_id` line, and the properties block too if that was all it held. */
export function removeOrivaId(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match || !/^oriva_id:/m.test(match[1]!)) return markdown;
  const kept = match[1]!.split(/\r?\n/).filter((line) => !/^oriva_id:/.test(line));
  const rest = markdown.slice(match[0].length);
  if (kept.every((line) => !line.trim())) return rest.replace(/^\r?\n/, '');
  return `---\n${kept.join('\n')}\n---\n${rest}`;
}

/** The text two sides compare: no `oriva_id`, Unix line endings, no trailing blank space. */
export const normaliseNoteText = (text: string): string => removeOrivaId(text).replace(/\r\n/g, '\n').trimEnd();

/** A fast, stable 53-bit hash (cyrb53) — change detection only, never security. */
export function noteHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A relative path a host may safely write: no absolute path, no `..`, markdown only. */
export function isSafeNotePath(path: string): boolean {
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\')) return false;
  if (path.split('/').some((part) => part === '..' || part === '.' || part === '')) return false;
  return path.toLowerCase().endsWith('.md');
}

/** "Folder/Note.md" → "Folder/Note (conflicted copy, Oriva, 2026-10-09).md", avoiding taken names. */
export function conflictCopyPath(path: string, side: 'Oriva' | 'this device', at: Date, taken: ReadonlySet<string>): string {
  const base = path.replace(/\.md$/i, '');
  const stamp = at.toISOString().slice(0, 10);
  let candidate = `${base} (conflicted copy, ${side}, ${stamp}).md`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (conflicted copy, ${side}, ${stamp}, ${n}).md`;
  return candidate;
}

/** Run one sync. Returns the state to keep for next time and what happened, for the person. */
export async function syncFolder(
  adapter: FolderAdapter,
  api: NotesApi,
  previous: FolderSyncState,
  now: Date = new Date()
): Promise<{ state: FolderSyncState; report: SyncReport }> {
  const state: FolderSyncState = {
    version: 1,
    records: { ...previous.records },
    unlinkedPaths: [...previous.unlinkedPaths],
    unlinkedIds: [...previous.unlinkedIds],
  };
  const report: SyncReport = { sentToOriva: [], updatedHere: [], conflicts: [], unlinked: [], errors: [] };

  const [localAll, remoteAll] = await Promise.all([adapter.list(), api.listNotes()]);
  const local = localAll.filter((n) => isSafeNotePath(n.path));
  const remote = remoteAll.filter((n) => isSafeNotePath(n.path));
  const remoteById = new Map(remote.map((n) => [n.id, n]));
  const remoteByPath = new Map(remote.map((n) => [n.path, n]));
  const recordByPath = new Map(Object.values(state.records).map((r) => [r.path, r]));
  const taken = new Set(local.map((n) => n.path));

  const writes: Array<{ path: string; text: string; record?: SyncedRecord; reportAs?: 'updatedHere' }> = [];
  const pushes: Array<{ note: PushNote; local: LocalNote; hash: string; reportAs: 'sentToOriva' | 'conflict' }> = [];
  const claimed = new Set<string>();

  for (const file of local) {
    if (state.unlinkedPaths.includes(file.path)) continue;
    let id = extractOrivaId(file.text) ?? recordByPath.get(file.path)?.id;
    if (!id) {
      const samePath = remoteByPath.get(file.path);
      if (samePath && !claimed.has(samePath.id)) id = samePath.id;
    }
    // A copied file keeps its original's id; the second one is a new note.
    if (id && claimed.has(id)) id = undefined;

    const text = normaliseNoteText(file.text);
    const hash = noteHash(text);

    if (!id) {
      pushes.push({ note: { path: file.path, text }, local: file, hash, reportAs: 'sentToOriva' });
      continue;
    }
    claimed.add(id);

    const r = remoteById.get(id);
    if (!r) {
      if (state.unlinkedIds.includes(id)) continue;
      delete state.records[id];
      if (!state.unlinkedPaths.includes(file.path)) state.unlinkedPaths.push(file.path);
      report.unlinked.push({ path: file.path, reason: 'This note is no longer in Oriva, so your file is kept and no longer synced.' });
      continue;
    }

    const remoteText = normaliseNoteText(r.text);
    const remoteHash = noteHash(remoteText);
    const rec = state.records[id];
    const record = (h: string, updatedAt: string): SyncedRecord => ({ id, path: file.path, hash: h, updatedAt });

    if (hash === remoteHash) {
      state.records[id] = record(hash, r.updatedAt);
      if (file.path !== r.path) pushes.push({ note: { path: file.path, text, id, baseUpdatedAt: r.updatedAt }, local: file, hash, reportAs: 'sentToOriva' });
      continue;
    }

    const localChanged = rec ? hash !== rec.hash : true;
    const remoteChanged = rec ? r.updatedAt !== rec.updatedAt : true;

    if (localChanged && !remoteChanged) {
      pushes.push({ note: { path: file.path, text, id, baseUpdatedAt: r.updatedAt }, local: file, hash, reportAs: 'sentToOriva' });
    } else if (remoteChanged && !localChanged) {
      writes.push({ path: file.path, text: injectOrivaId(remoteText, id), record: record(remoteHash, r.updatedAt), reportAs: 'updatedHere' });
    } else {
      const localWins = file.modifiedAt > Date.parse(r.updatedAt);
      const copyPath = conflictCopyPath(file.path, localWins ? 'Oriva' : 'this device', now, taken);
      taken.add(copyPath);
      report.conflicts.push({ path: file.path, winner: localWins ? 'this device' : 'Oriva', copyPath });
      if (localWins) {
        writes.push({ path: copyPath, text: remoteText });
        pushes.push({ note: { path: file.path, text, id, baseUpdatedAt: r.updatedAt }, local: file, hash, reportAs: 'conflict' });
      } else {
        writes.push({ path: copyPath, text });
        writes.push({ path: file.path, text: injectOrivaId(remoteText, id), record: record(remoteHash, r.updatedAt) });
      }
    }
  }

  for (const r of remote) {
    if (claimed.has(r.id) || state.unlinkedIds.includes(r.id)) continue;
    const rec = state.records[r.id];
    if (rec) {
      delete state.records[r.id];
      state.unlinkedIds.push(r.id);
      report.unlinked.push({ path: rec.path, reason: 'This file was deleted here, so the note is kept in Oriva and no longer synced.' });
      continue;
    }
    let path = r.path;
    if (taken.has(path)) path = path.replace(/\.md$/i, ' (Oriva).md');
    if (taken.has(path)) continue;
    taken.add(path);
    const remoteText = normaliseNoteText(r.text);
    writes.push({ path, text: injectOrivaId(remoteText, r.id), record: { id: r.id, path, hash: noteHash(remoteText), updatedAt: r.updatedAt }, reportAs: 'updatedHere' });
  }

  for (const w of writes) {
    try {
      await adapter.write(w.path, w.text);
      if (w.record) state.records[w.record.id] = w.record;
      if (w.reportAs === 'updatedHere') report.updatedHere.push(w.path);
    } catch (error) {
      report.errors.push({ path: w.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (pushes.length > 0) {
    let results: PushResult[] = [];
    try {
      results = await api.saveNotes(pushes.map((p) => p.note));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const p of pushes) report.errors.push({ path: p.note.path, message });
    }
    const byPath = new Map(results.map((r) => [r.path, r]));
    for (const p of pushes) {
      const result = byPath.get(p.note.path);
      if (!result) continue;
      if (result.status === 'error') {
        report.errors.push({ path: p.note.path, message: result.message });
      } else if (result.status === 'conflict') {
        report.errors.push({ path: p.note.path, message: 'This note changed in Oriva while syncing; it will be settled on the next sync.' });
      } else {
        state.records[result.id] = { id: result.id, path: p.note.path, hash: p.hash, updatedAt: result.updatedAt };
        state.unlinkedPaths = state.unlinkedPaths.filter((path) => path !== p.note.path);
        if (p.reportAs === 'sentToOriva') report.sentToOriva.push(p.note.path);
        if (extractOrivaId(p.local.text) !== result.id) {
          try {
            await adapter.write(p.note.path, injectOrivaId(p.note.text, result.id));
          } catch (error) {
            report.errors.push({ path: p.note.path, message: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
  }

  return { state, report };
}

/** One sentence per outcome, for a notice or a settings line. */
export function describeSyncReport(report: SyncReport): string[] {
  const lines: string[] = [];
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (report.sentToOriva.length) lines.push(`${n(report.sentToOriva.length, 'note')} sent to Oriva.`);
  if (report.updatedHere.length) lines.push(`${n(report.updatedHere.length, 'note')} updated from Oriva.`);
  for (const c of report.conflicts) {
    lines.push(`"${c.path}" changed in both places: the newer version (${c.winner}) was kept, and the other is saved as "${c.copyPath}".`);
  }
  for (const u of report.unlinked) lines.push(`"${u.path}": ${u.reason}`);
  for (const e of report.errors) lines.push(`"${e.path}" could not be synced: ${e.message}`);
  if (!lines.length) lines.push('Everything is already in step.');
  return lines;
}
