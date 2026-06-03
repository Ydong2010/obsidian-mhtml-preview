import { Plugin, PluginSettingTab, Setting, App, TFile } from "obsidian";
import { MhtmlFileView, MHTML_VIEW_TYPE } from "./view";
import { MhtmlEmbedRenderer } from "./embed-renderer";
import type { MhtmlPreviewSettings } from "./mhtml-parser";
import { DEFAULT_SETTINGS } from "./mhtml-parser";

/**
 * Obsidian plugin for previewing .mhtml (MIME HTML) files.
 *
 * This plugin:
 * - Registers a custom FileView for .mhtml/.mht files
 * - Parses MHTML documents client-side
 * - Inlines all resources (images, CSS, fonts) as data URIs
 * - Renders the self-contained result in a sandboxed iframe
 * - Renders inline embeds (![[file.mhtml]]) in reading view
 */
export default class MhtmlPreviewPlugin extends Plugin {
	settings!: MhtmlPreviewSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Register the custom view type for full-tab viewing
		this.registerView(MHTML_VIEW_TYPE, (leaf) => new MhtmlFileView(leaf));

		// Register file extensions — clicking .mhtml/.mht files opens our view
		this.registerExtensions(["mhtml", "mht"], MHTML_VIEW_TYPE);

		// Register markdown post processor for inline embeds (![[file.mhtml]])
		this.registerMarkdownPostProcessor((el, ctx) => {
			const embeds = el.querySelectorAll(".internal-embed");
			for (let i = 0; i < embeds.length; i++) {
				const embed = embeds[i];
				const src = embed.getAttribute("src");
				if (!src) continue;
				if (!src.endsWith(".mhtml") && !src.endsWith(".mht")) continue;

				const file = this.app.metadataCache.getFirstLinkpathDest(
					src,
					ctx.sourcePath
				);
				if (!file || !(file instanceof TFile)) continue;

				ctx.addChild(
					new MhtmlEmbedRenderer(
						embed as HTMLElement,
						file,
						this.app,
						this.settings.iframeSandbox
					)
				);
			}
		});

		// Register settings tab
		this.addSettingTab(new MhtmlPreviewSettingTab(this.app, this));

		// Command: open the MHTML preview view (creates or reveals the view)
		this.addCommand({
			id: "open-mhtml-preview",
			name: "Open MHTML preview",
			callback: () => {
				this.activateView();
			},
		});

		console.log("MHTML Preview plugin v1.0.0 loaded");
	}

	onunload(): void {
		console.log("MHTML Preview plugin unloaded");
	}

	/**
	 * Activate the MHTML preview view — reveals existing view or creates a new one.
	 */
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

/**
 * Settings tab for the MHTML Preview plugin.
 */
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
			.setDesc(
				"Controls iframe security restrictions. " +
				'Default: "allow-scripts allow-same-origin". ' +
				"See MDN iframe sandbox documentation for available flags."
			)
			.addText((text) =>
				text
					.setPlaceholder("allow-scripts allow-same-origin")
					.setValue(this.plugin.settings.iframeSandbox)
					.onChange(async (value) => {
						this.plugin.settings.iframeSandbox = value || DEFAULT_SETTINGS.iframeSandbox;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dark mode filter")
			.setDesc(
				"Apply a CSS filter to the preview when Obsidian is in dark mode. " +
				"This inverts colors in the preview content."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.darkModeFilter)
					.onChange(async (value) => {
						this.plugin.settings.darkModeFilter = value;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "Supported Formats" });
		const infoDiv = containerEl.createDiv({ cls: "setting-item-description" });
		infoDiv.innerHTML =
			"<p>This plugin supports MHTML files saved by:</p>" +
			"<ul>" +
			"<li>Google Chrome / Microsoft Edge (Save as → Webpage, Single File)</li>" +
			"<li>Other Chromium-based browsers</li>" +
			"<li>Tools that produce RFC 2557 compliant MHTML</li>" +
			"</ul>" +
			"<p>File extensions: <code>.mhtml</code>, <code>.mht</code></p>";
	}
}
