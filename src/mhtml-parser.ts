/** A single MIME part extracted from a multipart/related MHTML document. */
export interface MimePart {
	headers: Map<string, string>;
	body: Uint8Array;
	mimeType: string;
	contentTypeRaw: string;
	contentLocation: string | null;
	contentId: string | null;
	transferEncoding: string;
	charset: string;
}

export interface ResourceEntry {
	mimeType: string;
	data: Uint8Array;
	dataUri: string;
}

export interface ParsedMhtml {
	boundary: string;
	parts: MimePart[];
	rootPartIndex: number;
	resourceMap: Map<string, ResourceEntry>;
}

export interface MhtmlPreviewSettings {
	iframeSandbox: string;
	darkModeFilter: boolean;
}

export const DEFAULT_SETTINGS: MhtmlPreviewSettings = {
	iframeSandbox: "allow-scripts allow-same-origin",
	darkModeFilter: false,
};

// ─── MIME header utilities ────────────────────────────────────────────────

function parseContentType(headerValue: string): { mimeType: string; charset: string; boundary: string } {
	const parts = headerValue.split(";");
	const mimeType = parts[0].trim().toLowerCase();
	let charset = "utf-8";
	let boundary = "";

	for (let i = 1; i < parts.length; i++) {
		const part = parts[i].trim();
		const eqIdx = part.indexOf("=");
		if (eqIdx > 0) {
			const paramName = part.substring(0, eqIdx).trim().toLowerCase();
			let paramValue = part.substring(eqIdx + 1).trim();
			if (
				(paramValue.startsWith('"') && paramValue.endsWith('"')) ||
				(paramValue.startsWith("'") && paramValue.endsWith("'"))
			) {
				paramValue = paramValue.slice(1, -1);
			}
			if (paramName === "charset") charset = paramValue.toLowerCase();
			if (paramName === "boundary") boundary = paramValue;
		}
	}

	return { mimeType, charset, boundary };
}

function parseHeaders(headerSection: string): Map<string, string> {
	const headers = new Map<string, string>();
	const lines = headerSection.split(/\r?\n/);
	let currentHeader: string | null = null;

	for (const line of lines) {
		if (/^[ \t]/.test(line) && currentHeader) {
			const existing = headers.get(currentHeader) ?? "";
			headers.set(currentHeader, existing + " " + line.trim());
		} else {
			const colonIdx = line.indexOf(":");
			if (colonIdx > 0) {
				const name = line.substring(0, colonIdx).trim().toLowerCase();
				const value = line.substring(colonIdx + 1).trim();
				headers.set(name, value);
				currentHeader = name;
			}
		}
	}

	return headers;
}

// ─── Boundary extraction ──────────────────────────────────────────────────

function extractBoundary(text: string): string {
	// Search first 8KB for the Content-Type header
	const searchText = text.substring(0, 8192);

	// Strategy 1: Find the Content-Type: multipart/related header and extract boundary
	// Use greedy quantifier (+) to capture the FULL boundary value
	const ctRegex = /content-type:\s*multipart\/related[^\r\n]*/i;
	const ctMatch = searchText.match(ctRegex);

	if (ctMatch) {
		// Try quoted boundary first: boundary="value"
		let bm = ctMatch[0].match(/boundary\s*=\s*"([^"]+)"/i);
		if (bm && bm[1]) return bm[1];

		// Try unquoted boundary: boundary=value (greedy, stops at ; or EOL)
		bm = ctMatch[0].match(/boundary\s*=\s*([^\s;]+)/i);
		if (bm && bm[1]) return bm[1];
	}

	// Strategy 2: Scan for boundary lines directly in the body
	// MHTML files always have lines starting with "--" followed by a boundary string
	// Look for lines like "----=_NextPart_..." or "----MultipartBoundary..."
	const boundaryLineRegex = /(?:^|\n)\r?(--[-=_A-Za-z0-9]+)[\r\n]/g;
	const candidates = new Map<string, number>();
	let match: RegExpExecArray | null;

	while ((match = boundaryLineRegex.exec(text)) !== null) {
		const candidate = match[1]; // e.g. "----=_NextPart_001_ABCD"
		const count = candidates.get(candidate) ?? 0;
		candidates.set(candidate, count + 1);
	}

	// The real boundary is the one that appears most often
	// (it appears between every part, so count >= 2 is a strong signal)
	let bestBoundary = "";
	let bestCount = 0;
	for (const [cand, count] of candidates) {
		// Must appear at least twice (opening + at least one separator)
		if (count >= 2 && count > bestCount) {
			bestBoundary = cand;
			bestCount = count;
		}
	}

	if (bestBoundary) {
		// Strip the "--" prefix to get the raw boundary
		return bestBoundary.substring(2);
	}

	throw new Error(
		"MHTML parse error: Could not find MIME boundary. " +
			"File may not be a valid MHTML document (RFC 2557)."
	);
}

