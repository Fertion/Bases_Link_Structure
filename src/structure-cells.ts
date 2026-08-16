import {
	App,
	BasesEntry,
	BasesPropertyId,
	NullValue,
	TFile,
	parsePropertyId,
} from "obsidian";
import {
	emptyValueForType,
	mountNativePropertyWidget,
	readFrontmatterValue,
	resolveNativePropertyType,
	type MountedNativeWidget,
	type StandardNativePropertyType,
} from "./native-property-widget";

export interface StructureColumnModel {
	treePropertyId: BasesPropertyId | null;
	tablePropertyIds: BasesPropertyId[];
	/** Full Bases order (tree first + table columns). */
	order: BasesPropertyId[];
}

export function splitVisibleProperties(order: BasesPropertyId[]): StructureColumnModel {
	if (order.length === 0) {
		return { treePropertyId: null, tablePropertyIds: [], order: [] };
	}
	return {
		treePropertyId: order[0]!,
		tablePropertyIds: order.slice(1),
		order: [...order],
	};
}

export function parseBasesPropertyKey(propertyId: BasesPropertyId): {
	type: string;
	name: string;
} {
	try {
		const parsed = parsePropertyId(propertyId);
		return { type: parsed.type, name: parsed.name };
	} catch {
		const dot = propertyId.indexOf(".");
		if (dot < 0) return { type: "note", name: propertyId };
		return { type: propertyId.slice(0, dot), name: propertyId.slice(dot + 1) };
	}
}

/** Label for the tree column (first Bases property). Does not substitute basename for other properties. */
export function formatTreeLabel(entry: BasesEntry, treePropertyId: BasesPropertyId | null): string {
	if (!treePropertyId) {
		return entry.file.basename;
	}
	const { type, name } = parseBasesPropertyKey(treePropertyId);
	if (type === "file" && (name === "name" || name === "basename")) {
		return entry.file.basename;
	}
	const value = entry.getValue(treePropertyId);
	if (value == null || value instanceof NullValue) {
		return "";
	}
	return value.toString().trim();
}

/** Text used for local filter matching across visible columns. */
export function formatEntryFilterText(entry: BasesEntry, propertyIds: BasesPropertyId[]): string {
	const parts: string[] = [entry.file.basename, entry.file.path];
	for (const id of propertyIds) {
		const value = entry.getValue(id);
		if (value == null || value instanceof NullValue) continue;
		const s = value.toString().trim();
		if (s.length > 0) parts.push(s);
	}
	return parts.join("\n");
}

export function defaultColumnWidth(app: App, propertyId: BasesPropertyId): number {
	const { type, name } = parseBasesPropertyKey(propertyId);
	if (type === "file" && name === "name") return 280;
	if (type === "note") {
		const widgetType = resolveNativePropertyType(app, name, undefined);
		switch (widgetType) {
			case "checkbox":
				return 42;
			case "date":
				return 122;
			case "datetime":
				return 160;
			case "number":
				return 80;
			default:
				return 140;
		}
	}
	return 140;
}

export function resolveColumnWidth(
	app: App,
	propertyId: BasesPropertyId,
	columnSize: Record<string, number>,
): number {
	const raw = columnSize[propertyId];
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.max(40, Math.round(raw));
	}
	return defaultColumnWidth(app, propertyId);
}

export async function writeNoteProperty(
	app: App,
	file: TFile,
	propertyKey: string,
	value: unknown,
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		const frontmatter = fm as Record<string, unknown>;
		if (value === undefined || value === null) {
			delete frontmatter[propertyKey];
			return;
		}
		if (typeof value === "string" && value.trim() === "") {
			delete frontmatter[propertyKey];
			return;
		}
		if (Array.isArray(value) && value.length === 0) {
			delete frontmatter[propertyKey];
			return;
		}
		frontmatter[propertyKey] = value;
	});
}

export interface CellController {
	destroy: (opts?: { silent?: boolean }) => void;
	isFocused: () => boolean;
}

export interface RenderPropertyCellOptions {
	app: App;
	cellEl: HTMLElement;
	entry: BasesEntry;
	propertyId: BasesPropertyId;
	/** True while a widget inside this cell has focus (suppress full re-render). */
	onFocusChange?: (focused: boolean) => void;
	/** About to write frontmatter (so the view can briefly ignore data updates). */
	onBeforeWrite?: () => void;
}

/**
 * Render a property cell. Note properties always mount Obsidian's native widget
 * (Bases table style). File/formula properties are display-only via Value.renderTo.
 */
