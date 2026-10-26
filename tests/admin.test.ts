import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

/**
 * The admin screen goes through the host's real Block Kit dispatch, which
 * validates the response before the test sees it — so an invalid block fails
 * these tests rather than reaching an operator's browser.
 */

let host: PluginRuntimeTestHost | undefined;

const PAGE = "/jp-search";

interface Rendered {
	blocks: Array<Record<string, unknown>>;
	toast?: { message: string; type: string };
}

const blockOfType = (res: Rendered, type: string): Record<string, unknown> | undefined =>
	res.blocks.find((block) => block.type === type);

const types = (res: Rendered): string[] => res.blocks.map((block) => String(block.type));

/** Every string anywhere in the response, for asserting on wording. */
const text = (res: Rendered): string => JSON.stringify(res);

const loadPage = async (locale?: string): Promise<Rendered> =>
	(await host!.admin.loadPage(PAGE, locale ? { locale } : undefined)) as unknown as Rendered;

const act = async (actionId: string): Promise<Rendered> =>
	(await host!.admin.act(PAGE, actionId)) as unknown as Rendered;

const submit = async (values: Record<string, unknown>): Promise<Rendered> =>
	(await host!.admin.submit(PAGE, "run-search", values)) as unknown as Rendered;

const publishPage = async (slug: string, title: string): Promise<string> => {
	const item = await host!.fixtures.content("pages", {
		slug,
		status: "published",
		data: { title, content: [] },
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
	await host.actions.plugin.activate();
});

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("jp-search admin screen", () => {
	it("renders index health, a rebuild button and a search box", async () => {
		const page = await loadPage();

		expect(types(page)).toEqual(
			expect.arrayContaining(["header", "stats", "actions", "form", "context"]),
		);
		const stats = blockOfType(page, "stats") as { items: Array<{ value: unknown }> };
		expect(stats.items).toHaveLength(3);
	});

	it("says so when the index is empty, and stops saying it once it is built", async () => {
		const empty = await loadPage("ja");
		const banner = blockOfType(empty, "banner") as { title: string } | undefined;
		expect(banner?.title).toBe("索引が空です");

		await publishPage("kyoryoku-gaisha", "協力会社募集");
		await act("reindex");

		const built = await loadPage("ja");
		expect(blockOfType(built, "banner")).toBeUndefined();
		const stats = blockOfType(built, "stats") as { items: Array<{ value: unknown }> };
		expect(stats.items[0]?.value).toBe(1);
	});

	it("rebuilds the index from the button and reports how many entries it read", async () => {
		await publishPage("a", "協力会社募集");
		await publishPage("b", "空調設備の工事");

		const after = await act("reindex");
		expect(after.toast?.type).toBe("success");
		expect(after.toast?.message).toContain("2");

		const stats = blockOfType(after, "stats") as { items: Array<{ value: unknown }> };
		expect(stats.items[0]?.value).toBe(2);
	});

	it("searches the same index the public route serves and links to the entry", async () => {
		const entryId = await publishPage("kyoryoku-gaisha", "協力会社募集");
		await act("reindex");

		// A substring of a Japanese heading — the case built-in FTS5 search misses.
		const result = await submit({ q: "協力会社" });
		const table = blockOfType(result, "table") as {
			rows: Array<{ entry: { type: string; label: string; target: Record<string, unknown> } }>;
		};
		expect(table.rows).toHaveLength(1);
		expect(table.rows[0]?.entry.label).toBe("協力会社募集");
		expect(table.rows[0]?.entry.target).toMatchObject({
			kind: "content",
			collection: "pages",
			id: entryId,
		});
	});

	it("shows an empty state when nothing in the index matches", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集");
		await act("reindex");

		const result = await submit({ q: "存在しない語" });
		expect(blockOfType(result, "table")).toBeUndefined();
		expect(blockOfType(result, "empty")).toMatchObject({ title: "Nothing matched" });
	});

	it("asks for a query instead of searching for nothing", async () => {
		const result = await submit({ q: "   " });
		expect(result.toast).toMatchObject({ type: "info" });
		expect(blockOfType(result, "table")).toBeUndefined();
		expect(blockOfType(result, "empty")).toBeUndefined();
	});

	it("keeps the submitted query in the box next to its results", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集");
		await act("reindex");

		const result = await submit({ q: "協力会社" });
		const form = blockOfType(result, "form") as {
			fields: Array<{ initial_value?: string }>;
		};
		expect(form.fields[0]?.initial_value).toBe("協力会社");
	});

	it("answers in Japanese for a Japanese admin and English otherwise", async () => {
		expect(text(await loadPage("ja"))).toContain("日本語サイト内検索");
		expect(text(await loadPage("en"))).toContain("Japanese site search");
		// No attested locale at all still renders, rather than failing closed.
		expect(text(await loadPage())).toContain("Japanese site search");
	});

	it("renders the dashboard widget as a compact pair of numbers", async () => {
		await publishPage("kyoryoku-gaisha", "協力会社募集");
		await act("reindex");

		const widget = (await host!.admin.loadWidget("index-health")) as unknown as Rendered;
		expect(types(widget)).toEqual(["stats"]);
		const stats = blockOfType(widget, "stats") as { items: Array<{ value: unknown }> };
		expect(stats.items).toHaveLength(2);
		expect(stats.items[0]?.value).toBe(1);
	});
});
