import { Plugin } from "obsidian";
import { getPluginLocale, t } from "./i18n";
import { StructureView } from "./structure-view";

export default class BasesStructurePlugin extends Plugin {
	async onload() {
		this.registerBasesView("structure", {
			name: t(getPluginLocale(), "basesViewName"),
			icon: "lucide-git-branch",
			factory: (controller, containerEl) =>
				new StructureView(controller, containerEl, this),
			options: () => StructureView.getViewOptions(this.app),
		});
	}
}
