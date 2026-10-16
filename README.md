# Oriva for Obsidian

Keep your vault in step with your Oriva notes, and ask AI about a note on your own key.

## What it does

- **Sync the notes you choose with Oriva.** Only a note whose properties include `oriva: true` is synced; the rest of your vault is never read into Oriva or changed. Marked notes arrive in Oriva as private notes, and edits in either place reach the other — when you run the "Sync notes" command, click the ribbon icon, or automatically every few minutes (you choose how often, or turn it off).
  - If a note changed in both places since the last sync, the newer version is kept and the other is saved beside it as `Name (conflicted copy, Oriva|this device, YYYY-MM-DD).md`, and you are told.
  - Deleting a note in one place never deletes it in the other. The note is unlinked instead, and you are told.
  - A note marked `oriva: chain` was published as a chain of entries, and sync leaves it alone.
  - Each synced note gets an `oriva_id` line in its frontmatter, which keeps it linked to the same Oriva note if you rename or move it.
- **Ask AI about this note.** Ask a question about the open note and get the answer in Obsidian, using your own AI key (Anthropic or OpenAI).

The same sync rules run in the Oriva desktop app's folder sync, so a vault kept in step by both behaves the same way.

## Setup

1. Create a personal access token at [oriva.io](https://oriva.io) → Settings → Personal access tokens. It starts with `oriva_pk_`.
2. In Obsidian, open Settings → Oriva and paste the token.
3. For "Ask AI", choose a provider and add your own key from that provider.

## Disclosures

- **An account is required for sync.** Sync needs an Oriva account and a personal access token. "Ask AI" does not need an Oriva account.
- **Payment is not required.** Everything in this plugin is free. "Ask AI" is billed by your AI provider to your own key, never by Oriva.
- **Network use.**
  - Sync sends the notes you marked with `oriva: true` to, and reads your synced notes from, the Oriva address in settings (`https://oriva.io` by default), at `/api/vault-sync/notes`. It is needed to keep the two in step.
  - "Ask AI" sends your question and the open note's text straight to the provider you chose — `api.anthropic.com` or `api.openai.com` — and nowhere else. Oriva never sees it.
- **No telemetry.** The plugin collects no usage data and sends nothing beyond the two uses above.
- **No files outside the vault** are read or written.

Your token and AI key are stored in this vault's plugin data (`.obsidian/plugins/oriva/data.json`), as Obsidian stores every plugin's settings. Revoke the token at oriva.io at any time.

## Building

```
npm install
npm run build
```

This writes `main.js`, the file Obsidian loads. A release carries `main.js`, `manifest.json` and `styles.css`,
tagged with the version in `manifest.json`.