// ─── Part splitting ───────────────────────────────────────────────────────

interface BoundaryLine {
	/** Position in text where the boundary line starts (at the \r or - or start of file) */
	pos: number;
	/** true if this is the end boundary (ends with --) */
	isEnd: boolean;
}

/**
 * Split the document into MIME parts by scanning for boundary lines.
 *
 * A boundary line is a line that starts with "--{boundary}" and may end with
 * "--" (marking the final boundary). We find all such lines and extract
 * the content between consecutive pairs.
 */
function splitByBoundary(text: string, boundary: string): string[] {
	const separator = "--" + boundary;
	const endSeparator = separator + "--";
	const parts: string[] = [];

	// Collect all boundary line positions by scanning line-by-line
	const boundaries: BoundaryLine[] = [];
	let searchPos = 0;

	while (searchPos < text.length) {
		// Ensure we're at the start of a line
		if (searchPos > 0 && text[searchPos - 1] !== "\n") {
			const nl = text.indexOf("\n", searchPos);
			if (nl === -1) break;
			searchPos = nl + 1;
			continue;
		}

		// Check for optional \r at line start
		let checkPos = searchPos;
		if (text[checkPos] === "\r") checkPos++;

		// Check if this line is a boundary
		if (text.startsWith(endSeparator, checkPos)) {
			// Verify it's the whole line (followed by \r, \n, or end of text)
			const afterBoundary = checkPos + endSeparator.length;
			if (afterBoundary >= text.length || text[afterBoundary] === "\r" || text[afterBoundary] === "\n") {
				boundaries.push({ pos: searchPos, isEnd: true });
			}
		} else if (text.startsWith(separator, checkPos)) {
			// Make sure this is really the full separator, not a prefix of something else
			// Check that the next char after separator is \r, \n, or --
			const afterSep = checkPos + separator.length;
			if (
				afterSep >= text.length ||
				text[afterSep] === "\r" ||
				text[afterSep] === "\n" ||
				text.startsWith("--", afterSep)
			) {
				boundaries.push({ pos: searchPos, isEnd: false });
			}
		}

		// Advance to next line
		const nl = text.indexOf("\n", searchPos);
		if (nl === -1) break;
		searchPos = nl + 1;
	}

	if (boundaries.length === 0) {
		// Debug info
		const preview = text.substring(0, Math.min(500, text.length));
		throw new Error(
			"MHTML parse error: No boundary lines found in document. " +
				`Looking for separator "${separator}". ` +
				`First 500 chars: ${preview}`
		);
	}

	// Extract content between consecutive boundaries
	for (let i = 0; i < boundaries.length; i++) {
		if (boundaries[i].isEnd) break;

		// Find end of current boundary line
		const lineEnd = text.indexOf("\n", boundaries[i].pos);
		if (lineEnd === -1) break;
		const contentStart = lineEnd + 1;

		if (contentStart >= text.length) break;

		// Find where content ends (before the next boundary line)
		let contentEnd: number;
		if (i + 1 < boundaries.length) {
			// Content goes up to the start of the next boundary
			contentEnd = boundaries[i + 1].pos;
			// Strip trailing newline(s) before the next boundary
			while (contentEnd > contentStart && (text[contentEnd - 1] === "\n" || text[contentEnd - 1] === "\r")) {
				contentEnd--;
			}
		} else {
			contentEnd = text.length;
		}

		if (contentEnd > contentStart) {
			const partText = text.substring(contentStart, contentEnd).trim();
			if (partText.length > 0) {
				parts.push(partText);
			}
		}
	}

	return parts;
}

