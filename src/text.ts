/**
 * Japanese-aware text extraction and N-gram tokenization.
 *
 * Why this exists: EmDash core indexes content with SQLite FTS5, whose default
 * tokenizer (`porter unicode61`) treats a run of CJK characters as one token, so
 * "協力会社" never matches a page titled "協力会社募集". FTS5 also refuses to index
 * `blocks` fields at all, and the bundled `node:sqlite` ships without the fts5
 * module, so on the Node platform there is no index to query in the first place.
 *
 * The approach here is the standard CJK workaround: index character bigrams and
 * intersect their posting lists at query time, then confirm contiguous phrases
 * with a substring check so bigram collisions do not leak into results.
 */

/** Characters that carry meaning but never start a useful token on their own. */
const PUNCTUATION =
	/[\s　!-/:-@[-`{-~、。，．・：；？！゛゜´｀¨＾￣＿ヽヾゝゞ〃仝々〆〇ー—‐／＼〜‖｜…‥'''""（）〔〕［］｛｝〈〉《》「」『』【】＋−±×÷＝≠＜＞]+/gu;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〇]/u;
const ALNUM = /[0-9a-z]/u;

/** Keys whose values are never prose: ids, URLs, icon names, layout flags. */
const SKIP_KEY =
	/^_|^id$|^key$|(_url|_id|_key|url|slug|icon|href|src|provider|mime_?type|storage_?key)$/i;

/** Field value types that only ever hold machine data. */
const SKIP_VALUE_KEYS = new Set(["width", "height", "size", "centered", "image_first"]);

/**
 * Fold a string to its searchable form: NFKC (so full-width ＡＢＣ and ８ match
 * their ASCII twins), lower case, punctuation to single spaces.
 */
export function normalize(input: string): string {
	return input
		.normalize("NFKC")
		.toLowerCase()
		.replace(PUNCTUATION, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/**
 * Walk an arbitrary field value and collect every human-readable string.
 *
 * Handles the three shapes EmDash stores prose in: plain string fields, Portable
 * Text (`{_type: "block", children: [{text}]}`), and `blocks` field arrays whose
 * block objects mix prose with layout keys. Unknown shapes degrade to "collect
 * every string that is not obviously machine data", which is the right default
 * for a search index.
 */
export function extractText(value: unknown, out: string[] = [], depth = 0): string[] {
	if (depth > 12) return out;

	if (typeof value === "string") {
		if (value.trim()) out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) extractText(item, out, depth + 1);
		return out;
	}
	if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value)) {
			if (SKIP_KEY.test(key) || SKIP_VALUE_KEYS.has(key)) continue;
			// `alt` is prose a human wrote about an image, so it stays.
			extractText(child, out, depth + 1);
		}
		return out;
	}
	return out;
}

/**
 * Collect the searchable text of one entry: its title, then every other prose
 * field. `titleKey` names the field the title was read from so its text is not
 * counted twice — a duplicated title pollutes snippets.
 */
export function entryText(
	title: string | null,
	data: Record<string, unknown>,
	titleKey?: string,
): string {
	const rest = titleKey ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== titleKey)) : data;
	const parts = extractText(rest);
	if (title?.trim()) parts.unshift(title);
	return parts.join(" ");
}

/**
 * Split normalized text into index tokens.
 *
 * CJK runs become overlapping bigrams ("協力会社" -> 協力, 力会, 会社), which is what
 * makes substring search work without a morphological analyser. A one-character
 * CJK run is kept whole so single-kanji terms stay findable. Latin and digit runs
 * are kept as whole words, since they already have spaces around them.
 */
export function tokenize(input: string): string[] {
	const text = normalize(input);
	const tokens = new Set<string>();
	let run = "";
	let runIsCjk = false;

	const flush = () => {
		if (!run) return;
		if (runIsCjk) {
			if (run.length === 1) tokens.add(run);
			else for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
		} else if (run.length >= 2) {
			tokens.add(run);
		}
		run = "";
	};

	for (const char of text) {
		const isCjk = CJK.test(char);
		const isAlnum = !isCjk && ALNUM.test(char);
		if (!isCjk && !isAlnum) {
			flush();
			runIsCjk = false;
			continue;
		}
		if (run && isCjk !== runIsCjk) flush();
		runIsCjk = isCjk;
		run += char;
	}
	flush();

	return [...tokens];
}

/**
 * Whether the query is a single contiguous run (one CJK phrase or one word).
 * Only those can be confirmed with a substring check; a multi-word query is an
 * AND of its terms and may legitimately match text that never contains the
 * whole query verbatim.
 */
export function isSinglePhrase(query: string): boolean {
	return !normalize(query).includes(" ");
}

/** Cut a readable window of `text` around the first occurrence of `needle`. */
export function snippet(text: string, needle: string, radius = 48): string {
	const haystack = normalize(text);
	const at = haystack.indexOf(normalize(needle));
	if (at < 0) return text.slice(0, radius * 2).trim();
	const start = Math.max(0, at - radius);
	const end = Math.min(haystack.length, at + needle.length + radius);
	return `${start > 0 ? "…" : ""}${haystack.slice(start, end).trim()}${end < haystack.length ? "…" : ""}`;
}
