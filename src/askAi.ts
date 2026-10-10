/**
 * "Ask AI about this note" on the person's OWN key — the free core of the plugin. The question and
 * the note go straight from Obsidian to the provider the person chose; Oriva never sees them and
 * never pays for them.
 */
import { errorFrom, type Http } from './request';

export type AiProvider = 'anthropic' | 'openai';

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  /** Empty means the provider's default below. */
  model: string;
}

/**
 * Defaults; the person can type any model their key can use. OpenAI has none here on purpose: its
 * model names change often, so the person names the one their key is for.
 */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: '',
};

/** Long notes are cut to keep a single question affordable. */
export const MAX_NOTE_CHARS = 60000;

export function buildPrompt(question: string, noteTitle: string, noteText: string): string {
  const text = noteText.length > MAX_NOTE_CHARS ? `${noteText.slice(0, MAX_NOTE_CHARS)}\n\n[The note was cut short here.]` : noteText;
  return `Here is a note called "${noteTitle}".\n\n<note>\n${text}\n</note>\n\n${question.trim()}`;
}

export async function askAboutNote(
  settings: AiSettings,
  question: string,
  noteTitle: string,
  noteText: string,
  http: Http,
): Promise<string> {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) throw new Error('Add your own AI key in this plugin\'s settings first.');
  if (!question.trim()) throw new Error('Type a question first.');
  const model = settings.model.trim() || DEFAULT_MODELS[settings.provider];
  if (!model) throw new Error('Name the AI model to use in this plugin\'s settings first.');
  const prompt = buildPrompt(question, noteTitle, noteText);

  if (settings.provider === 'anthropic') {
    const response = await http({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
      throw: false,
    });
    if (response.status >= 400) throw new Error(errorFrom(response) ?? `The AI provider answered ${response.status}.`);
    const blocks = (response.json as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    return blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
  }

  const response = await http({
    url: 'https://api.openai.com/v1/chat/completions',
    method: 'POST',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    throw: false,
  });
  if (response.status >= 400) throw new Error(errorFrom(response) ?? `The AI provider answered ${response.status}.`);
  const choices = (response.json as { choices?: Array<{ message?: { content?: string } }> }).choices ?? [];
  return (choices[0]?.message?.content ?? '').trim();
}