// ─── Part parsing ─────────────────────────────────────────────────────────

function parsePart(partText: string): MimePart {
	let headersSection = "";
	let bodySection = "";
	const headerEnd = partText.indexOf("\r\n\r\n");

	if (headerEnd !== -1) {
		headersSection = partText.substring(0, headerEnd);
		bodySection = partText.substring(headerEnd + 4);
	} else {
		const lfEnd = partText.indexOf("\n\n");
		if (lfEnd !== -1) {
			headersSection = partText.substring(0, lfEnd);
			bodySection = partText.substring(lfEnd + 2);
		} else {
			bodySection = partText;
		}
	}

	const headers = parseHeaders(headersSection);
	const contentType = parseContentType(headers.get("content-type") ?? "text/plain");
	const contentLocation = headers.get("content-location") ?? null;
	let contentId = headers.get("content-id") ?? null;
	if (contentId && contentId.startsWith("<") && contentId.endsWith(">")) {
		contentId = contentId.slice(1, -1);
	}
	const transferEncoding = (headers.get("content-transfer-encoding") ?? "7bit").toLowerCase().trim();
	const decodedBody = decodeBody(bodySection, transferEncoding);

	return {
		headers,
		body: decodedBody,
		mimeType: contentType.mimeType,
		contentTypeRaw: headers.get("content-type") ?? "",
		contentLocation,
		contentId,
		transferEncoding,
		charset: contentType.charset || "utf-8",
	};
}

// ─── Body decoding ────────────────────────────────────────────────────────

function decodeBody(bodyText: string, transferEncoding: string): Uint8Array {
	switch (transferEncoding.toLowerCase().trim()) {
		case "base64":
			return base64ToBytes(bodyText);
		case "quoted-printable":
			return decodeQuotedPrintable(bodyText);
		default:
			return latin1ToBytes(bodyText);
	}
}

function base64ToBytes(base64: string): Uint8Array {
	const cleaned = base64.replace(/[\s\n\r]+/g, "");
	if (cleaned.length === 0) return new Uint8Array(0);

	try {
		const binaryStr = atob(cleaned);
		const bytes = new Uint8Array(binaryStr.length);
		for (let i = 0; i < binaryStr.length; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}
		return bytes;
	} catch {
		return manualBase64Decode(cleaned);
	}
}

function manualBase64Decode(base64: string): Uint8Array {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const lookup = new Map<string, number>();
	for (let i = 0; i < chars.length; i++) lookup.set(chars[i], i);

	const result: number[] = [];
	for (let i = 0; i < base64.length; i += 4) {
		const b1 = lookup.get(base64[i]) ?? 0;
		const b2 = lookup.get(base64[i + 1]) ?? 0;
		const b3 = lookup.get(base64[i + 2]) ?? 0;
		const b4 = lookup.get(base64[i + 3]) ?? 0;
		const triple = (b1 << 18) | (b2 << 12) | (b3 << 6) | b4;
		result.push((triple >> 16) & 0xff);
		if (base64[i + 2] !== "=" && base64[i + 2] !== undefined) result.push((triple >> 8) & 0xff);
		if (base64[i + 3] !== "=" && base64[i + 3] !== undefined) result.push(triple & 0xff);
	}
	return new Uint8Array(result);
}

function decodeQuotedPrintable(text: string): Uint8Array {
	const result: number[] = [];
	let i = 0;

	while (i < text.length) {
		if (text[i] === "=") {
			i++;
			if (i >= text.length) break;
			if (text[i] === "\r" && text[i + 1] === "\n") {
				i += 2;
			} else if (text[i] === "\n") {
				i++;
			} else if (i + 1 < text.length) {
				const byte = parseInt(text.substring(i, i + 2), 16);
				if (!isNaN(byte)) result.push(byte);
				i += 2;
			}
		} else if (text[i] === "\r" || text[i] === "\n") {
			i++;
		} else {
			result.push(text.charCodeAt(i));
			i++;
		}
	}

	return new Uint8Array(result);
}

