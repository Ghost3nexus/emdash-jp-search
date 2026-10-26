# jp-search — Japanese site search for EmDash on the Node platform

Site search that works in Japanese on an EmDash site running the **Node
platform**, where EmDash's built-in full-text search cannot run at all. It keeps
its own bigram index in plugin storage instead of relying on SQLite FTS5.

This is a narrow claim on purpose. See [Where this fits](#where-this-fits) for
what it does not cover.

## Why this exists

Three measured problems with built-in search on EmDash 1.3.1, all reproduced on a
fresh `npm create emdash@latest --template marketing --platform node` install:

1. **FTS5 is missing on the Node platform.** `enableSearch()` fails with
   `Error: no such module: fts5`, because the SQLite build inside Node's own
   `node:sqlite` has no FTS5 module. The failure is a warning: `emdash seed`
   still prints `✔ Seed applied successfully!`, and `emdash search` then returns
   `[]` for every query — in any language. Nothing tells you the site is not
   searchable.
2. **`blocks` fields cannot be indexed.** Seeding a collection whose body is a
   `blocks` field with `"searchable": true` stops with `Blocks fields cannot be
   searchable`. The marketing template keeps all page prose in `blocks`, so only
   the page title is indexable there.
3. **The default tokenizer cannot match Japanese.** FTS5 is created with
   `porter unicode61`, which treats a run of CJK characters as one token, so
   `協力会社` does not match a page titled `協力会社募集`. `trigram` is in the allowed
   tokenizer list, but `emdash seed` always calls `enableSearch()` with no
   options and the CLI has no flag for it — the only way to set it is
   `POST /_emdash/api/search/enable`.

This plugin sidesteps all three: it reads published content through the plugin
content API, extracts plain text from `blocks` and Portable Text, and stores a
character-bigram inverted index in its own storage collections.

## Where this fits

EmDash has other search paths. This plugin is for the one they do not reach.

| Path | Runs on | Japanese |
| --- | --- | --- |
| Built-in FTS5 search (`emdash search`, `search()`) | Platforms whose SQLite ships FTS5 — **not** Node's bundled `node:sqlite` | Needs `tokenize: "trigram"`, settable only via `POST /_emdash/api/search/enable` |
| First-party `@emdash-cms/plugin-ai-search` (Cloudflare AI Search) | **Cloudflare Workers only** — requires an `ai_search_namespaces` binding | Out of scope here |
| **jp-search** | **Node platform** (`@astrojs/node` + `node:sqlite`) | Character bigrams, no FTS5 needed |

So the accurate claim is: *on the Node platform, this is how you get Japanese site
search to work at all* — not that it is the best way to search any Japanese EmDash
site. A site already on Cloudflare Workers, with the budget for an AI Search
instance, should look at the first-party plugin first.

Measured against upstream `main` on 2026-10-25, both of the gaps this plugin
depends on are still open:

- `@emdash-cms/plugin-ai-search` is documented (`docs/plugins/ai-search.mdx`) and
  staged in a changeset, but **not yet published to npm** (registry returns 404).
- `DEFAULT_SEARCH_TOKENIZER` in `packages/core/src/search/fts-manager.ts` is still
  `porter unicode61`. The allow-list is unchanged (`porter unicode61`,
  `unicode61`, `trigram`) and no CJK tokenizer has been added.

Re-check both before quoting this plugin as the only option.

## What it does

- Indexes every **published** entry of every collection. Drafts, scheduled and
  trashed entries stay out of the index.
- Extracts prose from plain string fields, Portable Text, and `blocks` fields,
  including repeater items and image `alt` text. Skips URLs, ids, slugs, icon
  names, MIME types and storage keys.
- Tokenizes CJK runs into overlapping bigrams and keeps Latin/digit runs whole,
  so any substring of two or more characters is findable.
- Normalizes with NFKC, so `ＬＥＤ` and `led` match each other.
- Confirms contiguous queries with a substring check, so bigram collisions do not
  leak: with `京都` and `東京` indexed, `東京都` returns nothing.
- Treats a multi-word query as AND.

## Install

Published to the EmDash plugin registry as
[`@kooochan88.bsky.social/jp-search`](https://plugins.emdashcms.com/plugins/@kooochan88.bsky.social/jp-search).
Open **Registry** in your EmDash admin and search for that name.

Then approve its access: `content:read` and `schema:read`. It never writes
content, sends mail, or makes network requests.

## Admin screen

**日本語検索** in the admin sidebar, plus an **index-health** dashboard widget.
Both are Block Kit; the plugin ships no browser code.

The screen exists because this index is invisible from everywhere else in EmDash.
Built-in search reports nothing about it, so an index that is empty — or that was
cut off at the rebuild cap — looks exactly like a site with no matching content.
The screen shows:

- **Index health.** Indexed entries, index entries (bigram-and-entry pairs), and
  when the last full rebuild ran.
- **A warning when the index is empty**, and a separate one when the last rebuild
  stopped at the cap. Both are plain statements of what was measured — an empty
  index is normal on a site with no published entries, and the banner says so.
- **Rebuild the index**, behind a confirmation. Same work as `POST reindex`.
- **A search box** that runs the same code path the public route serves — same
  tokenizer, same scoring, same order — minus that route's `locale` and
  `collection` filters.

Wording follows the admin locale the host attests (`routeCtx.ui.locale`):
Japanese for a Japanese admin, English otherwise. The sidebar label is fixed in
the manifest and cannot follow the locale, so it stays Japanese.

## Routes

| Route      | Access           | Purpose                                  |
| ---------- | ---------------- | ---------------------------------------- |
| `search`   | public, `GET`    | `?q=…&limit=…&locale=…&collection=…`     |
| `status`   | `plugins:manage` | document and token counts, last rebuild  |
| `reindex`  | `plugins:manage`, `POST` | rebuild the whole index          |
| `admin`    | `plugins:manage`, `POST` | Block Kit for the screen above   |

All four are mounted under `/_emdash/api/plugins/jp-search/`. Plugin routes
answer inside the standard EmDash envelope, so the search payload is at
`data`:

```sh
curl 'https://example.com/_emdash/api/plugins/jp-search/search?q=協力会社'
```

```json
{
  "success": true,
  "data": {
    "ok": true,
    "query": "協力会社",
    "total": 1,
    "items": [
      {
        "collection": "pages",
        "entryId": "01M5…",
        "locale": "ja",
        "slug": "kyoryoku-gaisha",
        "title": "協力会社募集",
        "url": "https://example.com/kyoryoku-gaisha",
        "snippet": "…協力会社募集 設備工事の協力会社を募集しています…",
        "score": 13
      }
    ]
  }
}
```

The `search` route is public and internet-facing. It only ever returns text from
published entries, and only accepts `GET`.

## Keeping the index current

The index is maintained two ways:

- **Nightly rebuild.** `plugin:activate` schedules a `nightly-reindex` cron task
  at 03:00. This is the path to rely on.
- **Incremental hooks.** `content:afterSave`, `afterPublish`, `afterUnpublish`,
  `afterRestore` and `afterDelete` reindex or drop the affected entry.

A first full index is built on `plugin:install`, and `POST reindex` rebuilds on
demand at any time. Reindexing is idempotent — running it twice leaves the same
document and token counts.

## Limits, stated plainly

- **The hook handlers are tested; the host's dispatch to them is not.** In
  `@emdash-cms/plugin-test` 0.2.10, `actions.content.create/publish/unpublish` do
  not deliver content hooks to an activated sandboxed plugin, so the tests invoke
  the handlers through `transport.invokeHook` with the event the host documents.
  Treat the incremental updates as best effort and the nightly rebuild as the
  guarantee.
- **Sized for small and mid-size sites.** A full rebuild stops at 5,000 entries
  and reports `truncated: true`. A single token's posting list is read up to
  2,000 documents. Plugin storage pages at 100 rows, so a very large site will
  want a different design.
- **Index size.** Roughly one posting row per distinct bigram per entry. A page
  of a few thousand Japanese characters produces on the order of a thousand rows.
- **Bigrams, not morphology.** There is no stemming, no conjugation handling and
  no synonym expansion. A one-character query matches only a one-character CJK
  run.
- **The admin search box is a check, not a console.** It shows the first 20 hits
  with no paging, and no locale or collection filter — those live on the `search`
  route. A rebuild started from the button runs inside that one request, so a
  large site will sit on it; `POST reindex` has the same shape.

## Development

```sh
pnpm install
pnpm run validate     # manifest against the v1 schema
pnpm run typecheck
pnpm run test         # validate + vitest
pnpm run build
```

The `publisher` DID in `emdash-plugin.jsonc` resolves to
`kooochan88.bsky.social`. Publishing goes through `emdash-plugin login` and then
`emdash-plugin publish`, which uploads to that account's own PDS.

## License

MIT
