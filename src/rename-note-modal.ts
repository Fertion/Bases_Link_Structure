import { App, ButtonComponent, Modal, Notice, TFile, normalizePath } from "obsidian";
import { getPluginLocale, t } from "./i18n";

export class RenameNoteModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const loc = getPluginLocale();
		contentEl.empty();
		this.setTitle(t(loc, "renameTitle"));

		const stem = this.file.basename.replace(/\.md$/i, "");
		const input = contentEl.createEl("input", {
			type: "text",
			cls: "rename-note-modal-input",
			value: stem,
			attr: { spellcheck: "false" },
		});

		const btnRow = contentEl.createDiv({ cls: "rename-note-modal-buttons" });
		new ButtonComponent(btnRow).setButtonText(t(loc, "renameCancel")).onClick(() => this.close());
		new ButtonComponent(btnRow)
			.setButtonText(t(loc, "renameSubmit"))
			.setCta()
			.onClick(() => {
				void this.submit(input.value);
			});

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void this.submit(input.value);
			}
		});

		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	private async submit(raw: string): Promise<void> {
		const loc = getPluginLocale();
		const name = raw.trim();
		if (!name) {
			new Notice(t(loc, "renameEmptyName"));
			return;
		}
		const base = /\.md$/i.test(name) ? name : `${name}.md`;
		const parentPath = this.file.parent?.path ?? "";
		const newPath = normalizePath(parentPath ? `${parentPath}/${base}` : base);
		if (newPath === this.file.path) {
			this.close();
			return;
		}
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(t(loc, "renameFileExists"));
			return;
		}
		try {
			await this.app.fileManager.renameFile(this.file, newPath);
			this.close();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(msg);
		}
	}
}

export function openRenameNoteModal(app: App, file: TFile): void {
	new RenameNoteModal(app, file).open();
}