export function renderPropertyCell(options: RenderPropertyCellOptions): CellController {
	const { app, cellEl, entry, propertyId } = options;
	const { type: propType, name: propKey } = parseBasesPropertyKey(propertyId);
	const editable = propType === "note";
	let mounted: MountedNativeWidget | null = null;
	let writeTimer: number | undefined;
	let destroyed = false;
	let focused = false;

	cellEl.empty();
	cellEl.toggleClass("is-editable", editable);
	cellEl.toggleClass("is-readonly", !editable);
	cellEl.setAttr("data-property-id", propertyId);

	const setFocused = (next: boolean) => {
		if (focused === next) return;
		focused = next;
		cellEl.toggleClass("is-focused", focused);
		options.onFocusChange?.(focused);
	};

	const destroyMounted = () => {
		mounted?.destroy();
		mounted = null;
	};

	let dirty = false;

	const commitValue = async (value: unknown) => {
		const file = entry.file;
		if (!(file instanceof TFile)) return;
		options.onBeforeWrite?.();
		await writeNoteProperty(app, file, propKey, value);
	};

	const flushCommit = () => {
		if (!dirty) return;
		dirty = false;
		void commitValue(mounted?.getValue());
	};

	const seedValueForWidget = (): { type: StandardNativePropertyType; value: unknown } => {
		const fmValue = readFrontmatterValue(app, entry.file.path, propKey);
		const type = resolveNativePropertyType(app, propKey, fmValue);
		if (fmValue === undefined) {
			const basesValue = entry.getValue(propertyId);
			if (basesValue != null && !(basesValue instanceof NullValue)) {
				if (type === "checkbox") {
					return { type, value: basesValue.isTruthy() };
				}
				return { type, value: basesValue.toString() };
			}
			return { type, value: emptyValueForType(type) };
		}
		return { type, value: fmValue };
	};

	const onFocusIn = () => setFocused(true);
	const onFocusOut = (evt: FocusEvent) => {
		const next = evt.relatedTarget;
		if (next instanceof Node && cellEl.contains(next)) return;
		setFocused(false);
		flushCommit();
	};

	/** Enter commits and leaves the cell (Bases table behaviour for single-line values). */
	const onKeyDown = (evt: KeyboardEvent) => {
		if (evt.key !== "Enter" || evt.shiftKey || evt.isComposing) return;

		const target = evt.target as HTMLElement;
		const inListEditor = Boolean(target.closest(".multi-select-container"));
		const isTextarea = target instanceof HTMLTextAreaElement;

		// List / tags chips: Enter confirms a pill — let the native widget handle it.
		if (inListEditor || isTextarea) {
			evt.stopPropagation();
			return;
		}

		evt.preventDefault();
		evt.stopPropagation();
		flushCommit();
		if (typeof target.blur === "function") {
			target.blur();
		}
	};

	if (editable) {
		const { type, value } = seedValueForWidget();
		cellEl.setAttr("data-property-type", type);
		cellEl.addClass("metadata-property-value");
		if (type === "checkbox") {
			cellEl.addClass("is-checkbox");
		}

		const host = cellEl.createDiv({
			cls: "bases-structure-cell-editor bases-structure-table-cell",
		});
		mounted = mountNativePropertyWidget({
			app,
			hostEl: host,
			key: propKey,
			sourcePath: entry.file.path,
			value,
			type,
			onChange: (changed) => {
				dirty = true;
				if (type === "checkbox") {
					dirty = false;
					void commitValue(changed);
					return;
				}
				// Date pickers apply a finished value — safe to persist immediately.
				if (type === "date" || type === "datetime") {
					flushCommit();
				}
				// text / number / lists: keep dirty until Enter or blur (avoids cursor jump).
			},
		});

		cellEl.addEventListener("focusin", onFocusIn);
		cellEl.addEventListener("focusout", onFocusOut);
		cellEl.addEventListener("keydown", onKeyDown);
	} else {
		const value = entry.getValue(propertyId);
		const displayEl = cellEl.createDiv({
			cls: "bases-structure-cell-display bases-structure-table-cell",
		});
		if (value == null || value instanceof NullValue) {
			displayEl.createSpan({ cls: "bases-structure-cell-empty", text: "" });
		} else {
			try {
				value.renderTo(displayEl, app.renderContext);
			} catch {
				displayEl.setText(value.toString());
			}
		}
	}

	return {
		destroy: (opts?: { silent?: boolean }) => {
			destroyed = true;
			cellEl.removeEventListener("focusin", onFocusIn);
			cellEl.removeEventListener("focusout", onFocusOut);
			cellEl.removeEventListener("keydown", onKeyDown);
			if (!opts?.silent) {
				flushCommit();
			}
			destroyMounted();
			if (!opts?.silent && focused) {
				setFocused(false);
			} else {
				focused = false;
				cellEl.removeClass("is-focused");
			}
			void destroyed;
		},
		isFocused: () => focused,
	};
}
