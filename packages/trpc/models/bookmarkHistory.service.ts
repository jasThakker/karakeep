import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import type {
  ZBookmarkHistoryEntry,
  ZBookmarkHistoryField,
} from "@karakeep/shared/types/bookmarkHistory";
import type { ZUpdateBookmarksRequest } from "@karakeep/shared/types/bookmarks";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { Actor } from "../lib/actor";
import { actorUserId } from "../lib/actor";
import type {
  BookmarkHistoryField,
  BookmarkSnapshot,
  NewBookmarkHistoryEntry,
} from "./bookmarkHistory.repo";
import { BookmarkHistoryRepo } from "./bookmarkHistory.repo";

// Fields that are personal to the bookmark's owner. Bookmark.asZBookmark hides
// them from shared-list collaborators, so their history is hidden too.
const OWNER_ONLY_FIELDS: ReadonlySet<ZBookmarkHistoryField> = new Set(["note"]);

/**
 * Treats null, undefined and the empty string as the same "empty" value, so
 * clearing an already-empty field isn't reported as a change.
 */
function normalize(value: string | null | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * Returns the value `updateBookmark` will write for each tracked field in the
 * request, mirroring its rules: url is trimmed and only written when
 * non-empty, text only when non-empty, other fields whenever they're present.
 */
function incomingValues(
  input: ZUpdateBookmarksRequest,
): Partial<Record<BookmarkHistoryField, string | null>> {
  const values: Partial<Record<BookmarkHistoryField, string | null>> = {};
  if (input.title !== undefined) values.title = input.title;
  if (input.note !== undefined) values.note = input.note;
  if (input.summary !== undefined) values.summary = input.summary;
  if (input.url) values.url = input.url.trim();
  if (input.description !== undefined) values.description = input.description;
  if (input.author !== undefined) values.author = input.author;
  if (input.publisher !== undefined) values.publisher = input.publisher;
  if (input.text) values.text = input.text;
  return values;
}

/**
 * The title the UI shows for a bookmark that has no title of its own,
 * mirroring getBookmarkTitle in @karakeep/shared/utils/bookmarkUtils: a link
 * shows its crawled title or else its url, an asset its file name.
 */
function fallbackTitle(before: BookmarkSnapshot): string | null {
  switch (before.type) {
    case BookmarkTypes.LINK:
      return before.crawledTitle ?? before.values.url;
    case BookmarkTypes.ASSET:
      return before.assetFileName;
    default:
      return null;
  }
}

/**
 * Compares a bookmark's values before an edit with the values the edit
 * writes, and returns one entry per tracked field whose value actually
 * changed. Fields that aren't in the request, or are re-sent unchanged, are
 * left out, so a no-op update yields an empty list.
 */
export function diffBookmarkChanges(
  before: BookmarkSnapshot,
  input: ZUpdateBookmarksRequest,
): NewBookmarkHistoryEntry[] {
  const entries: NewBookmarkHistoryEntry[] = [];
  for (const [field, newValue] of Object.entries(incomingValues(input)) as [
    BookmarkHistoryField,
    string | null,
  ][]) {
    const oldValue = before.values[field];
    if (normalize(oldValue) === normalize(newValue)) {
      continue;
    }
    // The edit dialog pre-fills an untitled bookmark's title with the title
    // the UI falls back to and sends it back on save. Storing it changes
    // nothing the user sees, so it isn't a change worth recording.
    if (
      field === "title" &&
      normalize(oldValue) === null &&
      normalize(newValue) === normalize(fallbackTitle(before))
    ) {
      continue;
    }
    entries.push({
      field,
      oldValue: normalize(oldValue),
      newValue: normalize(newValue),
    });
  }
  return entries;
}

/**
 * Business logic for bookmark change history. Built on the transaction of the
 * edit being recorded, so the history and the edit commit or roll back
 * together.
 */
export class BookmarkHistoryService {
  private repo: BookmarkHistoryRepo;

  constructor(db: DB | KarakeepDBTransaction) {
    this.repo = new BookmarkHistoryRepo(db);
  }

  /**
   * Snapshots the tracked fields of a bookmark. Call it before writing the
   * edit, then pass the result to `recordChanges` afterwards.
   */
  snapshot(bookmarkId: string): BookmarkSnapshot | null {
    return this.repo.getSnapshot(bookmarkId);
  }

  /**
   * Diffs the snapshot against the request and stores one history row per
   * changed field, attributed to the actor. Writes nothing for a no-op edit.
   */
  recordChanges(
    actor: Actor,
    bookmarkId: string,
    before: BookmarkSnapshot,
    input: ZUpdateBookmarksRequest,
  ): void {
    this.repo.insertEntries(
      bookmarkId,
      actorUserId(actor),
      diffBookmarkChanges(before, input),
    );
  }

  /**
   * Returns a bookmark's change history, newest first. The caller must already
   * have view access (ensureBookmarkAccess). Anyone but the owner gets the
   * owner-only fields' entries dropped, so a private edit isn't even revealed.
   */
  getForBookmark(
    actor: Actor,
    bookmark: { id: string; userId: string },
  ): ZBookmarkHistoryEntry[] {
    const history = this.repo.getForBookmark(bookmark.id);
    if (actorUserId(actor) === bookmark.userId) {
      return history;
    }
    return history.filter((entry) => !OWNER_ONLY_FIELDS.has(entry.field));
  }
}
