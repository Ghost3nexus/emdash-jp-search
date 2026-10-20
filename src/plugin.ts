import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { entryText, isSinglePhrase, normalize, snippet, tokenize } from "./text.js";

/**
 * jp-search — Japanese site search for EmDash.
 *
 * It keeps its own bigram inverted index in plugin storage instead of relying on
 * SQLite FTS5, because on a Node + SQLite install FTS5 is unavailable, `blocks`
 * fields cannot be indexed, and the default tokenizer cannot match a substring of
 * a Japanese phrase. See src/text.ts for the tokenizer rationale.
 */

/** Stop a single hot token from pulling an unbounded posting list into memory. */
const MAX_POSTINGS_PER_TOKEN = 2000;
/** Long queries are truncated; the most selective terms come first in practice. */
const MAX_QUERY_TOKENS = 16;
/** A full reindex stops here so activation on a large site cannot run away. */
const MAX_INDEXED_ENTRIES = 5000;
const PAGE = 100;
/** Cron task names accept only letters, numbers, dashes and underscores. */
const CRON_REINDEX = "nightly-reindex";

interface IndexedDoc {
	collection: string;
	entryId: string;
	locale: string;
	slug: string | null;
	title: string;
	url: string | null;
	text: string;
	updatedAt: string;
}

interface Posting {
	token: string;
	docId: string;
}

interface SearchHit {
	collection: string;
	entryId: string;
	locale: string;
	slug: string | null;
	title: string;
	url: string | null;
	snippet: string;
	score: number;
}

const docKey = (collection: string, locale: string | null, entryId: string): string =>
	`${collection}|${locale ?? "-"}|${entryId}`;

const postingKey = (token: string, docId: string): string => `${token}|${docId}`;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Only published, routable entries belong in a public search index. */
function isIndexable(status: string): boolean {
	return status === "published";
}

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:install": async (_event, ctx) => {
			await reindexAll(ctx);
		},

		"plugin:activate": async (_event, ctx) => {
			// Nightly rebuild catches anything the incremental hooks missed —
			// scheduled publications that fired while the plugin was disabled,
			// for instance.
			await ctx.cron?.schedule(CRON_REINDEX, { schedule: "0 3 * * *" });
		},

		cron: async (event, ctx) => {
			if (event.name !== CRON_REINDEX) return;
			await reindexAll(ctx);
		},

		"content:afterSave": async (event, ctx) => {
			await reindexEntry(ctx, event.collection, readId(event.content));
		},

		"content:afterPublish": async (event, ctx) => {
			await reindexEntry(ctx, event.collection, readId(event.content));
		},

		"content:afterUnpublish": async (event, ctx) => {
			await reindexEntry(ctx, event.collection, readId(event.content));
		},

		"content:afterRestore": async (event, ctx) => {
			await reindexEntry(ctx, event.collection, readId(event.content));
		},

		"content:afterDelete": async (event, ctx) => {
			// The entry is gone, so its locale can no longer be read. Drop every
			// locale row that shares this entry id.
			await removeEntry(ctx, event.collection, event.id);
		},
	},

	routes: {
		/**
		 * Public search endpoint for the site's own search box.
		 * GET /_emdash/api/plugins/jp-search/search?q=…&limit=…
		 */
		search: {
			public: true,
			handler: async (routeCtx, ctx) => {
				if (routeCtx.request.method !== "GET") {
					return { ok: false, error: "METHOD_NOT_ALLOWED" };
				}
				const input = asRecord(routeCtx.input);
				const q = firstString(input.q);
				const limit = clampInt(firstString(input.limit), 10, 1, 50);
				const locale = firstString(input.locale);
				const collection = firstString(input.collection);

				if (!q || normalize(q).length === 0) {
					return { ok: true, query: q ?? "", total: 0, items: [] };
				}

				const hits = await runSearch(ctx, q, { locale, collection });
				return {
					ok: true,
					query: q,
					total: hits.length,
					items: hits.slice(0, limit),
				};
			},
		},

		/** Index health, for an operator or an agent checking the site is searchable. */
		status: {
			permission: "plugins:manage",
			handler: async (_routeCtx, ctx) => {
				const docs = await ctx.storage.docs.count();
				const postings = await ctx.storage.postings.count();
				const lastRun = await ctx.kv.get<string>("state:lastReindexAt");
				const truncated = await ctx.kv.get<boolean>("state:lastReindexTruncated");
				return {
					ok: true,
					documents: docs,
					tokens: postings,
					lastReindexAt: lastRun ?? null,
					lastReindexTruncated: truncated ?? false,
				};
			},
		},

		/** Rebuild the whole index. Safe to call repeatedly. */
		reindex: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				if (routeCtx.request.method !== "POST") {
					return { ok: false, error: "METHOD_NOT_ALLOWED" };
				}
				const result = await reindexAll(ctx);
				return { ok: true, ...result };
			},
		},
	},
};

