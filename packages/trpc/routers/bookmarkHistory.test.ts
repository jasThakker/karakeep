import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  bookmarkAssets,
  bookmarkHistory,
  bookmarkLinks,
  bookmarks,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import { BookmarkHistoryService } from "../models/bookmarkHistory.service";
import type { APICallerType, CustomTestContext } from "../testUtils";
import { defaultBeforeEach } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

/** Creates a link bookmark owned by the given caller and returns its id. */
async function createLink(api: APICallerType, url = "https://example.com") {
  const bookmark = await api.bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url,
  });
  return bookmark.id;
}

/**
 * Fetches a bookmark's history as the given caller and reduces each entry to
 * "field: old -> new", so tests can compare the whole list at once.
 */
async function historyOf(api: APICallerType, bookmarkId: string) {
  const { history } = await api.bookmarks.getBookmarkHistory({ bookmarkId });
  return history.map((e) => `${e.field}: ${e.oldValue} -> ${e.newValue}`);
}

/**
 * Shares a new manual list containing the bookmark with the collaborator in
 * the given role, by inviting them and accepting the invitation.
 */
async function shareWith(
  owner: APICallerType,
  collaborator: APICallerType,
  bookmarkId: string,
  role: "viewer" | "editor",
) {
  const list = await owner.lists.create({
    name: "Shared",
    icon: "📚",
    type: "manual",
  });
  await owner.lists.addToList({ listId: list.id, bookmarkId });
  const { email } = await collaborator.users.whoami();
  const { invitationId } = await owner.lists.addCollaborator({
    listId: list.id,
    email: email!,
    role,
  });
  await collaborator.lists.acceptInvitation({ invitationId });
}

