import { z } from "zod";

// The bookmark fields whose user edits are recorded in the change history.
// The database column (packages/db/schema.ts) uses this same list.
export const BOOKMARK_HISTORY_FIELDS = [
  "title",
  "url",
  "description",
  "author",
  "publisher",
  "note",
  "summary",
  "text",
] as const;

export const zBookmarkHistoryFieldSchema = z.enum(BOOKMARK_HISTORY_FIELDS);
export type ZBookmarkHistoryField = z.infer<typeof zBookmarkHistoryFieldSchema>;

export const zBookmarkHistoryEntrySchema = z.object({
  id: z.string(),
  bookmarkId: z.string(),
  // The user who made the change.
  userId: z.string(),
  field: zBookmarkHistoryFieldSchema,
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  createdAt: z.date(),
});
export type ZBookmarkHistoryEntry = z.infer<typeof zBookmarkHistoryEntrySchema>;

export const zGetBookmarkHistoryResponseSchema = z.object({
  // Newest first.
  history: z.array(zBookmarkHistoryEntrySchema),
});
export type ZGetBookmarkHistoryResponse = z.infer<
  typeof zGetBookmarkHistoryResponseSchema
>;
