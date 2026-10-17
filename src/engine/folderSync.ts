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
 *  - Only the notes you mark are synced: add the property `oriva: true` to a note.
 *    Everything else in the folder is never read into Oriva and never changed. A note already
 *    linked to Oriva (it carries `oriva_id`) keeps syncing.
 *  - A note marked `oriva: chain` is kept on Oriva as one entry per `## ` section, each
 *    matched by a hidden `%% oriva-part: <id> %%` line under its heading: sections can be added,
 *    moved or removed, a removed one leaves the chain and is kept, and edits flow both ways per
 *    section. It goes through `/api/vault-sync/chains`; a host without `listChains`/`saveChain`
 *    leaves such notes alone, both ways.
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

/** One part of a chain as Oriva holds it: the part's whole markdown, its `## ` heading line included. */
export interface RemoteChainPart {
  id: string;
  text: string;
  updatedAt: string;
}

/** A note kept on Oriva as a chain: its parts in order; `path` is the note's file. */
export interface RemoteChain {
  chainId: string;
  path: string;
  parts: RemoteChainPart[];
}

/** A part as sent: an id alone keeps its text and takes its place; no id is a new part. */
export interface ChainPushPart {
  id?: string;
  text?: string;
  /** The Oriva version this text was edited from; a mismatch refuses the whole chain. */
  baseUpdatedAt?: string;
}

/** A whole chain, in the note's order. Parts of the chain left out leave it and are kept. */
export interface ChainPush {
  path: string;
  chainId?: string;
  parts: ChainPushPart[];
}

export type ChainPushResult =
  | { path: string; status: 'saved'; chainId: string; parts: Array<{ id: string; updatedAt: string; created: boolean }>; detached: string[] }
  | { path: string; status: 'conflict'; partIds: string[] }
  | { path: string; status: 'error'; message: string };

export interface NotesApi {
  listNotes(): Promise<RemoteNote[]>;
  saveNotes(notes: PushNote[]): Promise<PushResult[]>;
  /** Chains. A host without these keeps skipping notes marked `oriva: chain`. */
  listChains?(): Promise<RemoteChain[]>;
  saveChain?(chain: ChainPush): Promise<ChainPushResult>;
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
  /** Chained notes: the part order the last sync agreed, by chain id. Absent before 1.1.0. */
  chains?: Record<string, ChainRecord>;
}

/** What the last sync agreed for one chained note. Its parts each have a {@link SyncedRecord} too. */
export interface ChainRecord {
  chainId: string;
  path: string;
  order: string[];
}

export interface SyncReport {
  sentToOriva: string[];
  updatedHere: string[];
  conflicts: Array<{ path: string; winner: 'this device' | 'Oriva'; copyPath: string }>;
  unlinked: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; message: string }>;
  /** One plain sentence per change to a chained note's sections. */
  chains?: string[];
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

/**
 * The value of the `oriva` property in a note's properties block, lower-cased and unquoted —
 * `'true'`, `'chain'`, … — or undefined when there is none. The body is never read.
 */
