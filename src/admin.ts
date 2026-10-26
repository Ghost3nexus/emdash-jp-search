/**
 * Block Kit admin screen for jp-search.
 *
 * The plugin's own index is invisible from the rest of EmDash: built-in search
 * reports nothing about it, so an empty or truncated index looks exactly like a
 * site with no matching content. This screen exists to make that difference
 * visible — index size, when it was last rebuilt, a rebuild button, and a search
 * box that queries the same code path the public route uses.
 *
 * `emdash/plugin` does not re-export the Block Kit types and
 * `@emdash-cms/blocks` is not a dependency of a sandboxed plugin, so the shapes
 * the host validates are mirrored below, narrowed to what this screen renders.
 */

// ---------------------------------------------------------------------------
// The slice of Block Kit this screen uses
// ---------------------------------------------------------------------------

interface ConfirmDialog {
	title: string;
	text: string;
	confirm: string;
	deny: string;
	style?: "danger";
}

interface ButtonElement {
	type: "button";
	action_id: string;
	label: string;
	style?: "primary" | "danger" | "secondary";
	confirm?: ConfirmDialog;
}

interface LinkElement {
	type: "link";
	label: string;
	target: { kind: "content"; collection: string; id: string; locale?: string };
}

interface TextInputElement {
	type: "text_input";
	action_id: string;
	label: string;
	placeholder?: string;
	initial_value?: string;
}

type Block =
	| { type: "header"; text: string }
	| { type: "section"; text: string }
	| { type: "context"; text: string }
	| { type: "divider" }
	| { type: "stats"; items: Array<{ label: string; value: string | number; description?: string }> }
	| { type: "banner"; title?: string; description?: string; variant?: "default" | "alert" | "error" }
	| { type: "actions"; elements: ButtonElement[] }
	| {
			type: "form";
			fields: TextInputElement[];
			submit: { label: string; action_id: string };
	  }
	| {
			type: "table";
			columns: Array<{ key: string; label: string; format?: "text" | "number" | "element" }>;
			rows: Array<Record<string, unknown>>;
			page_action_id: string;
			empty_text?: string;
	  }
	| { type: "empty"; title: string; description?: string };

export interface BlockResponse {
	blocks: Block[];
	toast?: { message: string; type: "success" | "error" | "info" };
}

// ---------------------------------------------------------------------------
// What the screen needs from the plugin
// ---------------------------------------------------------------------------

export interface IndexStatus {
	documents: number;
	tokens: number;
	lastReindexAt: string | null;
	lastReindexTruncated: boolean;
}

export interface AdminHit {
	collection: string;
	entryId: string;
	locale: string;
	title: string;
	slug: string | null;
	score: number;
}

export interface AdminDeps {
	readStatus(): Promise<IndexStatus>;
	reindexAll(): Promise<{ indexed: number; truncated: boolean }>;
	search(query: string): Promise<AdminHit[]>;
	/** The cap a full rebuild stops at, quoted back to the operator. */
	maxIndexedEntries: number;
}

/** Declared in emdash-plugin.jsonc; the host sends it back on every interaction. */
export const ADMIN_PAGE = "/jp-search";
/** Dashboard widget id, declared in emdash-plugin.jsonc. */
export const ADMIN_WIDGET = "index-health";

const ACTION_REINDEX = "reindex";
const ACTION_SEARCH = "run-search";
const ACTION_RESULTS_PAGE = "results-page";

/** The test search shows a page of hits, not the whole result set. */
const RESULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

interface Strings {
	title: string;
	documents: string;
	tokens: string;
	tokensHint: string;
	lastRun: string;
	never: string;
	emptyTitle: string;
	emptyBody: string;
	truncatedTitle: string;
	truncatedBody: (cap: number) => string;
	rebuild: string;
	rebuildConfirmTitle: string;
	rebuildConfirmText: string;
	rebuildConfirm: string;
	rebuildDeny: string;
	rebuilt: (indexed: number) => string;
	rebuiltTruncated: (indexed: number, cap: number) => string;
	queryLabel: string;
	queryPlaceholder: string;
	querySubmit: string;
	queryMissing: string;
	results: (query: string, total: number) => string;
	resultsCapped: (shown: number) => string;
	noResultsTitle: string;
	noResultsBody: (query: string) => string;
	colEntry: string;
	colCollection: string;
	colLocale: string;
	colScore: string;
	footnote: string;
}

