import type { ParsedMhtml, ResourceEntry } from "./mhtml-parser";
import { normalizeUrl, extractFilename } from "./mhtml-parser";

/**
 * Produce a self-contained HTML string from a parsed MHTML document.
 */
export function inlineResources(parsed: ParsedMhtml): string {
	const rootPart = parsed.parts[parsed.rootPartIndex];
	const htmlText = decodeHtmlText(rootPart.body, rootPart.charset);

	const unresolvedUrls: string[] = [];

	const parser = new DOMParser();
	const doc = parser.parseFromString(htmlText, "text/html");

	// Step 1: Convert <link rel="stylesheet"> to inline <style> tags
	// This is more reliable than data URI hrefs
	inlineStylesheetLinks(doc, parsed.resourceMap, unresolvedUrls);

	// Step 2: Inline remaining resource URLs in element attributes (img, script, etc.)
	inlineElementAttributes(doc, parsed.resourceMap, unresolvedUrls);

	// Step 3: Inline url() references inside <style> and style="..."
	inlineStyleUrls(doc, parsed.resourceMap);

	// Step 4: Ensure proper charset
	ensureMetaCharset(doc);

	const result = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;

	if (unresolvedUrls.length > 0) {
		const unique = [...new Set(unresolvedUrls)];
		console.warn(
			`MHTML Preview: ${unique.length} unresolved resource URL(s):`,
			unique.slice(0, 20)
		);
	}

	return result;
}

// ─── HTML text decoding ───────────────────────────────────────────────────

function decodeHtmlText(bytes: Uint8Array, charset: string): string {
	const normalizedCharset = charset.toLowerCase().trim();
	const charsetMap: Record<string, string> = {
		"utf-8": "utf-8", utf8: "utf-8",
		"iso-8859-1": "iso-8859-1", latin1: "iso-8859-1",
		"windows-1252": "windows-1252", cp1252: "windows-1252",
		shift_jis: "shift_jis", sjis: "shift_jis",
		"euc-jp": "euc-jp", "euc-kr": "euc-kr",
		gb2312: "gb2312", gbk: "gbk", big5: "big5",
	};
	const mapped = charsetMap[normalizedCharset] ?? normalizedCharset;

	try {
		return new TextDecoder(mapped, { fatal: false }).decode(bytes);
	} catch {
		try {
			return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		} catch {
			let result = "";
			for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
			return result;
		}
	}
}

// ─── Stylesheet link inlining (convert <link> to <style>) ────────────────

/**
 * For each <link rel="stylesheet">, find the CSS content in the resource map
 * and replace the <link> element with an inline <style> tag.
 * This is more reliable than using data URI hrefs.
 */
function inlineStylesheetLinks(
	doc: Document,
	resourceMap: Map<string, ResourceEntry>,
	unresolvedUrls: string[]
): void {
	const links = doc.querySelectorAll('link[rel="stylesheet"], link[rel="STYLESHEET"]');
	const toReplace: { link: Element; style: HTMLStyleElement }[] = [];

	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		const href = link.getAttribute("href");
		if (!href || /^data:/i.test(href)) continue;

		const dataUri = resolveResourceUrl(href, resourceMap);
		if (!dataUri) {
			unresolvedUrls.push("[CSS] " + href);
			continue;
		}

		// Extract the CSS text from the data URI
		const cssText = dataUriToText(dataUri);
		if (!cssText) {
			unresolvedUrls.push("[CSS-decode] " + href);
			continue;
		}

		// Create a <style> element with the CSS content
		const style = doc.createElement("style");
		style.textContent = cssText;

		// Copy media attribute if present
		const media = link.getAttribute("media");
		if (media && media !== "all") {
			style.setAttribute("media", media);
		}

		toReplace.push({ link, style });
	}

	// Replace <link> with <style> (deferred to avoid live-NodeList issues)
	for (const { link, style } of toReplace) {
		link.parentNode?.insertBefore(style, link);
		link.parentNode?.removeChild(link);
	}
}

/**
 * Extract text content from a data URI string.
 * Returns null if the data URI doesn't represent text content.
 */
function dataUriToText(dataUri: string): string | null {
	// Format: data:mime/type;base64,BASE64DATA
	const match = dataUri.match(/^data:([^;]*)(;base64)?,(.*)$/);
	if (!match) return null;

	const mimeType = match[1].toLowerCase();
	const isBase64 = match[2] === ";base64";
	const payload = match[3];

	if (!isBase64) {
		// URL-encoded
		try {
			return decodeURIComponent(payload);
		} catch {
			return payload;
		}
	}

	// Base64 encoded
	try {
		const binaryStr = atob(payload);
		const bytes = new Uint8Array(binaryStr.length);
		for (let i = 0; i < binaryStr.length; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}

		// Try UTF-8 first, fall back to Latin-1
		try {
			return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		} catch {
			let result = "";
			for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes[i]);
			return result;
		}
	} catch {
		return null;
	}
}

// ─── Element attribute inlining ───────────────────────────────────────────

const TAG_ATTR_MAP: Record<string, string[]> = {
	img: ["src", "srcset"],
	script: ["src"],
	link: ["href"],
	video: ["src", "poster"],
	audio: ["src"],
	source: ["src", "srcset"],
	iframe: ["src"],
	embed: ["src"],
	object: ["data"],
	input: ["src"],
	track: ["src"],
	use: ["href"],
	image: ["href"],
};

