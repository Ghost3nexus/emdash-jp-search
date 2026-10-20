import { describe, expect, it } from "vitest";

import { entryText, extractText, isSinglePhrase, normalize, tokenize } from "../src/text.js";

describe("normalize", () => {
	it("folds full-width characters onto their ASCII twins", () => {
		expect(normalize("ＡＢＣ１２３")).toBe("abc123");
	});

	it("turns Japanese punctuation into word boundaries", () => {
		expect(normalize("空調・給排水、電気。")).toBe("空調 給排水 電気");
	});
});

describe("tokenize", () => {
	it("emits overlapping bigrams for a Japanese run", () => {
		expect(tokenize("協力会社").sort()).toEqual(["会社", "力会", "協力"].sort());
	});

	it("keeps a single kanji findable", () => {
		expect(tokenize("雪")).toEqual(["雪"]);
	});

	it("keeps latin words whole rather than splitting them", () => {
		expect(tokenize("Halden energy")).toEqual(["halden", "energy"]);
	});

	it("does not bleed bigrams across a script change", () => {
		// "LED化" must not produce a token that straddles "d" and "化".
		const tokens = tokenize("LED化");
		expect(tokens).toContain("led");
		expect(tokens).toContain("化");
		expect(tokens.some((t) => /[a-z]/.test(t) && /[一-鿿]/.test(t))).toBe(false);
	});

	it("covers every substring boundary of a longer phrase", () => {
		// This is the property the whole design rests on: searching for any
		// two-or-more-character substring of an indexed phrase must hit.
		const indexed = new Set(tokenize("設備工事の協力会社を募集しています"));
		for (const query of ["協力会社", "設備工事", "募集", "工事の協力"]) {
			for (const token of tokenize(query)) {
				expect(indexed.has(token), `${query} -> ${token}`).toBe(true);
			}
		}
	});

	it("ignores punctuation-only input", () => {
		expect(tokenize("・、。 ")).toEqual([]);
	});
});

describe("isSinglePhrase", () => {
	it("treats one Japanese run as a phrase", () => {
		expect(isSinglePhrase("協力会社募集")).toBe(true);
	});

	it("treats two words as a multi-term query", () => {
		expect(isSinglePhrase("空調 工事")).toBe(false);
	});
});

describe("extractText", () => {
	it("reads prose out of a blocks field and skips machine keys", () => {
		const blocks = [
			{
				_type: "marketing_hero",
				_version: 1,
				_key: "hero1",
				headline: "設備工事の協力会社を募集しています",
				primary_cta_label: "応募フォームへ",
				primary_cta_url: "/contact",
				anchor_id: "top",
				centered: true,
				image: {
					provider: "local",
					id: "01ABC",
					alt: "現場写真",
					width: 2400,
					mimeType: "image/jpeg",
					meta: { storageKey: "01ABC.jpg" },
				},
			},
		];

		const text = extractText(blocks).join(" ");
		expect(text).toContain("設備工事の協力会社を募集しています");
		expect(text).toContain("応募フォームへ");
		// Alt text is prose a human wrote, so it is indexed.
		expect(text).toContain("現場写真");
		// URLs, ids, icon names and storage keys are not.
		expect(text).not.toContain("/contact");
		expect(text).not.toContain("01ABC");
		expect(text).not.toContain("image/jpeg");
		expect(text).not.toContain("top");
	});

	it("reads prose out of Portable Text", () => {
		const portableText = [
			{
				_type: "block",
				_key: "a",
				style: "normal",
				children: [
					{ _type: "span", _key: "a1", text: "弊社は" },
					{ _type: "span", _key: "a2", text: "空調設備工事", marks: ["strong"] },
					{ _type: "span", _key: "a3", text: "を請け負います。" },
				],
			},
		];
		expect(extractText(portableText).join("")).toContain("空調設備工事");
	});

	it("puts the title first so it can be scored higher", () => {
		const text = entryText("協力会社募集", { body: "詳細はこちら" });
		expect(text.startsWith("協力会社募集")).toBe(true);
	});

	it("survives a deeply nested or cyclic-looking value without hanging", () => {
		let nested: unknown = "最奥";
		for (let i = 0; i < 40; i += 1) nested = { child: nested };
		expect(() => extractText(nested)).not.toThrow();
	});
});