const JA: Strings = {
	title: "日本語サイト内検索",
	documents: "索引済みの記事",
	tokens: "索引エントリ",
	tokensHint: "2文字ごとの見出し語と記事の組",
	lastRun: "最後の再構築",
	never: "未実行",
	emptyTitle: "索引が空です",
	emptyBody:
		"公開済みの記事がまだ索引に入っていません。下の「索引を作り直す」で作れます。公開済みの記事がまだ無い場合は、空のままで正常です。",
	truncatedTitle: "前回の再構築は上限で打ち切られました",
	truncatedBody: (cap) =>
		`前回の再構築は${cap}件で止まりました。それ以降の記事は検索に出ません。`,
	rebuild: "索引を作り直す",
	rebuildConfirmTitle: "索引を作り直しますか",
	rebuildConfirmText:
		"公開済みの記事を全部読み直します。件数が多いと時間がかかり、終わるまでの検索結果は不完全になることがあります。",
	rebuildConfirm: "作り直す",
	rebuildDeny: "やめる",
	rebuilt: (indexed) => `${indexed}件を索引しました。`,
	rebuiltTruncated: (indexed, cap) =>
		`${indexed}件を索引し、上限${cap}件で打ち切りました。`,
	queryLabel: "検索語",
	queryPlaceholder: "例: 協力会社",
	querySubmit: "この索引で検索",
	queryMissing: "検索語を入れてください。",
	results: (query, total) => `「${query}」の結果 ${total}件`,
	resultsCapped: (shown) => `先頭${shown}件を表示しています。`,
	noResultsTitle: "該当なし",
	noResultsBody: (query) => `「${query}」を含む公開記事は索引にありません。`,
	colEntry: "記事",
	colCollection: "コレクション",
	colLocale: "言語",
	colScore: "スコア",
	footnote:
		"索引は毎晩3時に作り直され、記事の保存・公開・削除のたびに個別に更新されます。サイト側から使う公開エンドポイントは GET /_emdash/api/plugins/jp-search/search?q=… です。",
};

const EN: Strings = {
	title: "Japanese site search",
	documents: "Indexed entries",
	tokens: "Index entries",
	tokensHint: "One per bigram-and-entry pair",
	lastRun: "Last rebuild",
	never: "Never run",
	emptyTitle: "The index is empty",
	emptyBody:
		"No published entry is in the index yet. Use “Rebuild the index” below to build it. If the site has no published entries yet, an empty index is expected.",
	truncatedTitle: "The last rebuild stopped at the cap",
	truncatedBody: (cap) =>
		`The last rebuild stopped at ${cap} entries. Anything past that cap is not searchable.`,
	rebuild: "Rebuild the index",
	rebuildConfirmTitle: "Rebuild the index?",
	rebuildConfirmText:
		"Every published entry is read again. On a large site this takes a while, and results can be incomplete until it finishes.",
	rebuildConfirm: "Rebuild",
	rebuildDeny: "Cancel",
	rebuilt: (indexed) => `Indexed ${indexed} entries.`,
	rebuiltTruncated: (indexed, cap) =>
		`Indexed ${indexed} entries and stopped at the cap of ${cap}.`,
	queryLabel: "Query",
	queryPlaceholder: "A word or phrase",
	querySubmit: "Search this index",
	queryMissing: "Enter a query.",
	results: (query, total) => `${total} result(s) for “${query}”`,
	resultsCapped: (shown) => `Showing the first ${shown}.`,
	noResultsTitle: "Nothing matched",
	noResultsBody: (query) => `No published entry in the index contains “${query}”.`,
	colEntry: "Entry",
	colCollection: "Collection",
	colLocale: "Locale",
	colScore: "Score",
	footnote:
		"The index is rebuilt nightly at 03:00 and updated per entry as entries are saved, published or deleted. The public endpoint is GET /_emdash/api/plugins/jp-search/search?q=…",
};

const stringsFor = (locale: string | undefined): Strings =>
	locale?.toLowerCase().startsWith("ja") ? JA : EN;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render one Block Kit interaction.
 *
 * The host sends `page_load` when the screen opens, `block_action` for a button
 * and `form_submit` for the search box, and replaces the whole screen with
 * whatever comes back — so every branch re-renders the overview.
 */
export async function renderAdmin(
	interaction: unknown,
	deps: AdminDeps,
	locale?: string,
): Promise<BlockResponse> {
	const s = stringsFor(locale);
	const event = asRecord(interaction);
	const type = typeof event.type === "string" ? event.type : "";
	const actionId = typeof event.action_id === "string" ? event.action_id : "";
	const page = typeof event.page === "string" ? event.page : ADMIN_PAGE;

	if (page === `widget:${ADMIN_WIDGET}`) {
		return { blocks: widgetBlocks(await deps.readStatus(), s) };
	}

	if (type === "block_action" && actionId === ACTION_REINDEX) {
		const { indexed, truncated } = await deps.reindexAll();
		return {
			blocks: overviewBlocks(await deps.readStatus(), s, deps.maxIndexedEntries),
			toast: {
				message: truncated
					? s.rebuiltTruncated(indexed, deps.maxIndexedEntries)
					: s.rebuilt(indexed),
				type: truncated ? "info" : "success",
			},
		};
	}

	if (type === "form_submit" && actionId === ACTION_SEARCH) {
		const query = readQuery(event.values);
		const status = await deps.readStatus();
		if (!query) {
			return {
				blocks: overviewBlocks(status, s, deps.maxIndexedEntries),
				toast: { message: s.queryMissing, type: "info" },
			};
		}
		const hits = await deps.search(query);
		return {
			blocks: [
				...overviewBlocks(status, s, deps.maxIndexedEntries, query),
				...resultBlocks(query, hits, s),
			],
		};
	}

	// `page_load`, the results table's paging action, and anything unrecognized
	// all land on a freshly measured overview.
	return { blocks: overviewBlocks(await deps.readStatus(), s, deps.maxIndexedEntries) };
}

