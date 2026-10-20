import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost | undefined;

/** The page shape the EmDash marketing template produces: prose inside `blocks`. */
const RECRUIT_BLOCKS = [
	{
		_type: "marketing_hero",
		_version: 1,
		_key: "hero1",
		headline: "設備工事の協力会社を募集しています",
		subheadline: "空調・給排水・電気の各工種で、継続的にお願いできる協力会社を探しています。",
		primary_cta_url: "/contact",
		anchor_id: "top",
	},
	{
		_type: "marketing_features",
		_version: 1,
		_key: "feat1",
		headline: "お願いしたい工種",
		features: [
			{
				icon: "thermometer",
				title: "空調設備工事",
				description: "業務用パッケージエアコンの入替・新設。",
			},
			{ icon: "plug", title: "電気設備工事", description: "動力・分電盤の改修、照明のLED化。" },
		],
	},
];

interface SearchResponse {
	ok: boolean;
	query: string;
	total: number;
	items: Array<{ title: string; slug: string | null; url: string | null; snippet: string }>;
}

interface StatusResponse {
	ok: boolean;
	documents: number;
	tokens: number;
	lastReindexAt: string | null;
}

const search = async (q: string, extra: Record<string, string> = {}): Promise<SearchResponse> =>
	(await host!.transport.invokeRoute(
		"search",
		{ q, ...extra },
		{ method: "GET", url: "https://example.test/_emdash/api/plugins/jp-search/search" },
	)) as SearchResponse;

const reindex = async (): Promise<void> => {
	await host!.transport.invokeRoute("reindex", undefined, { method: "POST" });
};

const status = async (): Promise<StatusResponse> =>
	(await host!.transport.invokeRoute("status")) as StatusResponse;

/** Seed one published page. Fixtures bypass hooks, so the test reindexes explicitly. */
const publishPage = async (
	slug: string,
	title: string,
	content: unknown[] = [],
): Promise<string> => {
	const item = await host!.fixtures.content("pages", {
		slug,
		status: "published",
		data: { title, content },
	});
	return item.id;
};

