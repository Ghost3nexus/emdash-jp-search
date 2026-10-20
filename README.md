# jp-search — Japanese site search for EmDash

Site search that actually works on a Japanese EmDash site. It keeps its own
bigram index in plugin storage instead of relying on SQLite FTS5.

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

```sh
pnpm add @tomorrowproof/emdash-jp-search
```

Then enable it in the admin and approve its access: `content:read` and
`schema:read`. It never writes content, sends mail, or makes network requests.

## Routes

| Route      | Access           | Purpose                                  |
| ---------- | ---------------- | ---------------------------------------- |
| `search`   | public, `GET`    | `?q=…&limit=…&locale=…&collection=…`     |
| `status`   | `plugins:manage` | document and token counts, last rebuild  |
| `reindex`  | `plugins:manage`, `POST` | rebuild the whole index          |

All three are mounted under `/_emdash/api/plugins/jp-search/`. Plugin routes
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
- **No admin screen yet.** Operate it through the `status` and `reindex` routes.

## Development

```sh
pnpm install
pnpm run validate     # manifest against the v1 schema
pnpm run typecheck
pnpm run test         # validate + vitest
pnpm run build
```

Before publishing, replace the placeholder `publisher` DID in
`emdash-plugin.jsonc` and the placeholder `security.email` with real values.

## License

MIT
