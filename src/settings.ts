import { App, PluginSettingTab } from "obsidian";
import BasesStructurePlugin from "./main";

/** Reserved for future plugin-level settings (none yet). */
export type BasesStructurePluginSettings = Record<string, never>;

export const DEFAULT_SETTINGS: BasesStructurePluginSettings = {};

export class BasesStructureSettingTab extends PluginSettingTab {
	plugin: BasesStructurePlugin;

	constructor(app: App, plugin: BasesStructurePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("p", {
			text: "This plugin currently uses per-view settings in the bases view.",
			cls: "setting-item-description",
		});
	}
}
