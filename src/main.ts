/**
 * Oriva for Obsidian.
 *
 * Free core:
 *  - Sync notes — keeps this vault in step with the person's Oriva notes, using the same engine
 *    as the Oriva desktop app (`packages/shared/services/vaultSync/folderSync.ts`): newest edit wins
 *    a clash and the other version is kept as a "conflicted copy"; deleting never cascades.
 *  - Ask AI about this note — on the person's OWN AI key, straight to their provider.
 *
 * Nothing here pays anyone or is sent anywhere except Oriva (for sync) and the AI provider the person
 * chose (for questions). No analytics.
 */
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl, type SettingDefinitionItem } from 'obsidian';
import {
  describeSyncReport,
  emptyFolderSyncState,
  syncFolder,
  type FolderSyncState,
} from './engine/folderSync';
import { tokenNotesApi } from './orivaNotesApi';
import { vaultFolderAdapter } from './vaultAdapter';
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

    // Obsidian prints the plugin name beside every command, so the name itself leaves "Oriva" out.
    this.addCommand({ id: 'sync', name: 'Sync notes', callback: () => void this.syncNow(true) });
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
    this.addRibbonIcon('refresh-cw', 'Sync notes', () => void this.syncNow(true));
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
        const { state, report } = await syncFolder(vaultFolderAdapter(this.app.vault), api, this.syncState);
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
    // Layout lives in styles.css (Obsidian asks plugins not to set styles inline).
    const input = contentEl.createEl('textarea', {
      cls: 'oriva-ask-input',
      attr: { rows: '4', placeholder: 'What would you like to know about this note?' },
    });
    const answer = contentEl.createDiv({ cls: 'oriva-ask-answer' });
    const button = contentEl.createEl('button', { text: 'Ask', cls: ['mod-cta', 'oriva-ask-button'] });
    button.addEventListener('click', () => void this.answer(input.value, answer, button));
  }

  private async answer(question: string, answer: HTMLElement, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    answer.setText('Thinking…');
    try {
      const text = await this.app.vault.cachedRead(this.file);
      answer.setText(await this.plugin.ask(question, this.file, text));
    } catch (error) {
      answer.setText(error instanceof Error ? error.message : 'The question could not be answered.');
    } finally {
      button.disabled = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Declared settings (Obsidian 1.13+), so each one appears in Obsidian's settings search. Every row
 * draws its own control: the token and AI key stay masked, and every change goes through
 * `saveSettings`, which keeps the sync state stored beside the settings.
 */
class OrivaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: OrivaPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const masked = (setting: Setting, value: string, onChange: (value: string) => void) =>
      setting.addText((text) => {
        text.inputEl.type = 'password';
        text.setValue(value).onChange((next) => {
          onChange(next.trim());
          void save();
        });
      });
    const fallback = () => DEFAULT_MODELS[settings.aiProvider];

    return [
      {
        type: 'group',
        items: [
          {
            name: 'How sync works',
            desc:
              'Sync keeps the notes you choose in step with your Oriva notes. Only a note whose properties include "oriva: true" is ' +
              'synced; the rest of this vault is never read into Oriva or changed. Marked notes arrive in Oriva as private notes. If a note changed in both ' +
              'places, the newer version is kept and the other is saved beside it as a "conflicted copy", and you are told. Deleting a ' +
              'note in one place never deletes it in the other.',
          },
          {
            name: 'Oriva address',
            desc: 'Leave as https://oriva.io unless you were told otherwise.',
            render: (setting) =>
              void setting.addText((text) =>
                text.setValue(settings.orivaUrl).onChange((value) => {
                  settings.orivaUrl = value;
                  void save();
                }),
              ),
          },
          {
            name: 'Personal access token',
            desc: 'Create one at oriva.io → Settings → Personal access tokens. It starts with oriva_pk_.',
            render: (setting) => void masked(setting, settings.token, (value) => (settings.token = value)),
          },
          {
            name: 'Sync every (minutes)',
            desc: '0 turns automatic sync off; you can still sync any time from the command palette or the ribbon.',
            render: (setting) =>
              void setting.addText((text) =>
                text.setValue(String(settings.syncEveryMinutes)).onChange((value) => {
                  const minutes = Number(value);
                  settings.syncEveryMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_SETTINGS.syncEveryMinutes;
                  void save();
                }),
              ),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Ask AI',
        items: [
          {
            name: 'AI provider',
            desc: 'Questions go straight from Obsidian to this provider on your own key. Oriva never sees them.',
            render: (setting) =>
              void setting.addDropdown((dropdown) =>
                dropdown
                  .addOption('anthropic', 'Anthropic (Claude)')
                  .addOption('openai', 'OpenAI')
                  .setValue(settings.aiProvider)
                  .onChange((value) => {
                    settings.aiProvider = value as AiProvider;
                    void save();
                    // The model hint below depends on the provider.
                    this.update();
                  }),
              ),
          },
          {
            name: 'Your AI key',
            render: (setting) => void masked(setting, settings.aiKey, (value) => (settings.aiKey = value)),
          },
          {
            name: 'Model',
            desc: fallback() ? `Leave empty for ${fallback()}.` : 'The model name your key is for.',
            render: (setting) =>
              void setting.addText((text) =>
                text
                  .setPlaceholder(fallback())
                  .setValue(settings.aiModel)
                  .onChange((value) => {
                    settings.aiModel = value.trim();
                    void save();
                  }),
              ),
          },
        ],
      },
    ];
  }
}
