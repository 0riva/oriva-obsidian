/**
 * The vault as the shared sync engine sees it: every markdown note with its text and when it last
 * changed, and a way to write one back. Uses only the parts of Obsidian's `Vault` listed in
 * `VaultLike`, so tests can hand in a fake.
 */
import type { FolderAdapter, LocalNote } from './engine/folderSync';

export interface VaultFile {
  path: string;
  stat: { mtime: number; size: number };
}

export interface VaultLike {
  getMarkdownFiles(): VaultFile[];
  cachedRead(file: VaultFile): Promise<string>;
  getAbstractFileByPath(path: string): unknown;
  modify(file: VaultFile, data: string): Promise<void>;
  create(path: string, data: string): Promise<unknown>;
  createFolder(path: string): Promise<unknown>;
}

/** Notes bigger than this are left out of sync, as in the desktop app. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;

const isFile = (value: unknown): value is VaultFile =>
  !!value && typeof value === 'object' && typeof (value as VaultFile).path === 'string' && !!(value as VaultFile).stat;

export function vaultFolderAdapter(vault: VaultLike): FolderAdapter {
  return {
    async list(): Promise<LocalNote[]> {
      const notes: LocalNote[] = [];
      for (const file of vault.getMarkdownFiles()) {
        if (file.stat.size > MAX_NOTE_BYTES) continue;
        notes.push({ path: file.path, text: await vault.cachedRead(file), modifiedAt: file.stat.mtime });
      }
      return notes;
    },
    async write(path: string, text: string): Promise<void> {
      const existing = vault.getAbstractFileByPath(path);
      if (isFile(existing)) {
        await vault.modify(existing, text);
        return;
      }
      if (existing) throw new Error(`"${path}" is a folder in this vault, so the note cannot be written there.`);
      const parts = path.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i += 1) {
        const folder = parts.slice(0, i).join('/');
        if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
      }
      await vault.create(path, text);
    },
  };
}
