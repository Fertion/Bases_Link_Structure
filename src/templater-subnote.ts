import { App, normalizePath, TFile, Vault, Workspace } from "obsidian";
import { type PluginLocale, t } from "./i18n";

/** Bridge to Templater; plugin id is `templater-obsidian`. */
export interface TemplaterPluginBridge {
	settings?: {
		trigger_on_file_creation?: boolean;
		/** Templater setting “Template folder location”; empty means any `.md` (same as Templater’s picker). */
		templates_folder?: string;
	};
	templater?: {
		write_template_to_file(template: TFile, file: TFile): Promise<void>;
	};
}

export function getTemplaterPlugin(app: App): TemplaterPluginBridge | null {
	const p = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins
		.plugins["templater-obsidian"] as TemplaterPluginBridge | undefined;
	return p ?? null;
}

/** For Bases `FileOption.filter`: `.md` files under Templater’s template folder (or all `.md` if that folder is unset). */
export function subNoteTemplateFileFilter(app: App, file: TFile): boolean {
	if (file.extension !== "md") {
		return false;
	}
	const tp = getTemplaterPlugin(app);
	const folder = tp?.settings?.templates_folder?.trim() ?? "";
	if (folder === "" || folder === "/") {
		return true;
	}
	const norm = normalizePath(folder);
	const fp = normalizePath(file.path);
	return fp === norm || fp.startsWith(`${norm}/`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export type ApplyTemplateResult =
	| { ok: true }
	| { ok: false; reason: string };

/**
 * Applies a Templater template file to an existing note (same as Templater’s internal
 * folder-template path). Use when Bases view option “Sub-note Templater template” is set.
 */
export async function applyExplicitTemplaterTemplate(
	app: App,
	templatePath: string,
	targetFile: TFile,
	locale: PluginLocale,
): Promise<ApplyTemplateResult> {
	const trimmed = templatePath.trim();
	if (!trimmed) {
		return { ok: false, reason: "" };
	}

	const tp = getTemplaterPlugin(app);
	if (!tp?.templater?.write_template_to_file) {
		return {
			ok: false,
			reason: t(locale, "tplNotInstalled"),
		};
	}

	const norm = normalizePath(trimmed);
	let file = app.vault.getAbstractFileByPath(norm);
	if (!(file instanceof TFile)) {
		const withMd = norm.endsWith(".md") ? norm : normalizePath(`${norm}.md`);
		file = app.vault.getAbstractFileByPath(withMd);
	}
	if (!(file instanceof TFile)) {
		return {
			ok: false,
			reason: t(locale, "tplTemplateNotFound", { path: trimmed }),
		};
	}

	try {
		await tp.templater.write_template_to_file(file, targetFile);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			reason: t(locale, "tplTemplaterFailed", { msg }),
		};
	}

	await delay(80);
	return { ok: true };
}

/**
 * After `vault.create` with empty content, Templater may run `on_file_creation` (if
 * “Trigger Templater on new file creation” is on).
 *
 * Note: if “Folder templates” is enabled in Templater but the new note’s folder has no
 * matching rule, Templater returns without trying file regex templates or running
 * `overwrite_file_commands` — so nothing runs. Prefer an explicit template in the
 * Structure view options when that happens.
 */
export async function waitForAutomaticTemplaterOnFile(app: App, file: TFile): Promise<void> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings?.trigger_on_file_creation) {
		return;
	}

	const path = file.path;
	let settled = false;

	const ws = app.workspace as Workspace & {
		on(name: string, callback: (data: unknown) => void): import("obsidian").EventRef;
	};
	const vault = app.vault as Vault & {
		on(name: string, callback: (file: import("obsidian").TAbstractFile) => void): import("obsidian").EventRef;
	};

	await new Promise<void>((resolve) => {
		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		};

		const wNew = ws.on("templater:new-note-from-template", (data: unknown) => {
			const d = data as { file: TFile };
			if (d.file.path === path) finish();
		});
		const wOver = ws.on("templater:overwrite-file", (data: unknown) => {
			const d = data as { file: TFile };
			if (d.file.path === path) finish();
		});
		const vMod = vault.on("modified", (f) => {
			if (f.path === path) finish();
		});

		const safety = window.setTimeout(finish, 5000);

		function cleanup() {
			ws.offref(wNew);
			ws.offref(wOver);
			vault.offref(vMod);
			window.clearTimeout(safety);
		}
	});

	await delay(80);
}
