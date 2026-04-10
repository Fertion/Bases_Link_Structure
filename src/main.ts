import { Plugin } from "obsidian";
import { StructureView } from "./structure-view";

export default class BasesStructurePlugin extends Plugin {
	async onload() {
		this.registerBasesView("structure", {
			name: "Structure",
			icon: "lucide-git-branch",
			factory: (controller, containerEl) =>
				new StructureView(controller, containerEl, this),
			options: () => StructureView.getViewOptions(),
		});
	}
}