export function readOrivaMark(markdown: string): string | undefined {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const line = block?.[1]!.match(/^oriva:[ \t]*(.*?)[ \t]*$/m);
  if (!line) return undefined;
  return line[1]!.replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
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

/* ------------------------------------------------------------------------------------------------
 * Chained notes. A note marked `oriva: chain` is kept on Oriva as one entry per `## `
 * section (text before the first `## ` is the first part). Each part carries its own id in a hidden
 * line under its heading — `%% oriva-part: <id> %%`, an Obsidian comment, hidden in Reading view —
 * so a part is found again after headings are added, removed or moved. Parts are matched by that id,
 * never by position, which is what keeps each part's replies with it.
 * ---------------------------------------------------------------------------------------------- */

const PART_LINE = /^[ \t]*(?:%%[ \t]*oriva-part:[ \t]*([0-9a-fA-F-]{36})[ \t]*%%|<!--[ \t]*oriva-part:[ \t]*([0-9a-fA-F-]{36})[ \t]*-->)[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const HEADING = /^#{1,6}[ \t]/;

export interface ChainNotePart {
  id?: string;
  /** The part's markdown without its id line, trimmed. A `## ` part starts with its heading line. */
  text: string;
}

/** A chained note split into its properties block and its parts, in order. */
export function splitChainNote(markdown: string): { front: string; parts: ChainNotePart[] } {
  const text = markdown.replace(/\r\n/g, '\n');
  const fm = text.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  const front = fm ? fm[0].replace(/\n?$/, '\n') : '';
  const body = fm ? text.slice(fm[0].length) : text;

  const groups: string[][] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    if ((!inFence && /^## /.test(line)) || groups.length === 0) groups.push([]);
    groups[groups.length - 1]!.push(line);
  }
  const parts: ChainNotePart[] = [];
  for (const lines of groups) {
    let id: string | undefined;
    const kept = lines.filter((line) => {
      const m = line.match(PART_LINE);
      if (!m) return true;
      id ??= (m[1] ?? m[2])!.toLowerCase();
      return false;
    });
    const partText = kept.join('\n').trim();
    if (partText) parts.push(id ? { id, text: partText } : { text: partText });
  }
  return { front, parts };
}

/** Put `oriva: chain` in a properties block (making one when there is none). */
export function withChainMark(front: string): string {
  if (!front) return '---\noriva: chain\n---\n';
  if (/^oriva:[^\n]*$/m.test(front)) return front.replace(/^oriva:[^\n]*$/m, 'oriva: chain');
  return front.replace(/^---\n/, '---\noriva: chain\n');
}

/** The note as the vault keeps it: each part with its id line under its first line, `oriva_id` = the first part. */
export function joinChainNote(front: string, parts: Array<{ id?: string; text: string }>): string {
  const body = parts
    .map((p) => {
      if (!p.id) return p.text;
      const marker = `%% oriva-part: ${p.id} %%`;
      const lines = p.text.split('\n');
      return HEADING.test(lines[0] ?? '') ? [lines[0], marker, ...lines.slice(1)].join('\n') : [marker, ...lines].join('\n');
    })
    .join('\n\n');
  const note = `${withChainMark(front)}\n${body}\n`;
  return parts[0]?.id ? injectOrivaId(note, parts[0].id) : note;
}

/** A copy of some sections as plain text: no chain mark and no ids, so it is never synced as a chain itself. */
const plainCopy = (parts: Array<{ text: string }>): string => `${parts.map((p) => p.text).join('\n\n')}\n`;

/** A part's heading words, lower-cased — used only to adopt parts that have no id line yet. */
const headingKey = (text: string): string => (text.split('\n')[0] ?? '').replace(/^#+\s*/, '').trim().toLowerCase();

const partTitle = (text: string): string => (text.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim() || 'Untitled';

const sameOrder = (a: ReadonlyArray<string | undefined>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

interface ChainContext {
  adapter: FolderAdapter;
  api: Required<Pick<NotesApi, 'saveChain'>>;
  state: FolderSyncState;
  report: SyncReport;
  taken: Set<string>;
  now: Date;
}

const chainPartRecord = (path: string, id: string, text: string, updatedAt: string): SyncedRecord => ({
  id,
  path: `${path}#part`,
  hash: noteHash(text),
  updatedAt,
});

/** Settle one chained note with its chain on Oriva (or make the chain). */
async function syncChainNote(
  ctx: ChainContext,
  file: LocalNote,
  chain: RemoteChain | undefined,
  adoptId: RemoteNote | undefined,
  /** A plain note that was split into a chain on Oriva: Oriva's shape is the starting point. */
  splitOnOriva = false
): Promise<void> {
  const { state, report } = ctx;
  const chains = (state.chains ??= {});
  const say = (line: string) => (report.chains ??= []).push(line);
  const note = splitChainNote(file.text);

  const tooFew = () =>
    report.errors.push({ path: file.path, message: 'A chained note needs two or more sections (each starting with "## "), so it was not synced.' });

  // ---- A new chain: every part is new, except a plain note being turned into a chain keeps its id.
  if (!chain) {
    if (note.parts.length < 2) return void tooFew();
    const parts: ChainPushPart[] = note.parts.map((p, i) =>
      i === 0 && adoptId ? { id: adoptId.id, text: p.text, baseUpdatedAt: adoptId.updatedAt } : { text: p.text }
    );
    const result = await ctx.api.saveChain({ path: file.path, parts });
    if (result.status !== 'saved') {
      report.errors.push({ path: file.path, message: result.status === 'error' ? result.message : 'This note changed in Oriva while syncing; it will be settled on the next sync.' });
      return;
    }
    const finalParts = note.parts.map((p, i) => ({ id: result.parts[i]!.id, text: p.text }));
    await writeChain(ctx, file, note.front, finalParts, result.chainId, result.parts);
    report.sentToOriva.push(file.path);
    say(`"${file.path}" was sent to Oriva as ${finalParts.length} linked sections.`);
    return;
  }

  const remoteById = new Map(chain.parts.map((p) => [p.id, p]));
  const remoteOrder = chain.parts.map((p) => p.id);
  const prev = chains[chain.chainId];

  // A part that was in this chain at the last sync and is gone from Oriva was taken out there.
  const wasInChain = new Set(prev?.order ?? []);
  const goneOnOriva = note.parts.filter((p): p is { id: string; text: string } => !!p.id && wasInChain.has(p.id) && !remoteById.has(p.id));
  const goneIds = new Set(goneOnOriva.map((p) => p.id));

  // Parts whose id is not in this chain are new; parts with no id are adopted by heading when they can be.
  const used = new Set<string>();
  const local = note.parts.filter((p) => !(p.id && goneIds.has(p.id))).map((p) => {
    if (p.id && remoteById.has(p.id) && !used.has(p.id)) {
      used.add(p.id);
      return { id: p.id as string | undefined, text: p.text };
    }
    return { id: undefined as string | undefined, text: p.text };
  });
  for (const p of local) {
    if (p.id) continue;
    const match = chain.parts.find((r) => !used.has(r.id) && headingKey(r.text) === headingKey(p.text));
    if (match) {
      p.id = match.id;
      used.add(match.id);
    }
  }

  const localOrder = local.map((p) => p.id);
  const baseOrder = (prev?.order ?? remoteOrder).filter((id) => !goneIds.has(id));
  const localStructure = !splitOnOriva && !sameOrder(localOrder, baseOrder);
  const remoteStructure = splitOnOriva || (prev ? !sameOrder(remoteOrder, prev.order) : false);

  // Text of each part both sides hold: one side changed → copy across; both → the newer edit wins.
  const pushText = new Set<string>();
  const finalText = new Map<string, string>();
  const losers: Array<{ id: string; text: string }> = [];
  let anyConflict = false;
  let localWinsAny = false;
  for (const p of local) {
    if (!p.id) continue;
    const r = remoteById.get(p.id)!;
    const lh = noteHash(p.text);
    const rh = noteHash(r.text);
    const rec = state.records[p.id];
    if (lh === rh) {
      finalText.set(p.id, p.text);
      continue;
    }
    const localChanged = rec ? lh !== rec.hash : true;
    const remoteChanged = rec ? r.updatedAt !== rec.updatedAt : true;
    if (localChanged && !remoteChanged) {
      finalText.set(p.id, p.text);
      pushText.add(p.id);
    } else if (remoteChanged && !localChanged) {
      finalText.set(p.id, r.text);
      say(`"${partTitle(r.text)}" in "${file.path}" was updated from Oriva.`);
    } else {
      anyConflict = true;
      const localWins = file.modifiedAt > Date.parse(r.updatedAt);
      if (localWins) {
        localWinsAny = true;
        finalText.set(p.id, p.text);
        pushText.add(p.id);
        losers.push({ id: p.id, text: r.text });
      } else {
        finalText.set(p.id, r.text);
        losers.push({ id: p.id, text: p.text });
      }
    }
  }

  // The order to keep: Oriva's when only Oriva's changed, otherwise the note's.
  type FinalPart = { id?: string; text: string };
  let finalParts: FinalPart[];
  const removedHere = goneOnOriva;
  if (remoteStructure && !localStructure) {
    const localById = new Map(local.filter((p) => p.id).map((p) => [p.id!, p]));
    finalParts = chain.parts.map((r) => {
      const known = localById.get(r.id);
      if (!known) say(`"${partTitle(r.text)}" was added to "${file.path}" from Oriva.`);
      return { id: r.id, text: known ? finalText.get(r.id) ?? known.text : r.text };
    });
  } else {
    finalParts = local.map((p) => ({ id: p.id, text: p.id ? finalText.get(p.id) ?? p.text : p.text }));
  }

  if (finalParts.length < 2) return void tooFew();
  const kept = new Set(finalParts.filter((p) => p.id).map((p) => p.id!));
  const detaching = chain.parts.filter((r) => !kept.has(r.id));
  const needsPush = pushText.size > 0 || finalParts.some((p) => !p.id) || !sameOrder(finalParts.map((p) => p.id), remoteOrder);

  // Both sides changed the sections themselves: the note's shape wins, Oriva's whole version is kept beside it.
  if (localStructure && remoteStructure) {
    const copyPath = conflictCopyPath(file.path, 'Oriva', ctx.now, ctx.taken);
    ctx.taken.add(copyPath);
    await safeWrite(ctx, copyPath, plainCopy(chain.parts));
    report.conflicts.push({ path: file.path, winner: 'this device', copyPath });
  } else if (anyConflict) {
    // The losing version of each disputed section, in a copy of the whole note.
    const loserById = new Map(losers.map((l) => [l.id, l.text]));
    const side = localWinsAny ? 'Oriva' : 'this device';
    const copyPath = conflictCopyPath(file.path, side, ctx.now, ctx.taken);
    ctx.taken.add(copyPath);
    await safeWrite(ctx, copyPath, plainCopy(finalParts.map((p) => ({ text: (p.id && loserById.get(p.id)) || p.text }))));
    report.conflicts.push({ path: file.path, winner: localWinsAny ? 'this device' : 'Oriva', copyPath });
  }

  let savedParts: Array<{ id: string; updatedAt: string }> | undefined;
  if (needsPush) {
    const parts: ChainPushPart[] = finalParts.map((p) => {
      if (!p.id) return { text: p.text };
      return pushText.has(p.id) ? { id: p.id, text: p.text, baseUpdatedAt: remoteById.get(p.id)!.updatedAt } : { id: p.id };
    });
    const result = await ctx.api.saveChain({ path: file.path, chainId: chain.chainId, parts });
    if (result.status !== 'saved') {
      report.errors.push({ path: file.path, message: result.status === 'error' ? result.message : 'This note changed in Oriva while syncing; it will be settled on the next sync.' });
      return;
    }
    finalParts = finalParts.map((p, i) => {
      if (!p.id) say(`"${partTitle(p.text)}" was added to Oriva as section ${i + 1} of "${file.path}".`);
      return { id: result.parts[i]!.id, text: p.text };
    });
    savedParts = result.parts;
    for (const r of detaching) {
      delete state.records[r.id];
      say(`"${partTitle(r.text)}" left the chain of "${file.path}" and stays on Oriva as its own private note, with its replies.`);
    }
    if (pushText.size > 0 && !report.sentToOriva.includes(file.path)) report.sentToOriva.push(file.path);
  }

  if (removedHere.length > 0) {
    const copyPath = conflictCopyPath(file.path, 'this device', ctx.now, ctx.taken);
    ctx.taken.add(copyPath);
    await safeWrite(ctx, copyPath, plainCopy(removedHere));
    for (const p of removedHere) {
      delete state.records[p.id];
      report.unlinked.push({ path: file.path, reason: `"${partTitle(p.text)}" was taken out of this chain in Oriva, so it left the note; its text is saved in "${copyPath}".` });
    }
  }

  const updatedAt = savedParts ?? finalParts.map((p) => ({ id: p.id!, updatedAt: remoteById.get(p.id!)!.updatedAt }));
  await writeChain(ctx, file, note.front, finalParts as Array<{ id: string; text: string }>, chain.chainId, updatedAt);
}

async function safeWrite(ctx: ChainContext, path: string, text: string): Promise<boolean> {
  try {
    await ctx.adapter.write(path, text);
    return true;
  } catch (error) {
    ctx.report.errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** Write the note back when its text changed, and remember what both sides now agree. */
async function writeChain(
  ctx: ChainContext,
  file: LocalNote,
  front: string,
  parts: Array<{ id: string; text: string }>,
  chainId: string,
  updated: Array<{ id: string; updatedAt: string }>
): Promise<void> {
  const text = joinChainNote(front, parts);
  if (text !== file.text.replace(/\r\n/g, '\n') && !(await safeWrite(ctx, file.path, text))) return;
  const at = new Map(updated.map((u) => [u.id, u.updatedAt]));
  for (const p of parts) ctx.state.records[p.id] = chainPartRecord(file.path, p.id, p.text, at.get(p.id) ?? '');
  (ctx.state.chains ??= {})[chainId] = { chainId, path: file.path, order: parts.map((p) => p.id) };
  ctx.state.unlinkedPaths = ctx.state.unlinkedPaths.filter((path) => path !== file.path);
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
    ...(previous.chains ? { chains: { ...previous.chains } } : {}),
  };
  const report: SyncReport = { sentToOriva: [], updatedHere: [], conflicts: [], unlinked: [], errors: [] };

  const chainsOn = typeof api.listChains === 'function' && typeof api.saveChain === 'function';
  const [localAll, remoteAll, chainsAll] = await Promise.all([
    adapter.list(),
    api.listNotes(),
    chainsOn ? api.listChains!() : Promise.resolve([] as RemoteChain[]),
  ]);
  const remoteChains = chainsAll.filter((c) => isSafeNotePath(c.path) && c.parts.length > 0);
  const chainByPart = new Map<string, RemoteChain>();
  for (const c of remoteChains) for (const p of c.parts) chainByPart.set(p.id, c);
  const chainFiles: LocalNote[] = [];
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
    const mark = readOrivaMark(file.text);
    let id = extractOrivaId(file.text) ?? recordByPath.get(file.path)?.id;
    if (mark === 'chain') {
      // Claimed so its first part is never written back over the file or beside it.
      if (id) claimed.add(id);
      if (chainsOn) chainFiles.push(file);
      continue;
    }
    // A plain synced note that was turned into a chain on Oriva now syncs as one.
    if (id && chainByPart.has(id)) {
      claimed.add(id);
      chainFiles.push(file);
      continue;
    }
    // Not marked and never linked: this note is not the person's to share yet.
    if (!id && mark !== 'true') continue;
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

  if (chainsOn) await syncChains({ adapter, api: { saveChain: api.saveChain! }, state, report, taken, now }, chainFiles, remoteChains, remoteById);

  return { state, report };
}

/** Every chained note, then every chain on Oriva that has no file here yet. */
async function syncChains(ctx: ChainContext, files: LocalNote[], remoteChains: RemoteChain[], remoteNotes: Map<string, RemoteNote>): Promise<void> {
  const { state, report } = ctx;
  const byPart = new Map<string, RemoteChain>();
  for (const c of remoteChains) for (const p of c.parts) byPart.set(p.id, c);
  const byPath = new Map(remoteChains.map((c) => [c.path, c]));
  const byId = new Map(remoteChains.map((c) => [c.chainId, c]));
  const claimedChains = new Set<string>();

  for (const original of files) {
    let file = original;
    try {
      const note = splitChainNote(file.text);
      const fileId = extractOrivaId(file.text);
      const recorded = Object.values(state.chains ?? {}).find((c) => c.path === file.path);
      let chain =
        note.parts.map((p) => (p.id ? byPart.get(p.id) : undefined)).find(Boolean) ??
        (fileId ? byPart.get(fileId) : undefined) ??
        (recorded ? byId.get(recorded.chainId) : undefined) ??
        byPath.get(file.path);
      // A copied file carries its original's ids; the copy becomes a chain of its own.
      if (chain && claimedChains.has(chain.chainId)) {
        chain = undefined;
        file = { ...file, text: joinChainNote(removeOrivaId(note.front), note.parts.map((p) => ({ text: p.text }))) };
      }
      const adopt = !chain && fileId ? remoteNotes.get(fileId) : undefined;
      const wasSynced = !!recorded || note.parts.some((p) => p.id && state.records[p.id]);
      if (!chain && !adopt && wasSynced && file === original) {
        if (recorded) delete state.chains![recorded.chainId];
        for (const p of note.parts) if (p.id) delete state.records[p.id];
        if (!state.unlinkedPaths.includes(file.path)) state.unlinkedPaths.push(file.path);
        report.unlinked.push({ path: file.path, reason: 'This chained note is no longer in Oriva, so your file is kept and no longer synced.' });
        continue;
      }
      if (chain) claimedChains.add(chain.chainId);
      // Not marked as a chain here and never synced as one: it was split on Oriva.
      const splitOnOriva = !!chain && readOrivaMark(original.text) !== 'chain' && !state.chains?.[chain.chainId];
      await syncChainNote(ctx, file, chain, adopt, splitOnOriva);
    } catch (error) {
      report.errors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const c of remoteChains) {
    if (claimedChains.has(c.chainId) || state.unlinkedIds.includes(c.chainId)) continue;
    const rec = state.chains?.[c.chainId];
    if (rec) {
      delete state.chains![c.chainId];
      for (const id of rec.order) delete state.records[id];
      state.unlinkedIds.push(c.chainId);
      report.unlinked.push({ path: rec.path, reason: 'This file was deleted here, so the chained note is kept in Oriva and no longer synced.' });
      continue;
    }
    let path = c.path;
    if (ctx.taken.has(path)) path = path.replace(/\.md$/i, ' (Oriva).md');
    if (ctx.taken.has(path)) continue;
    ctx.taken.add(path);
    try {
      await writeChain(ctx, { path, text: '', modifiedAt: 0 }, '', c.parts.map((p) => ({ id: p.id, text: p.text.replace(/\r\n/g, '\n').trim() })), c.chainId, c.parts);
      report.updatedHere.push(path);
    } catch (error) {
      report.errors.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
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
  lines.push(...(report.chains ?? []));
  for (const e of report.errors) lines.push(`"${e.path}" could not be synced: ${e.message}`);
  if (!lines.length) lines.push('Everything is already in step.');
  return lines;
}