beforeEach(async () => {
	host = await createPluginRuntimeTestHost({ site: { url: "https://example.test" } });
	await host.fixtures.collection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		urlPattern: "/{slug}",
		supports: ["drafts", "revisions", "seo"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "content", label: "Content", type: "blocks" },
		],
	});
	// Hooks only reach an activated plugin, so activate before each test to
	// exercise the real pipeline rather than poking handlers directly.
	await host.actions.plugin.activate();
});

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("jp-search", () => {
	it("finds a Japanese page by a substring of its heading", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();

		// "協力会社" is a substring of "協力会社募集". SQLite FTS5 with the default
		// `porter unicode61` tokenizer cannot match this; the bigram index can.
		const result = await search("協力会社");
		expect(result.ok).toBe(true);
		expect(result.total).toBe(1);
		expect(result.items[0]?.title).toBe("協力会社募集");
	});

	it("searches prose that lives inside a blocks field", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();

		// EmDash core refuses to index a `blocks` field at all
		// ("Blocks fields cannot be searchable"), so none of this text is
		// reachable through built-in search.
		for (const query of ["パッケージエアコン", "分電盤", "給排水"]) {
			expect((await search(query)).total, query).toBe(1);
		}
	});

	it("returns the entry's public URL and a snippet around the match", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();

		const hit = (await search("分電盤")).items[0];
		expect(hit?.snippet).toContain("分電盤");
		expect(hit?.url).toContain("/kyoryoku-gaisha");
	});

	it("rejects a bigram collision that is not a real substring", async () => {
		await publishPage("a", "京都");
		await publishPage("b", "東京");
		await reindex();

		// 東京 and 京都 together contain every bigram of 東京都, but neither page
		// contains that phrase.
		expect((await search("東京")).total).toBe(1);
		expect((await search("東京都")).total).toBe(0);
	});

	it("indexes only published entries", async () => {
		await host!.fixtures.content("pages", {
			slug: "draft-page",
			status: "draft",
			data: { title: "下書きの協力会社", content: [] },
		});
		await reindex();

		expect((await status()).documents).toBe(0);
		expect((await search("協力会社")).total).toBe(0);
	});

	it("drops an entry from the index when it is unpublished", async () => {
		const entryId = await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();
		expect((await search("協力会社")).total).toBe(1);

		// Unpublish for real, then hand the handler the event the host would send.
		// (The test host does not dispatch content hooks to a sandboxed plugin, so
		// the dispatch itself cannot be asserted here — see README.)
		await host!.actions.content.unpublish("pages", entryId);
		const entry = await host!.inspect.content.get("pages", entryId);
		expect(entry?.status).toBe("draft");

		await host!.transport.invokeHook("content:afterUnpublish", {
			collection: "pages",
			content: { id: entryId },
		});

		expect((await search("協力会社")).total).toBe(0);
		expect((await status()).documents).toBe(0);
	});

	it("matches full-width and ASCII forms of the same term", async () => {
		await publishPage("led", "ＬＥＤ照明の施工");
		await reindex();

		expect((await search("led")).total).toBe(1);
		expect((await search("ＬＥＤ")).total).toBe(1);
	});

	it("treats a two-word query as AND", async () => {
		await publishPage("a", "空調設備の工事");
		await publishPage("b", "電気設備の点検");
		await reindex();

		expect((await search("設備")).total).toBe(2);
		expect((await search("設備 工事")).total).toBe(1);
	});

	it("returns an empty result for a blank or punctuation-only query", async () => {
		for (const query of ["", "   ", "・、。"]) {
			const result = await search(query);
			expect(result.ok, query).toBe(true);
			expect(result.total, query).toBe(0);
		}
	});

	it("refuses a non-GET call on the public search route", async () => {
		const result = (await host!.transport.invokeRoute(
			"search",
			{ q: "協力会社" },
			{ method: "POST" },
		)) as { ok: boolean; error?: string };
		expect(result.ok).toBe(false);
		expect(result.error).toBe("METHOD_NOT_ALLOWED");
	});

	it("answers an unauthenticated HTTP request on the public route", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();

		const response = await host!.actions.routes.request("search", {
			method: "GET",
			url: "https://example.test/_emdash/api/plugins/jp-search/search?q=%E5%8D%94%E5%8A%9B%E4%BC%9A%E7%A4%BE",
		});
		expect(response.status).toBe(200);
		// Plugin routes answer inside the standard EmDash envelope.
		const body = (await response.json()) as { success: boolean; data: SearchResponse };
		expect(body.success).toBe(true);
		expect(body.data.total).toBe(1);
	});

	it("reports index health", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();

		const health = await status();
		expect(health.documents).toBe(1);
		expect(health.tokens).toBeGreaterThan(10);
		expect(health.lastReindexAt).not.toBeNull();
	});

	it("removes documents and postings when an entry is deleted", async () => {
		const entryId = await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();
		expect((await status()).documents).toBe(1);

		await host!.transport.invokeHook("content:afterDelete", {
			collection: "pages",
			id: entryId,
		});

		const after = await status();
		expect(after.documents).toBe(0);
		expect(after.tokens).toBe(0);
	});

	it("leaves no orphan postings when an entry is reindexed twice", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集", RECRUIT_BLOCKS);
		await reindex();
		const first = await status();

		await reindex();
		const second = await status();

		expect(second.documents).toBe(first.documents);
		expect(second.tokens).toBe(first.tokens);
	});

	it("schedules a nightly rebuild on activation", async () => {
		await host!.actions.plugin.activate();
		const tasks = await host!.inspect.scheduledTasks();
		expect(JSON.stringify(tasks)).toContain("nightly-reindex");
	});
});