describe("Bookmark change history", () => {
  describe("capture", () => {
    test<CustomTestContext>("records field, old value, new value, time and user", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const me = await api.users.whoami();
      const bookmarkId = await createLink(api);

      const before = Date.now();
      await api.bookmarks.updateBookmark({ bookmarkId, title: "First" });

      const { history } = await api.bookmarks.getBookmarkHistory({
        bookmarkId,
      });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        bookmarkId,
        userId: me.id,
        field: "title",
        oldValue: null,
        newValue: "First",
      });
      expect(history[0].createdAt.getTime()).toBeGreaterThanOrEqual(before);
    });

    test<CustomTestContext>("writes one entry per changed field in a single update", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);

      await api.bookmarks.updateBookmark({
        bookmarkId,
        title: "Title",
        url: "https://example.org",
        description: "Desc",
        author: "Ann",
        publisher: "Pub",
        note: "Note",
        summary: "Sum",
      });

      expect((await historyOf(api, bookmarkId)).sort()).toEqual(
        [
          "author: null -> Ann",
          "description: null -> Desc",
          "note: null -> Note",
          "publisher: null -> Pub",
          "summary: null -> Sum",
          "title: null -> Title",
          "url: https://example.com -> https://example.org",
        ].sort(),
      );
    });

    test<CustomTestContext>("tracks the text of text bookmarks", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const { id: bookmarkId } = await api.bookmarks.createBookmark({
        type: BookmarkTypes.TEXT,
        text: "draft",
      });

      await api.bookmarks.updateBookmark({ bookmarkId, text: "final" });

      expect(await historyOf(api, bookmarkId)).toEqual([
        "text: draft -> final",
      ]);
    });

    test<CustomTestContext>("tracks asset bookmarks, ignoring their file name as title", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0];
      const { id: userId } = await api.users.whoami();
      const [{ id: bookmarkId }] = await db
        .insert(bookmarks)
        .values({ userId, type: BookmarkTypes.ASSET })
        .returning();
      await db.insert(bookmarkAssets).values({
        id: bookmarkId,
        assetId: "history-test-asset",
        assetType: "pdf",
        fileName: "paper.pdf",
      });

      // The file name is what an untitled asset already shows.
      await api.bookmarks.updateBookmark({ bookmarkId, title: "paper.pdf" });
      await api.bookmarks.updateBookmark({
        bookmarkId,
        title: "Paper",
        note: "Read later",
      });

      expect((await historyOf(api, bookmarkId)).sort()).toEqual([
        "note: null -> Read later",
        "title: paper.pdf -> Paper",
      ]);
    });

    test<CustomTestContext>("stores nothing when the update fails", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);

      // Setting text on a link bookmark is rejected, so the whole edit,
      // including the title change in the same request, rolls back.
      await expect(
        api.bookmarks.updateBookmark({ bookmarkId, title: "X", text: "no" }),
      ).rejects.toThrow();

      const bookmark = await api.bookmarks.getBookmark({ bookmarkId });
      expect(bookmark.title).toBeNull();
      expect(await historyOf(api, bookmarkId)).toEqual([]);
    });

    test<CustomTestContext>("rolls the edit back when writing its history fails", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);
      const spy = vi
        .spyOn(BookmarkHistoryService.prototype, "recordChanges")
        .mockImplementation(() => {
          throw new Error("history write failed");
        });

      try {
        await expect(
          api.bookmarks.updateBookmark({ bookmarkId, title: "Lost" }),
        ).rejects.toThrow("history write failed");
      } finally {
        spy.mockRestore();
      }

      // History is written in the edit's own transaction, so the edit can't
      // be saved without it.
      const bookmark = await api.bookmarks.getBookmark({ bookmarkId });
      expect(bookmark.title).toBeNull();
    });

    test<CustomTestContext>("deletes the history together with the bookmark", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);
      await api.bookmarks.updateBookmark({ bookmarkId, title: "First" });

      await api.bookmarks.deleteBookmark({ bookmarkId });

      const rows = db
        .select()
        .from(bookmarkHistory)
        .where(eq(bookmarkHistory.bookmarkId, bookmarkId))
        .all();
      expect(rows).toEqual([]);
    });
  });

  describe("no-op updates", () => {
    test<CustomTestContext>("re-sending the current values records nothing", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);
      await api.bookmarks.updateBookmark({
        bookmarkId,
        title: "Same",
        note: "Same note",
        summary: "Same summary",
        author: "Same author",
      });
      const afterFirstEdit = await historyOf(api, bookmarkId);

      await api.bookmarks.updateBookmark({
        bookmarkId,
        title: "Same",
        note: "Same note",
        summary: "Same summary",
        author: "Same author",
        // Never set, and "" and null both mean empty.
        publisher: "",
        description: null,
        // Only differs by surrounding whitespace, which the update trims.
        url: "  https://example.com  ",
      });

      expect(afterFirstEdit).toHaveLength(4);
      expect(await historyOf(api, bookmarkId)).toEqual(afterFirstEdit);
    });

    test<CustomTestContext>("clearing an already-empty field records nothing", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);

      await api.bookmarks.updateBookmark({
        bookmarkId,
        title: null,
        description: "",
        note: "",
      });

      expect(await historyOf(api, bookmarkId)).toEqual([]);
    });

    test<CustomTestContext>("an empty text, which the update doesn't write, records nothing", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const { id: bookmarkId } = await api.bookmarks.createBookmark({
        type: BookmarkTypes.TEXT,
        text: "keep me",
      });

      await api.bookmarks.updateBookmark({ bookmarkId, text: "" });

      expect(await historyOf(api, bookmarkId)).toEqual([]);
    });

    test<CustomTestContext>("saving a link's displayed fallback title as its title records nothing", async ({
      apiCallers,
      db,
    }) => {
      const api = apiCallers[0];
      const crawled = await createLink(api, "https://example.com/crawled");
      db.update(bookmarkLinks)
        .set({ title: "Crawled title" })
        .where(eq(bookmarkLinks.id, crawled))
        .run();
      const uncrawled = await createLink(api, "https://example.com/pending");

      // What the edit dialog sends back when saved without changes: the title
      // the UI was already showing (crawled title, else the url).
      await api.bookmarks.updateBookmark({
        bookmarkId: crawled,
        title: "Crawled title",
      });
      await api.bookmarks.updateBookmark({
        bookmarkId: uncrawled,
        title: "https://example.com/pending",
      });
      expect(await historyOf(api, crawled)).toEqual([]);
      expect(await historyOf(api, uncrawled)).toEqual([]);

      // A real rename is still recorded.
      await api.bookmarks.updateBookmark({
        bookmarkId: crawled,
        title: "Mine",
      });
      expect(await historyOf(api, crawled)).toEqual([
        "title: Crawled title -> Mine",
      ]);
    });

    test<CustomTestContext>("changing only untracked fields records nothing", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);

      await api.bookmarks.updateBookmark({
        bookmarkId,
        archived: true,
        favourited: true,
      });

      expect(await historyOf(api, bookmarkId)).toEqual([]);
    });
  });

  describe("getBookmarkHistory", () => {
    test<CustomTestContext>("returns entries newest first", async ({
      apiCallers,
    }) => {
      const api = apiCallers[0];
      const bookmarkId = await createLink(api);

      await api.bookmarks.updateBookmark({ bookmarkId, title: "One" });
      await api.bookmarks.updateBookmark({ bookmarkId, title: "Two" });
      await api.bookmarks.updateBookmark({ bookmarkId, title: "Three" });

      expect(await historyOf(api, bookmarkId)).toEqual([
        "title: Two -> Three",
        "title: One -> Two",
        "title: null -> One",
      ]);
    });

    test<CustomTestContext>("hides note changes from shared-list collaborators", async ({
      apiCallers,
    }) => {
      const [owner, collaborator] = apiCallers;
      const bookmarkId = await createLink(owner);
      await owner.bookmarks.updateBookmark({ bookmarkId, title: "Public" });
      await owner.bookmarks.updateBookmark({ bookmarkId, note: "private" });
      await shareWith(owner, collaborator, bookmarkId, "viewer");

      expect(await historyOf(owner, bookmarkId)).toEqual([
        "note: null -> private",
        "title: null -> Public",
      ]);
      expect(await historyOf(collaborator, bookmarkId)).toEqual([
        "title: null -> Public",
      ]);
    });

    test<CustomTestContext>("shows editor collaborators the history without notes, but they can't edit", async ({
      apiCallers,
    }) => {
      const [owner, editor] = apiCallers;
      const bookmarkId = await createLink(owner);
      await owner.bookmarks.updateBookmark({
        bookmarkId,
        title: "Public",
        note: "private",
      });
      await shareWith(owner, editor, bookmarkId, "editor");

      expect(await historyOf(editor, bookmarkId)).toEqual([
        "title: null -> Public",
      ]);
      // Only the owner can edit a bookmark, so a collaborator never adds
      // entries of their own.
      await expect(
        editor.bookmarks.updateBookmark({ bookmarkId, title: "Hijack" }),
      ).rejects.toThrow("User is not allowed to access resource");
      expect(await historyOf(owner, bookmarkId)).toHaveLength(2);
    });

    test<CustomTestContext>("is not found for users without access", async ({
      apiCallers,
    }) => {
      const [owner, , stranger] = apiCallers;
      const bookmarkId = await createLink(owner);
      await owner.bookmarks.updateBookmark({ bookmarkId, title: "Mine" });

      await expect(
        stranger.bookmarks.getBookmarkHistory({ bookmarkId }),
      ).rejects.toThrow("Bookmark not found");
    });
  });
});
