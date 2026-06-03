import { App, TFile } from "obsidian";
import { parseMhtml } from "./mhtml-parser";
import { inlineResources } from "./html-inliner";

/**
 * DOM-based inline embed renderer.
 * Uses MutationObserver to detect .internal-embed elements for .mhtml/.mht
 * files and renders inlined iframe previews inside them.
 */

const PROCESSED_ATTR = "data-mhtml-preview-processed";

export function startEmbedObserver(app: App, iframeSandbox: string): MutationObserver {
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const node of mutation.addedNodes) {
				if (!(node instanceof HTMLElement)) continue;

				processElement(node, app, iframeSandbox);

				const embeds = node.querySelectorAll(".internal-embed");
				for (let i = 0; i < embeds.length; i++) {
					processElement(embeds[i] as HTMLElement, app, iframeSandbox);
				}
			}
		}
	});

	observer.observe(document.body, {
		childList: true,
		subtree: true,
	});

	// Process any embeds already in the DOM
	const existingEmbeds = document.querySelectorAll(".internal-embed");
	for (let i = 0; i < existingEmbeds.length; i++) {
		processElement(existingEmbeds[i] as HTMLElement, app, iframeSandbox);
	}

	return observer;
}

function processElement(el: HTMLElement, app: App, sandbox: string): void {
	if (el.hasAttribute(PROCESSED_ATTR)) return;

	const src = el.getAttribute("src");
	if (!src) return;
	if (!src.endsWith(".mhtml") && !src.endsWith(".mht")) return;

	el.setAttribute(PROCESSED_ATTR, "true");
	renderEmbed(el, src, app, sandbox);
}

async function renderEmbed(
	el: HTMLElement,
	src: string,
	app: App,
	sandbox: string
): Promise<void> {
	const wrapper = document.createElement("div");
	wrapper.addClass("mhtml-embed-container");
	wrapper.style.cssText =
		"width:100%; height:500px; overflow:hidden; border:1px solid var(--background-modifier-border); border-radius:6px; margin:0.5em 0;";

	const iframe = document.createElement("iframe");
	iframe.addClass("mhtml-embed-iframe");
	iframe.setAttribute("sandbox", sandbox);
	iframe.style.cssText = "width:100%; height:100%; border:none; display:block;";
	iframe.srcdoc = loadingHtml();
	wrapper.appendChild(iframe);

	// Important: append INSIDE the original element, not replace.
	// Replacing the element triggers CodeMirror DOM reconciliation
	// which causes the embed to disappear when clicking elsewhere.
	el.style.display = "block";
	el.style.width = "100%";
	el.innerHTML = "";
	el.appendChild(wrapper);

	try {
		const file = app.vault.getAbstractFileByPath(src);
		if (!file || !(file instanceof TFile)) {
			const af = app.metadataCache.getFirstLinkpathDest(src, "");
			if (!af || !(af instanceof TFile)) {
				iframe.srcdoc = errorHtml("File not found: " + src);
				return;
			}
			const buf = await app.vault.readBinary(af);
			const parsed = parseMhtml(buf);
			iframe.srcdoc = inlineResources(parsed);
			return;
		}

		const buf = await app.vault.readBinary(file);
		const parsed = parseMhtml(buf);
		iframe.srcdoc = inlineResources(parsed);
	} catch (error) {
		console.error("MHTML Preview: Embed render failed", src, error);
		iframe.srcdoc = errorHtml(String(error));
	}
}

function loadingHtml(): string {
	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; color: #666; }
</style></head>
<body><p>Loading...</p></body>
</html>`;
}

function errorHtml(message: string): string {
	const escaped = message
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #fff5f5; color: #c00; padding: 2em; box-sizing: border-box; }
  h2 { margin: 0 0 0.5em; font-size: 1em; }
  p { margin: 0; max-width: 100%; text-align: center; word-break: break-all; color: #666; font-size: 12px; }
</style></head>
<body><h2>Embed Error</h2><p>${escaped}</p></body>
</html>`;
}
