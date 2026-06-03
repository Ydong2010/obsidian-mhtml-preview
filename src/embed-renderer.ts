import { MarkdownRenderChild, TFile, App } from "obsidian";
import { parseMhtml } from "./mhtml-parser";
import { inlineResources } from "./html-inliner";

/**
 * Renders an MHTML file as an inline embed in reading view.
 * Extends MarkdownRenderChild so Obsidian automatically unloads
 * the iframe when the embed is removed from the DOM.
 */
export class MhtmlEmbedRenderer extends MarkdownRenderChild {
	private file: TFile;
	private app: App;
	private iframeSandbox: string;

	constructor(containerEl: HTMLElement, file: TFile, app: App, iframeSandbox: string) {
		super(containerEl);
		this.file = file;
		this.app = app;
		this.iframeSandbox = iframeSandbox;
	}

	async onload(): Promise<void> {
		// Create the embed preview container
		const wrapper = document.createElement("div");
		wrapper.addClass("mhtml-embed-container");
		wrapper.style.cssText =
			"width:100%; height:500px; overflow:hidden; border:1px solid var(--background-modifier-border); border-radius:6px; margin:0.5em 0;";

		const iframe = document.createElement("iframe");
		iframe.addClass("mhtml-embed-iframe");
		iframe.setAttribute("sandbox", this.iframeSandbox);
		iframe.style.cssText = "width:100%; height:100%; border:none; display:block;";
		wrapper.appendChild(iframe);

		// Replace the .internal-embed span with our wrapper
		this.containerEl.replaceWith(wrapper);

		// Render the MHTML content
		try {
			iframe.srcdoc = this.loadingHtml();

			const arrayBuffer = await this.app.vault.readBinary(this.file);
			const parsed = parseMhtml(arrayBuffer);
			const htmlContent = inlineResources(parsed);
			iframe.srcdoc = htmlContent;
		} catch (error) {
			console.error("MHTML Preview: Embed render failed", this.file.name, error);
			iframe.srcdoc = this.errorHtml(String(error));
		}
	}

	private loadingHtml(): string {
		return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; color: #666; }
</style></head>
<body><p>Loading...</p></body>
</html>`;
	}

	private errorHtml(message: string): string {
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
}
