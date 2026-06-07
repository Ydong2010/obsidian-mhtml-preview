import { Plugin, PluginSettingTab, Setting, App, TFile, MarkdownView } from "obsidian";
import { MhtmlFileView, MHTML_VIEW_TYPE } from "./view";
import { MhtmlEmbedRenderer } from "./embed-renderer";
import { startEmbedObserver } from "./live-preview";
import type { MhtmlPreviewSettings } from "./mhtml-parser";
import { DEFAULT_SETTINGS } from "./mhtml-parser";

export default class MhtmlPreviewPlugin extends Plugin {
	settings!: MhtmlPreviewSettings;
	private embedObserver: MutationObserver | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(MHTML_VIEW_TYPE, (leaf) => new MhtmlFileView(leaf));
		this.registerExtensions(["mhtml", "mht"], MHTML_VIEW_TYPE);

		// Reading view inline embed
		this.registerMarkdownPostProcessor((el, ctx) => {
			const embeds = el.querySelectorAll(".internal-embed");
			for (let i = 0; i < embeds.length; i++) {
				const embed = embeds[i];
				const src = embed.getAttribute("src");
				if (!src) continue;
				if (!src.endsWith(".mhtml") && !src.endsWith(".mht")) continue;

				const file = this.app.metadataCache.getFirstLinkpathDest(
					src, ctx.sourcePath
				);
				if (!file || !(file instanceof TFile)) continue;

				ctx.addChild(
					new MhtmlEmbedRenderer(
						embed as HTMLElement, file, this.app,
						this.settings.iframeSandbox
					)
				);
			}
		});

		// Live Preview embed (MutationObserver)
		this.embedObserver = startEmbedObserver(
			this.app, this.settings.iframeSandbox
		);

		// Convert [text](path.mhtml) or [[file.mhtml]] to embed with !
		this.addCommand({
			id: "convert-to-mhtml-embed",
			name: "Convert MHTML link to embed",
			editorCallback: (editor) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);

				// Try markdown link: [text](path.mhtml) → ![text](path.mhtml)
				const mdRe = /\[([^\]]*)\]\(([^)]+\.(?:mhtml|mht))\)/gi;
				let m: RegExpExecArray | null;
				while ((m = mdRe.exec(line)) !== null) {
					const idx = m.index;
					if (idx > 0 && line[idx - 1] === "!") continue;
					editor.setCursor({ line: cursor.line, ch: idx });
					editor.replaceSelection("!");
					return;
				}

				// Try wikilink: [[file.mhtml]] → ![[file.mhtml]]
				const wlRe = /\[\[([^\]]+\.(?:mhtml|mht))\]\]/gi;
				while ((m = wlRe.exec(line)) !== null) {
					const idx = m.index;
					if (idx > 0 && line[idx - 1] === "!") continue;
					editor.setCursor({ line: cursor.line, ch: idx });
					editor.replaceSelection("!");
					return;
				}
			},
		});

		this.addCommand({
			id: "open-mhtml-preview",
			name: "Open MHTML preview",
			callback: () => this.activateView(),
		});

		this.addSettingTab(new MhtmlPreviewSettingTab(this.app, this));

		console.log("MHTML Preview plugin v1.1.0 loaded");
	}

	onunload(): void {
		if (this.embedObserver) {
			this.embedObserver.disconnect();
			this.embedObserver = null;
		}
		console.log("MHTML Preview plugin unloaded");
	}

	async activateView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(MHTML_VIEW_TYPE);
		if (leaves.length > 0) {
			this.app.workspace.revealLeaf(leaves[0]);
		} else {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.setViewState({ type: MHTML_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class MhtmlPreviewSettingTab extends PluginSettingTab {
	plugin: MhtmlPreviewPlugin;

	constructor(app: App, plugin: MhtmlPreviewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "MHTML Preview Settings" });

		new Setting(containerEl)
			.setName("Iframe sandbox")
			.setDesc("Controls iframe security. Default: allow-scripts allow-same-origin.")
			.addText((text) =>
				text
					.setPlaceholder("allow-scripts allow-same-origin")
					.setValue(this.plugin.settings.iframeSandbox)
					.onChange(async (value) => {
						this.plugin.settings.iframeSandbox =
							value || DEFAULT_SETTINGS.iframeSandbox;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dark mode filter")
			.setDesc("Apply a CSS filter to the preview in dark mode.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.darkModeFilter)
					.onChange(async (value) => {
						this.plugin.settings.darkModeFilter = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Supported Formats" });
		const info = containerEl.createDiv({ cls: "setting-item-description" });
		info.innerHTML =
			"<p>MHTML files from Chrome/Edge (Save → Webpage, Single File).<br>" +
			"Extensions: <code>.mhtml</code>, <code>.mht</code></p>";
	}
}