// ─── Root part identification ─────────────────────────────────────────────

function findRootPart(parts: MimePart[]): number {
	for (let i = 0; i < parts.length; i++) {
		if (parts[i].mimeType === "text/html") return i;
	}
	for (let i = 0; i < parts.length; i++) {
		if (parts[i].mimeType.startsWith("text/")) return i;
	}
	return 0;
}

// ─── Resource map ─────────────────────────────────────────────────────────

function buildResourceMap(parts: MimePart[], rootPartIndex: number): Map<string, ResourceEntry> {
	const map = new Map<string, ResourceEntry>();

	for (let i = 0; i < parts.length; i++) {
		if (i === rootPartIndex) continue;
		const part = parts[i];
		if (part.body.length < 50) continue;

		const entry: ResourceEntry = {
			mimeType: part.mimeType,
			data: part.body,
			dataUri: bytesToDataUri(part.body, part.mimeType),
		};

		if (part.contentLocation) {
			const normalized = normalizeUrl(part.contentLocation);
			map.set(normalized, entry);
			const filename = extractFilename(normalized);
			if (filename && filename !== normalized && !map.has(filename)) {
				map.set(filename, entry);
			}
		}

		if (part.contentId) {
			map.set("cid:" + part.contentId, entry);
		}
	}

	return map;
}

// ─── URL utilities ────────────────────────────────────────────────────────

export function normalizeUrl(url: string): string {
	const trimmed = url.trim();
	try {
		const parsed = new URL(trimmed);
		return (parsed.pathname + parsed.search + parsed.hash).replace(/\/+/g, "/");
	} catch {
		return trimmed.replace(/\/+/g, "/");
	}
}

export function extractFilename(url: string): string {
	const trimmed = url.trim();
	const pathOnly = trimmed.split("?")[0].split("#")[0];
	const lastSlash = pathOnly.lastIndexOf("/");
	if (lastSlash >= 0 && lastSlash < pathOnly.length - 1) {
		return pathOnly.substring(lastSlash + 1);
	}
	return pathOnly;
}

// ─── Byte utilities ───────────────────────────────────────────────────────

function latin1ToBytes(str: string): Uint8Array {
	const bytes = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) {
		bytes[i] = str.charCodeAt(i) & 0xff;
	}
	return bytes;
}

function bytesToDataUri(bytes: Uint8Array, mimeType: string): string {
	let binaryStr = "";
	for (let i = 0; i < bytes.length; i++) {
		binaryStr += String.fromCharCode(bytes[i]);
	}
	return "data:" + mimeType + ";base64," + btoa(binaryStr);
}

// ─── Main parse function ──────────────────────────────────────────────────

export function parseMhtml(input: ArrayBuffer): ParsedMhtml {
	const bytes = new Uint8Array(input);

	// Strip UTF-8 BOM if present (EF BB BF)
	let startOffset = 0;
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		startOffset = 3;
	}

	// Decode entire file to Latin-1 string (preserves all bytes 1:1)
	const chunks: string[] = [];
	for (let i = startOffset; i < bytes.length; i++) {
		chunks.push(String.fromCharCode(bytes[i]));
	}
	const text = chunks.join("");

	// Extract boundary
	const boundary = extractBoundary(text);

	// Split into parts
	const rawParts = splitByBoundary(text, boundary);

	// Parse each part
	const parts = rawParts.map((raw) => parsePart(raw));

	if (parts.length === 0) {
		throw new Error("MHTML parse error: No content parts found in document.");
	}

	const rootPartIndex = findRootPart(parts);
	const resourceMap = buildResourceMap(parts, rootPartIndex);

	return { boundary, parts, rootPartIndex, resourceMap };
}
