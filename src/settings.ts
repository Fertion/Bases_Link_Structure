import { App, PluginSettingTab } from "obsidian";
import BasesStructurePlugin from "./main";

export interface MyPluginSettings {
	// Reserved for future plugin-level settings.
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: BasesStructurePlugin;

	constructor(app: App, plugin: BasesStructurePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("p", {
			text: "This plugin currently uses per-view settings in Bases options.",
			cls: "setting-item-description",
		});
	}
}
