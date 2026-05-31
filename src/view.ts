import { FileView, WorkspaceLeaf, TFile, TAbstractFile, Menu } from "obsidian";
import { parseMhtml } from "./mhtml-parser";
import { inlineResources } from "./html-inliner";

export const MHTML_VIEW_TYPE = "mhtml-preview";

/**
 * Custom FileView for rendering MHTML files.
 * Extends FileView to properly bind file objects when clicking .mhtml files
 * in Obsidian's file explorer.
 */
export class MhtmlFileView extends FileView {
	private iframeEl: HTMLIFrameElement | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return MHTML_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.name ?? "MHTML Preview";
	}

	getIcon(): string {
		return "file-text";
	}

	onload(): void {
		super.onload();

		// Build the view DOM using the inherited contentEl
		const previewContainer = this.contentEl.createDiv({ cls: "mhtml-preview-container" });
		this.iframeEl = previewContainer.createEl("iframe", {
			cls: "mhtml-preview-iframe",
			attr: {
				sandbox: "allow-scripts allow-same-origin",
				allowfullscreen: "true",
			},
		});

		// Set iframe to fill container and allow scrolling
		this.iframeEl.style.width = "100%";
		this.iframeEl.style.height = "100%";
		this.iframeEl.style.border = "none";
		this.iframeEl.style.display = "block";
		this.iframeEl.setAttribute("scrolling", "auto");

		// Listen for file modifications to auto-refresh
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file === this.file && this.iframeEl) {
					this.renderFile();
				}
			})
		);

		// Listen for file rename
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, _oldPath: string) => {
				if (file === this.file) {
					this.updateDisplay();
				}
			})
		);
	}

	onunload(): void {
		// Clean up iframe to prevent memory leaks
		if (this.iframeEl) {
			this.iframeEl.remove();
			this.iframeEl = null;
		}
		super.onunload();
	}

	/**
	 * Called by the FileView machinery when a file is opened in this view.
	 */
	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		if (this.iframeEl) {
			await this.renderFile();
		}
	}

	/**
	 * Read the MHTML file, parse it, inline resources, and render in the iframe.
	 */
	private async renderFile(): Promise<void> {
		if (!this.file || !this.iframeEl) return;

		try {
			// Show loading indicator
			this.iframeEl.srcdoc = this.loadingHtml();

			// Read the MHTML file as binary
			const arrayBuffer = await this.app.vault.readBinary(this.file);

			// Parse the MHTML document
			const parsed = parseMhtml(arrayBuffer);

			// Inline resources to produce a self-contained HTML document
			const htmlContent = inlineResources(parsed);

			// Render in iframe via srcdoc (avoids Chromium's MHTML-in-iframe block)
			this.iframeEl.srcdoc = htmlContent;
		} catch (error) {
			console.error("MHTML Preview: Failed to render file", this.file.name, error);
			this.iframeEl.srcdoc = this.errorHtml(String(error));
		}
	}

	/**
	 * Update the view's display text (e.g. after file rename).
	 */
	private updateDisplay(): void {
		const headerEl = this.containerEl.closest(".workspace-leaf");
		if (headerEl) {
			const titleEl = headerEl.querySelector(".view-header-title") as HTMLElement | null;
			if (titleEl) {
				titleEl.textContent = this.getDisplayText();
			}
		}
	}

	private loadingHtml(): string {
		return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
  body { display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #f5f5f5; color: #666; }
</style></head>
<body><p>Loading MHTML...</p></body>
</html>`;
	}

	private errorHtml(message: string): string {
		const escaped = this.escapeHtml(message);
		return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #fff5f5; color: #c00; padding: 2em; box-sizing: border-box; }
  h2 { margin: 0 0 0.5em; }
  p { margin: 0; max-width: 600px; text-align: center; word-break: break-all; color: #666; font-size: 14px; }
</style></head>
<body><h2>Error Rendering MHTML</h2><p>${escaped}</p></body>
</html>`;
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	onPaneMenu(menu: Menu, source: "more-options" | "tab-header" | string): void {
		super.onPaneMenu(menu, source);

		if (source === "more-options") {
			menu.addItem((item) => {
				item.setTitle("Refresh preview")
					.setIcon("refresh-cw")
					.onClick(() => {
						this.renderFile();
					});
			});

			menu.addItem((item) => {
				item.setTitle("Copy file path")
					.setIcon("clipboard-copy")
					.onClick(() => {
						if (this.file) {
							navigator.clipboard.writeText(this.file.path);
						}
					});
			});
		}
	}
}
