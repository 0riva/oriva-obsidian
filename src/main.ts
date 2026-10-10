/**
 * Oriva for Obsidian.
 *
 * Free core:
 *  - Sync with Oriva — keeps this vault in step with the person's Oriva notes, using the same engine
 *    as the Oriva desktop app (`packages/shared/services/vaultSync/folderSync.ts`): newest edit wins
 *    a clash and the other version is kept as a "conflicted copy"; deleting never cascades.
 *  - Ask AI about this note — on the person's OWN AI key, straight to their provider.
 *
 * Nothing here pays anyone or is sent anywhere except Oriva (for sync) and the AI provider the person
 * chose (for questions). No analytics.
 */
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import {
  describeSyncReport,
  emptyFolderSyncState,
  syncFolder,
  type FolderSyncState,
} from './engine/folderSync';
import { tokenNotesApi } from './orivaNotesApi';
import { vaultFolderAdapter, type VaultLike } from './vaultAdapter';
import { askAboutNote, DEFAULT_MODELS, type AiProvider } from './askAi';
import type { Http } from './request';

interface OrivaSettings {
  orivaUrl: string;
  token: string;
  /** 0 turns automatic sync off. */
  syncEveryMinutes: number;
  aiProvider: AiProvider;
  aiKey: string;
  aiModel: string;
}

interface StoredData {
  settings?: Partial<OrivaSettings>;
  syncState?: FolderSyncState;
}

const DEFAULT_SETTINGS: OrivaSettings = {
  orivaUrl: 'https://oriva.io',
  token: '',
  syncEveryMinutes: 5,
  aiProvider: 'anthropic',
  aiKey: '',
  aiModel: '',
};

const http: Http = async (request) => {
  const response = await requestUrl({ ...request, throw: false });
  let json: unknown = null;
  try {
    json = response.json;
  } catch {
    json = null;
  }
  return { status: response.status, json, text: response.text };
};

export default class OrivaPlugin extends Plugin {
  settings: OrivaSettings = { ...DEFAULT_SETTINGS };
  private syncState: FolderSyncState = emptyFolderSyncState();
  private syncing: Promise<void> | null = null;
  private timer: number | null = null;

  async onload(): Promise<void> {
    const stored = ((await this.loadData()) ?? {}) as StoredData;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored.settings ?? {}) };
    this.syncState = stored.syncState?.version === 1 ? stored.syncState : emptyFolderSyncState();

    this.addCommand({ id: 'sync', name: 'Sync with Oriva', callback: () => void this.syncNow(true) });
    this.addCommand({
      id: 'ask-ai-about-note',
      name: 'Ask AI about this note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) new AskAiModal(this.app, this, file).open();
        return true;
      },
    });
    this.addRibbonIcon('refresh-cw', 'Sync with Oriva', () => void this.syncNow(true));
    this.addSettingTab(new OrivaSettingTab(this.app, this));
    this.restartTimer();
  }

  onunload(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  async saveSettings(): Promise<void> {
    await this.persist();
    this.restartTimer();
  }

  private async persist(): Promise<void> {
    const data: StoredData = { settings: this.settings, syncState: this.syncState };
    await this.saveData(data);
  }

  private restartTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const minutes = Number(this.settings.syncEveryMinutes);
    if (!this.settings.token.trim() || !(minutes > 0)) return;
    this.timer = window.setInterval(() => void this.syncNow(false), minutes * 60 * 1000);
    this.registerInterval(this.timer);
  }

  /** One sync at a time; `loud` reports a quiet result too (a manual run), not only problems. */
  syncNow(loud: boolean): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const api = tokenNotesApi(this.settings.orivaUrl, this.settings.token, http);
        const { state, report } = await syncFolder(vaultFolderAdapter(this.app.vault as unknown as VaultLike), api, this.syncState);
        this.syncState = state;
        await this.persist();
        const lines = describeSyncReport(report);
        const attention = report.conflicts.length + report.unlinked.length + report.errors.length > 0;
        if (loud || attention) new Notice(`Oriva sync\n${lines.join('\n')}`, attention ? 0 : 6000);
      } catch (error) {
        new Notice(`Oriva sync: ${error instanceof Error ? error.message : 'the vault could not be synced.'}`, 0);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  ask(question: string, file: TFile, text: string): Promise<string> {
    return askAboutNote(
      { provider: this.settings.aiProvider, apiKey: this.settings.aiKey, model: this.settings.aiModel },
      question,
      file.basename,
      text,
      http,
    );
  }
}

class AskAiModal extends Modal {
  constructor(app: App, private readonly plugin: OrivaPlugin, private readonly file: TFile) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(`Ask AI about "${this.file.basename}"`);
    const input = contentEl.createEl('textarea', { attr: { rows: '4', placeholder: 'What would you like to know about this note?' } });
    input.style.width = '100%';
    const answer = contentEl.createEl('div');
    answer.style.whiteSpace = 'pre-wrap';
    answer.style.marginTop = '12px';
    const button = contentEl.createEl('button', { text: 'Ask', cls: 'mod-cta' });
    button.style.marginTop = '8px';
    button.addEventListener('click', async () => {
      button.disabled = true;
      answer.setText('Thinking…');
      try {
        const text = await this.app.vault.cachedRead(this.file);
        answer.setText(await this.plugin.ask(input.value, this.file, text));
      } catch (error) {
        answer.setText(error instanceof Error ? error.message : 'The question could not be answered.');
      } finally {
        button.disabled = false;
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class OrivaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OrivaPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('p', {
      text:
        'Sync keeps this vault in step with your Oriva notes. Notes arrive in Oriva as private notes. If a note changed in both ' +
        'places, the newer version is kept and the other is saved beside it as a "conflicted copy", and you are told. Deleting a ' +
        'note in one place never deletes it in the other.',
    });

    new Setting(containerEl)
      .setName('Oriva address')
      .setDesc('Leave as https://oriva.io unless you were told otherwise.')
      .addText((text) =>
        text.setValue(settings.orivaUrl).onChange(async (value) => {
          settings.orivaUrl = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Personal access token')
      .setDesc('Create one at oriva.io → Settings → Personal access tokens. It starts with oriva_pk_.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(settings.token).onChange(async (value) => {
          settings.token = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Sync every (minutes)')
      .setDesc('0 turns automatic sync off; you can still run "Sync with Oriva" yourself.')
      .addText((text) =>
        text.setValue(String(settings.syncEveryMinutes)).onChange(async (value) => {
          const minutes = Number(value);
          settings.syncEveryMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SETTINGS.syncEveryMinutes;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Ask AI').setHeading();

    new Setting(containerEl)
      .setName('AI provider')
      .setDesc('Questions go straight from Obsidian to this provider on your own key. Oriva never sees them.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('anthropic', 'Anthropic (Claude)')
          .addOption('openai', 'OpenAI')
          .setValue(settings.aiProvider)
          .onChange(async (value) => {
            settings.aiProvider = value as AiProvider;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Your AI key')
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(settings.aiKey).onChange(async (value) => {
          settings.aiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });

    const fallback = DEFAULT_MODELS[settings.aiProvider];
    new Setting(containerEl)
      .setName('Model')
      .setDesc(fallback ? `Leave empty for ${fallback}.` : 'The model name your key is for.')
      .addText((text) =>
        text
          .setPlaceholder(fallback)
          .setValue(settings.aiModel)
          .onChange(async (value) => {
            settings.aiModel = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
