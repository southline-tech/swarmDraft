# Git backbone

A `.draft` file is a zip of `manifest.json` plus a bare git repository. The open book also keeps a working git checkout under the app data directory. SQLite and Yjs stay the live editing layer. Git is the durable, portable history. A git failure is logged and does not roll back text the writer has already typed.

The `.draft` format version is unchanged. New paths below are files inside the git tree.

## Worktree layout

| Path                        | Contents                                                             |
| --------------------------- | -------------------------------------------------------------------- |
| `book.json`                 | Title, numbering, outline, bot access                                |
| `chapters/<sectionId>.md`   | Chapter text for reading                                             |
| `yjs/<sectionId>.bin`       | Yjs state for that section                                           |
| `notes/<noteId>.md`         | Story notes                                                          |
| `comments/<threadId>.json`  | One comment thread, open or resolved. Rows are sorted by `createdAt` |
| `review/changes.json`       | Every tracked change, sorted by id                                   |
| `sessions/<sessionId>.json` | One human editing session                                            |

`review/changes.json` is a JSON array. Each object has `id`, `kind` (`suggestion_insert`, `suggestion_delete`, or `format_change`), `sectionId`, `authorKind`, `authorId`, `authorName`, `status` (`open`, `accepted`, or `rejected`), and `quote` (at most 200 characters). The bytes stay the same when nothing in the book changed, so a second save does not add an empty commit.

A comment file has `threadId` and `rows`. Each row has `id`, `sectionId`, `blockId`, `quote`, `body`, `threadId`, `authorKind`, `authorId`, `authorName`, `createdAt`, and `resolvedAt`. Opening a `.draft` copies missing rows into the local comment list by `id`. Rows already stored are left as they are, and local rows are not deleted. A `.draft` packed before these paths existed still opens; the next save adds the files.

A session file has `id`, `authorName`, `startedAt`, `baseCommit`, and `endedAt` (`null` until the book is closed).

## Refs

| Ref                   | When it moves                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                | Every human checkpoint, Save, accept/reject, and Restore. HEAD stays here                                                                                            |
| `session/<sessionId>` | Created at the current `main` tip when the book is opened. Each commit on `main` during that session moves it to the new tip. The ref is kept after the session ends |
| `bot/<bot>/<session>` | Bot suggestions. Accept merges that branch into `main`                                                                                                               |

Session ids are new each time a book is opened. Bot branch names are unchanged.

## Commit messages

The first line is the title History shows (`Edited …`, `Saved`, `Accepted <bot>'s change in <chapter>`, `Restored version from …`). Trailers sit after a blank line and are not part of that title.

Human commits include:

```
Session: <sessionId>
```

Accept and reject add:

```
Change-Id: <suggestionId>
Decision: accepted|rejected
Section: <sectionId>
Session: <sessionId>
```

One accept or reject is one commit. The deciding commit is the one whose `Change-Id` trailer matches.

## When Yjs is written into git

Live typing updates the Yjs document and SQLite on the existing save timer. It does not wait for git. Git is updated only at these points:

1. Idle checkpoint, about 5 seconds after a successful save (`draft_checkpoint`).
2. Save and Save As.
3. Each accept or reject.
4. Close, which finishes the editing session (`endedAt`) after the last flush.
5. Restore, which adds a new commit and reloads the book from that tree.

A comment reply or resolve asks for the same idle checkpoint, so the thread file is included in the next git update. The comment list on screen still reads from SQLite.

## Finding a change

`draft_resolve_change` walks history for one change id. The introducing commit is the oldest commit, searching `main` first and then `bot/*` and `session/*`, whose `review/changes.json` contains that id. The deciding commit is the one with a matching `Change-Id` trailer. An unknown id is a not-found result. A `changes.json` that cannot be read is skipped. Lookups are cached for the current HEAD commit.