function inlineElementAttributes(
	doc: Document,
	resourceMap: Map<string, ResourceEntry>,
	unresolvedUrls: string[]
): void {
	for (const [tagName, attrs] of Object.entries(TAG_ATTR_MAP)) {
		const elements = doc.querySelectorAll(tagName);
		for (let i = 0; i < elements.length; i++) {
			const el = elements[i];
			for (const attrName of attrs) {
				const value = el.getAttribute(attrName);
				if (!value) continue;

				if (attrName === "srcset") {
					const newSrcset = processSrcset(value, resourceMap, unresolvedUrls);
					if (newSrcset !== value) el.setAttribute(attrName, newSrcset);
				} else {
					const dataUri = resolveResourceUrl(value, resourceMap);
					if (dataUri) {
						el.setAttribute(attrName, dataUri);
					} else if (!/^data:/i.test(value) && !/^javascript:/i.test(value) && !value.startsWith("#")) {
						unresolvedUrls.push(value);
					}
				}
			}
		}
	}
}

// ─── CSS URL inlining ─────────────────────────────────────────────────────

function inlineStyleUrls(doc: Document, resourceMap: Map<string, ResourceEntry>): void {
	const styles = doc.querySelectorAll("style");
	for (let i = 0; i < styles.length; i++) {
		if (styles[i].textContent) {
			styles[i].textContent = replaceCssUrls(styles[i].textContent, resourceMap);
		}
	}

	const allElements = doc.querySelectorAll("[style]");
	for (let i = 0; i < allElements.length; i++) {
		const styleValue = allElements[i].getAttribute("style");
		if (styleValue) {
			const newStyle = replaceCssUrls(styleValue, resourceMap);
			if (newStyle !== styleValue) allElements[i].setAttribute("style", newStyle);
		}
	}
}

function replaceCssUrls(css: string, resourceMap: Map<string, ResourceEntry>): string {
	const pattern = /url\(\s*["']?\s*([^)"'\s]+)\s*["']?\s*\)/gi;
	return css.replace(pattern, (fullMatch: string, url: string) => {
		if (/^data:/i.test(url)) return fullMatch;
		const dataUri = resolveResourceUrl(url, resourceMap);
		if (dataUri) return "url(" + dataUri + ")";
		return fullMatch;
	});
}

// ─── URL resolution ──────────────────────────────────────────────────────

function resolveResourceUrl(url: string, resourceMap: Map<string, ResourceEntry>): string | null {
	const trimmed = url.trim();
	if (/^data:/i.test(trimmed)) return null;
	if (/^javascript:/i.test(trimmed)) return null;
	if (trimmed.startsWith("#")) return null;
	if (/^blob:/i.test(trimmed)) return null;
	if (trimmed === "") return null;

	const normalized = normalizeUrl(trimmed);

	const match =
		resourceMap.get(normalized) ??
		resourceMap.get(trimmed) ??
		findInMap(resourceMap, normalized);

	if (match) return match.dataUri;

	if (/^cid:/i.test(trimmed)) {
		const cidMatch = resourceMap.get(trimmed);
		if (cidMatch) return cidMatch.dataUri;
	}

	return null;
}

function findInMap(resourceMap: Map<string, ResourceEntry>, normalizedUrl: string): ResourceEntry | undefined {
	const filename = extractFilename(normalizedUrl);
	const pathOnly = normalizedUrl.split("?")[0].split("#")[0];
	const lowerFilename = filename.toLowerCase();

	// A: filename-only
	if (filename) {
		const f = resourceMap.get(filename);
		if (f) return f;
	}

	// B: path without query/hash
	if (pathOnly !== normalizedUrl) {
		const m = resourceMap.get(pathOnly);
		if (m) return m;
	}

	// C: with/without leading slash
	if (normalizedUrl.startsWith("/")) {
		const m = resourceMap.get(normalizedUrl.substring(1));
		if (m) return m;
	} else {
		const m = resourceMap.get("/" + normalizedUrl);
		if (m) return m;
	}

	// D: case-insensitive filename
	if (filename) {
		for (const [key, entry] of resourceMap) {
			if (extractFilename(key).toLowerCase() === lowerFilename) return entry;
		}
	}

	// E: path segment tail match (last 2 segments)
	const searchSegments = pathOnly.replace(/\\/g, "/").split("/").filter(Boolean);
	if (searchSegments.length >= 2) {
		const tail = searchSegments.slice(-2).join("/");
		for (const [key, entry] of resourceMap) {
			if (key.endsWith("/" + tail) || key.endsWith(tail)) return entry;
		}
	}

	return undefined;
}

// ─── srcset processing ────────────────────────────────────────────────────

function processSrcset(
	srcset: string,
	resourceMap: Map<string, ResourceEntry>,
	unresolvedUrls: string[]
): string {
	const parts = srcset.split(",");
	const newParts: string[] = [];

	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) { newParts.push(part); continue; }
		const tokens = trimmed.split(/\s+/);
		const url = tokens[0];
		const descriptors = tokens.slice(1).join(" ");
		const dataUri = resolveResourceUrl(url, resourceMap);
		if (dataUri) {
			newParts.push(dataUri + (descriptors ? " " + descriptors : ""));
		} else {
			newParts.push(trimmed);
			unresolvedUrls.push(url);
		}
	}

	return newParts.join(", ");
}

// ─── Document metadata ────────────────────────────────────────────────────

function ensureMetaCharset(doc: Document): void {
	if (doc.querySelector('meta[charset]')) return;
	const head = doc.head;
	if (!head) return;
	const meta = doc.createElement("meta");
	meta.setAttribute("charset", "utf-8");
	head.insertBefore(meta, head.firstChild);
}
