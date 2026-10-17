/**
 * Rendering of the mesh's plain-string projection notes.
 *
 * The mesh session, transcript and task records carry `notes` as strings rather than
 * field-tagged records, so a native projection states which canonical field a gap
 * belongs to by prefixing the reason with it.
 * @module @deepseek-ai/dsh-agent-codex/notes
 */

/**
 * Render one projection note.
 * @param field - Canonical field the gap belongs to, or `*` for a record-wide gap.
 * @param reason - What could not be carried, addressed to the reader.
 * @returns the note as the mesh records it.
 */
export function note(field: string, reason: string): string {
  return field === '*' ? reason : `${field}: ${reason}`
}