export default plugin;

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

type Ctx = PluginContext;

async function reindexAll(ctx: Ctx): Promise<{ indexed: number; truncated: boolean }> {
	const collections = (await ctx.schema?.listCollections()) ?? [];
	let indexed = 0;
	let truncated = false;

	for (const collection of collections) {
		let cursor: string | undefined;
		do {
			const page = await ctx.content?.list(collection.slug, {
				where: { status: "published" },
				limit: PAGE,
				cursor,
			});
			if (!page) break;

			for (const item of page.items) {
				if (indexed >= MAX_INDEXED_ENTRIES) {
					truncated = true;
					break;
				}
				await writeDoc(ctx, collection.slug, item);
				indexed += 1;
			}

			cursor = page.hasMore && !truncated ? page.cursor : undefined;
		} while (cursor);

		if (truncated) break;
	}

	await ctx.kv.set("state:lastReindexAt", new Date().toISOString());
	await ctx.kv.set("state:lastReindexTruncated", truncated);
	ctx.log.info("jp-search reindex finished", { indexed, truncated });
	return { indexed, truncated };
}

async function reindexEntry(ctx: Ctx, collection: string, entryId: string | null): Promise<void> {
	if (!entryId) return;
	const item = await ctx.content?.get(collection, entryId);
	if (!item || !isIndexable(item.status)) {
		await removeEntry(ctx, collection, entryId);
		return;
	}
	await writeDoc(ctx, collection, item);
}

/** Index one entry, replacing whatever was stored for it before. */
async function writeDoc(
	ctx: Ctx,
	collection: string,
	item: { id: string; slug: string | null; status: string; locale: string | null; data: Record<string, unknown>; updatedAt: string },
): Promise<void> {
	const id = docKey(collection, item.locale, item.id);
	await dropPostings(ctx, id);

	if (!isIndexable(item.status)) {
		await ctx.storage.docs.delete(id);
		return;
	}

	const found = readTitle(item.data);
	const title = found?.value ?? item.slug ?? "";
	const text = entryText(title, item.data, found?.key);
	const url = (await ctx.content?.getPublicUrl?.(collection, item.id)) ?? null;

	const doc: IndexedDoc = {
		collection,
		entryId: item.id,
		locale: item.locale ?? "-",
		slug: item.slug,
		title,
		url,
		text,
		updatedAt: item.updatedAt,
	};
	await ctx.storage.docs.put(id, doc);

	const postings: Array<{ id: string; data: Posting }> = tokenize(text).map((token) => ({
		id: postingKey(token, id),
		data: { token, docId: id },
	}));
	for (const batch of chunk(postings, PAGE)) {
		await ctx.storage.postings.putMany(batch);
	}
}