function overviewBlocks(
	status: IndexStatus,
	s: Strings,
	cap: number,
	query?: string,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: s.title },
		{
			type: "stats",
			items: [
				{ label: s.documents, value: status.documents },
				{ label: s.tokens, value: status.tokens, description: s.tokensHint },
				{
					label: s.lastRun,
					value: status.lastReindexAt ? formatTimestamp(status.lastReindexAt) : s.never,
				},
			],
		},
	];

	if (status.lastReindexTruncated) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: s.truncatedTitle,
			description: s.truncatedBody(cap),
		});
	}

	if (status.documents === 0) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: s.emptyTitle,
			description: s.emptyBody,
		});
	}

	blocks.push(
		{
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: ACTION_REINDEX,
					label: s.rebuild,
					style: "secondary",
					confirm: {
						title: s.rebuildConfirmTitle,
						text: s.rebuildConfirmText,
						confirm: s.rebuildConfirm,
						deny: s.rebuildDeny,
					},
				},
			],
		},
		{ type: "divider" },
		{
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "q",
					label: s.queryLabel,
					placeholder: s.queryPlaceholder,
					// Keep the box filled in after a submit so the query stays readable
					// next to its own results.
					...(query ? { initial_value: query } : {}),
				},
			],
			submit: { label: s.querySubmit, action_id: ACTION_SEARCH },
		},
		{ type: "context", text: s.footnote },
	);

	return blocks;
}

function resultBlocks(query: string, hits: AdminHit[], s: Strings): Block[] {
	if (hits.length === 0) {
		return [
			{ type: "divider" },
			{ type: "empty", title: s.noResultsTitle, description: s.noResultsBody(query) },
		];
	}

	const shown = hits.slice(0, RESULT_LIMIT);
	const blocks: Block[] = [
		{ type: "divider" },
		{ type: "section", text: s.results(query, hits.length) },
		{
			type: "table",
			columns: [
				{ key: "entry", label: s.colEntry, format: "element" },
				{ key: "collection", label: s.colCollection, format: "text" },
				{ key: "locale", label: s.colLocale, format: "text" },
				{ key: "score", label: s.colScore, format: "number" },
			],
			rows: shown.map((hit) => ({
				entry: entryLink(hit),
				collection: hit.collection,
				locale: hit.locale,
				score: hit.score,
			})),
			// Required by the table block. No cursor is handed back, so the host has
			// nothing to page to; the handler re-renders the overview if it fires.
			page_action_id: ACTION_RESULTS_PAGE,
		},
	];

	if (hits.length > shown.length) {
		blocks.push({ type: "context", text: s.resultsCapped(shown.length) });
	}
	return blocks;
}

function widgetBlocks(status: IndexStatus, s: Strings): Block[] {
	return [
		{
			type: "stats",
			items: [
				{ label: s.documents, value: status.documents },
				{
					label: s.lastRun,
					value: status.lastReindexAt ? formatTimestamp(status.lastReindexAt) : s.never,
				},
			],
		},
	];
}

/**
 * Link straight to the entry's editor. The index stores `-` where an entry has
 * no locale, which is not a locale the host can resolve.
 */
function entryLink(hit: AdminHit): LinkElement {
	return {
		type: "link",
		label: hit.title || hit.slug || hit.entryId,
		target: {
			kind: "content",
			collection: hit.collection,
			id: hit.entryId,
			...(hit.locale && hit.locale !== "-" ? { locale: hit.locale } : {}),
		},
	};
}

/**
 * `2026-10-26T03:00:12.345Z` → `2026-10-26 03:00 UTC`. Written out by hand
 * rather than through `Intl`, which a sandbox runner is not guaranteed to carry.
 */
function formatTimestamp(iso: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
	return match ? `${match[1]} ${match[2]} UTC` : iso;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readQuery(values: unknown): string | null {
	const q = asRecord(values).q;
	if (typeof q !== "string") return null;
	const trimmed = q.trim();
	return trimmed.length > 0 ? trimmed : null;
}
