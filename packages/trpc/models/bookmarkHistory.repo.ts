import { desc, eq, sql } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import {
  bookmarkAssets,
  bookmarkHistory,
  bookmarkLinks,
  bookmarks,
  bookmarkTexts,
} from "@karakeep/db/schema";
import type { ZBookmarkHistoryEntry } from "@karakeep/shared/types/bookmarkHistory";

export type BookmarkHistoryField =
  (typeof bookmarkHistory.$inferInsert)["field"];

/** The current value of every field the history tracks, read before an edit. */
export type TrackedBookmarkValues = Record<BookmarkHistoryField, string | null>;

/**
 * A bookmark as it was before an edit: the tracked values, plus the crawled
 * title and asset file name the UI shows when the bookmark has no title.
 */
export interface BookmarkSnapshot {
  type: (typeof bookmarks.$inferSelect)["type"];
  values: TrackedBookmarkValues;
  crawledTitle: string | null;
  assetFileName: string | null;
}

export interface NewBookmarkHistoryEntry {
  field: BookmarkHistoryField;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Data access for bookmark change history. Takes either the database or an
 * open transaction, so history rows can be written in the same transaction as
 * the bookmark edit they describe.
 */
export class BookmarkHistoryRepo {
  constructor(private db: DB | KarakeepDBTransaction) {}

  /**
   * Reads the tracked fields of a bookmark in one query, left-joining the
   * link, text and asset tables so it works for every bookmark type, plus what
   * the UI falls back to as the title. Returns null if the bookmark is gone.
   */
  getSnapshot(bookmarkId: string): BookmarkSnapshot | null {
    const row = this.db
      .select({
        type: bookmarks.type,
        title: bookmarks.title,
        note: bookmarks.note,
        summary: bookmarks.summary,
        url: bookmarkLinks.url,
        description: bookmarkLinks.description,
        author: bookmarkLinks.author,
        publisher: bookmarkLinks.publisher,
        text: bookmarkTexts.text,
        crawledTitle: bookmarkLinks.title,
        assetFileName: bookmarkAssets.fileName,
      })
      .from(bookmarks)
      .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
      .leftJoin(bookmarkTexts, eq(bookmarkTexts.id, bookmarks.id))
      .leftJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id))
      .where(eq(bookmarks.id, bookmarkId))
      .get();
    if (!row) {
      return null;
    }
    const { type, crawledTitle, assetFileName, ...values } = row;
    return { type, crawledTitle, assetFileName, values };
  }

  /**
   * Inserts one history row per entry, all stamped with the same bookmark,
   * user and time. Does nothing for an empty list.
   */
  insertEntries(
    bookmarkId: string,
    userId: string,
    entries: NewBookmarkHistoryEntry[],
  ): void {
    if (entries.length === 0) {
      return;
    }
    const createdAt = new Date();
    this.db
      .insert(bookmarkHistory)
      .values(
        entries.map((entry) => ({
          bookmarkId,
          userId,
          field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          createdAt,
        })),
      )
      .run();
  }

  /**
   * Returns every history row of a bookmark, newest first. Rows written by
   * the same edit share a timestamp, so ties fall back to insertion order
   * (SQLite rowid), newest last-inserted first.
   */
  getForBookmark(bookmarkId: string): ZBookmarkHistoryEntry[] {
    return this.db
      .select()
      .from(bookmarkHistory)
      .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
      .orderBy(desc(bookmarkHistory.createdAt), desc(sql`rowid`))
      .all();
  }
}