/** Remove every locale row for an entry id, plus its postings. */
async function removeEntry(ctx: Ctx, collection: string, entryId: string): Promise<void> {
	const prefix = `${collection}|`;
	let cursor: string | undefined;
	const ids: string[] = [];

	do {
		const page = await ctx.storage.docs.query({
			where: { collection },
			limit: PAGE,
			cursor,
		});
		for (const row of page.items) {
			if (row.id.startsWith(prefix) && row.id.endsWith(`|${entryId}`)) ids.push(row.id);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	for (const id of ids) {
		await dropPostings(ctx, id);
		await ctx.storage.docs.delete(id);
	}
}

async function dropPostings(ctx: Ctx, docId: string): Promise<void> {
	// Each page is deleted before the next is read, so no cursor is carried
	// across a mutation.
	for (;;) {
		const page = await ctx.storage.postings.query({ where: { docId }, limit: PAGE });
		if (page.items.length === 0) return;
		await ctx.storage.postings.deleteMany(page.items.map((row) => row.id));
		if (!page.hasMore) return;
	}
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

async function runSearch(
	ctx: Ctx,
	query: string,
	filter: { locale?: string; collection?: string },
): Promise<SearchHit[]> {
	const tokens = tokenize(query).slice(0, MAX_QUERY_TOKENS);
	if (tokens.length === 0) return [];

	let candidates = new Set<string>();
	let first = true;
	for (const token of tokens) {
		const docIds = await postingDocIds(ctx, token);
		if (docIds.size === 0) return [];
		if (first) {
			candidates = docIds;
			first = false;
		} else {
			const narrowed = new Set<string>();
			for (const id of candidates) if (docIds.has(id)) narrowed.add(id);
			candidates = narrowed;
		}
		if (candidates.size === 0) return [];
	}
	if (candidates.size === 0) return [];

	const docs = new Map<string, IndexedDoc>();
	for (const batch of chunk([...candidates], PAGE)) {
		const found = await ctx.storage.docs.getMany(batch);
		for (const [id, data] of found) docs.set(id, data as IndexedDoc);
	}

	const phrase = isSinglePhrase(query) ? normalize(query) : null;
	const hits: SearchHit[] = [];

	for (const doc of docs.values()) {
		if (filter.locale && doc.locale !== filter.locale) continue;
		if (filter.collection && doc.collection !== filter.collection) continue;

		const haystack = normalize(doc.text);
		const titleText = normalize(doc.title);

		// A contiguous query must actually appear; bigram intersection alone can
		// match text that merely contains all the pairs in a different order.
		if (phrase && !haystack.includes(phrase)) continue;

		let score = tokens.length;
		if (phrase && titleText.includes(phrase)) score += 10;
		else if (phrase && haystack.includes(phrase)) score += 3;

		hits.push({
			collection: doc.collection,
			entryId: doc.entryId,
			locale: doc.locale,
			slug: doc.slug,
			title: doc.title,
			url: doc.url,
			snippet: snippet(doc.text, query),
			score,
		});
	}

	hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ja"));
	return hits;
}

async function postingDocIds(ctx: Ctx, token: string): Promise<Set<string>> {
	const ids = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await ctx.storage.postings.query({ where: { token }, limit: PAGE, cursor });
		for (const row of page.items) ids.add((row.data as Posting).docId);
		cursor = page.hasMore && ids.size < MAX_POSTINGS_PER_TOKEN ? page.cursor : undefined;
	} while (cursor);
	return ids;
}

// ---------------------------------------------------------------------------
// Small helpers for untyped boundaries
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Repeated query keys arrive as arrays; take the first usable string. */
function firstString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const found = value.find((item) => typeof item === "string");
		return typeof found === "string" ? found : undefined;
	}
	return undefined;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function readId(content: Record<string, unknown>): string | null {
	return typeof content.id === "string" ? content.id : null;
}

/**
 * Collections name their title field themselves, so fall back through the
 * conventional names rather than requiring configuration.
 */
function readTitle(data: Record<string, unknown>): { key: string; value: string } | null {
	for (const key of ["title", "name", "headline", "label"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return { key, value };
	}
	return null;
}
