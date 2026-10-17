/**
 * Frontmatter Injector — Stamps oriva_id into markdown YAML frontmatter
 *
 * Used after import+publish to write the entry's UUID back into the source
 * .md file, creating the bidirectional anchor for vault sync:
 *   - File → Entry: oriva_id in YAML frontmatter
 *   - Entry → File: vault_path in entries table
 *
 * Handles 3 cases:
 * 1. File has existing frontmatter → inject/update oriva_id field
 * 2. File has frontmatter with oriva_id → update it
 * 3. File has no frontmatter → prepend new frontmatter block
 */

/**
 * Inject or update oriva_id in a markdown string's YAML frontmatter.
 * Returns the modified markdown string.
 */
export function injectOrivaId(markdown: string, entryId: string): string {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);

  if (frontmatterMatch) {
    const fmContent = frontmatterMatch[1]!;
    const rest = markdown.slice(frontmatterMatch[0].length);

    // Check if oriva_id already exists
    if (/^oriva_id:/m.test(fmContent)) {
      // Update existing oriva_id
      const updatedFm = fmContent.replace(
        /^oriva_id:.*$/m,
        `oriva_id: ${entryId}`
      );
      return `---\n${updatedFm}\n---\n${rest}`;
    } else {
      // Inject oriva_id as first field (most important for sync)
      return `---\noriva_id: ${entryId}\n${fmContent}\n---\n${rest}`;
    }
  }

  // No frontmatter — prepend new block
  return `---\noriva_id: ${entryId}\n---\n\n${markdown}`;
}

/**
 * Extract oriva_id from markdown frontmatter (if present).
 * Lighter than full YAML parse — used for quick checks.
 */
export function extractOrivaId(markdown: string): string | undefined {
  // Only the properties block counts: a note that SHOWS `oriva_id:` in its text (docs, an example)
  // is not linked to anything.
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const match = block?.[1]?.match(/^oriva_id:[ \t]*(\S.*?)[ \t]*$/m);
  return match?.[1]?.trim() || undefined;
}

