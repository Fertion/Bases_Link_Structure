import type { App } from "obsidian";

export const STANDARD_NATIVE_PROPERTY_TYPES = [
	"text",
	"multitext",
	"number",
	"checkbox",
	"date",
	"datetime",
	"tags",
	"aliases",
	"cssclasses",
] as const;

export type StandardNativePropertyType = (typeof STANDARD_NATIVE_PROPERTY_TYPES)[number];

export interface NativePropertyWidgetContext {
	app: App;
	key: string;
	sourcePath: string;
	onChange: (value: unknown) => void;
	blur: () => void;
}

export interface NativePropertyWidget {
	icon?: string;
	render?: (container: HTMLElement, value: unknown, ctx: NativePropertyWidgetContext) => unknown;
}

type MetadataTypeManager = {
	registeredTypeWidgets?: Record<string, NativePropertyWidget | undefined>;
	getAllProperties?: () => Record<string, { name?: unknown; widget?: unknown } | undefined>;
	getAssignedWidget?: (key: string) => unknown;
	getTypeInfo?: (
		key: string,
		value?: unknown,
	) => { expected?: { type?: unknown }; inferred?: { type?: unknown } } | undefined;
};

const STANDARD_TYPE_SET: ReadonlySet<string> = new Set(STANDARD_NATIVE_PROPERTY_TYPES);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function getMetadataTypeManager(app: App): MetadataTypeManager | null {
	return (app as unknown as { metadataTypeManager?: MetadataTypeManager }).metadataTypeManager ?? null;
}

export function getNativeWidgetForType(
	app: App,
	type: StandardNativePropertyType,
): NativePropertyWidget | null {
	const widget = getMetadataTypeManager(app)?.registeredTypeWidgets?.[type];
	return widget && typeof widget.render === "function" ? widget : null;
}

/** Fallback Lucide icons matching Obsidian / Bases table headers. */
const FALLBACK_TYPE_ICONS: Record<string, string> = {
	text: "lucide-text",
	multitext: "lucide-list",
	number: "lucide-hash",
	checkbox: "lucide-check-square",
	date: "lucide-calendar",
	datetime: "lucide-clock",
	tags: "lucide-tags",
	aliases: "lucide-forward",
	cssclasses: "lucide-paintbrush",
	file: "lucide-file",
	formula: "lucide-sigma",
};

/**
 * Icon id for a Bases property column header (same source as Properties / Bases table).
 */
export function getPropertyTypeIcon(app: App, propertyType: string, propertyName: string): string {
	if (propertyType === "file") {
		if (propertyName === "tags") return "lucide-tags";
		return "lucide-file";
	}
	if (propertyType === "formula") {
		return "lucide-sigma";
	}

	const type = resolveNativePropertyType(app, propertyName, undefined);
	const widget = getNativeWidgetForType(app, type);
	if (typeof widget?.icon === "string" && widget.icon.length > 0) {
		return widget.icon;
	}
	return FALLBACK_TYPE_ICONS[type] ?? "lucide-text";
}

function toStandardType(value: unknown): StandardNativePropertyType | null {
	if (typeof value !== "string") return null;
	if (!STANDARD_TYPE_SET.has(value)) return null;
	return value as StandardNativePropertyType;
}

function inferTypeFromValue(value: unknown): StandardNativePropertyType {
	if (Array.isArray(value)) return "multitext";
	if (typeof value === "boolean") return "checkbox";
	if (typeof value === "number" && Number.isFinite(value)) return "number";
	if (value instanceof Date) {
		const hasTime =
			value.getUTCHours() !== 0 ||
			value.getUTCMinutes() !== 0 ||
			value.getUTCSeconds() !== 0 ||
			value.getUTCMilliseconds() !== 0;
		return hasTime ? "datetime" : "date";
	}
	if (typeof value === "string") {
		if (DATETIME_RE.test(value)) return "datetime";
		if (DATE_RE.test(value)) return "date";
	}
	return "text";
}

/** Resolve Obsidian property type for a frontmatter key (vault types.json + value shape). */
export function resolveNativePropertyType(app: App, key: string, value: unknown): StandardNativePropertyType {
	const manager = getMetadataTypeManager(app);
	const widgets = manager?.registeredTypeWidgets;
	const normalizedKey = key.toLowerCase();

	if (normalizedKey === "tags" || normalizedKey === "tag") return "tags";
	if (normalizedKey === "aliases") return "aliases";
	if (normalizedKey === "cssclasses" && widgets?.cssclasses) return "cssclasses";

	if (manager) {
		const assigned = toStandardType(manager.getAssignedWidget?.(key));
		if (assigned) return assigned;

		try {
			const all = manager.getAllProperties?.();
			const infoType = toStandardType(all?.[key]?.widget ?? all?.[key.toLowerCase()]?.widget);
			if (infoType) return infoType;
		} catch {
			/* ignore */
		}

		try {
			const expected = toStandardType(
				manager.getTypeInfo?.(key, value)?.expected?.type ?? manager.getTypeInfo?.(key)?.expected?.type,
			);
			if (expected) return expected;
		} catch {
			/* ignore */
		}
	}

	return inferTypeFromValue(value);
}

export function emptyValueForType(type: StandardNativePropertyType): unknown {
	switch (type) {
		case "number":
			return null;
		case "checkbox":
			return false;
		case "multitext":
		case "tags":
		case "aliases":
		case "cssclasses":
			return [];
		case "text":
		case "date":
		case "datetime":
			return "";
	}
}

/** Read current frontmatter value for a note property key. */
export function readFrontmatterValue(app: App, filePath: string, key: string): unknown {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!file || !("path" in file)) return undefined;
	const cache = app.metadataCache.getFileCache(file as import("obsidian").TFile);
	const fm = cache?.frontmatter;
	if (!fm || !(key in fm)) return undefined;
	return fm[key];
}

export interface MountedNativeWidget {
	type: StandardNativePropertyType;
	destroy: () => void;
	focus: () => void;
	getValue: () => unknown;
}

/**
 * Mount Obsidian's native Properties widget into `hostEl`.
 * Falls back to a plain text input when the widget registry is unavailable.
 */
export function mountNativePropertyWidget(options: {
	app: App;
	hostEl: HTMLElement;
	key: string;
	sourcePath: string;
	value: unknown;
	type?: StandardNativePropertyType;
	onChange: (value: unknown) => void;
	onBlur?: () => void;
}): MountedNativeWidget {
	const { app, hostEl, key, sourcePath, onChange, onBlur } = options;
	const type = options.type ?? resolveNativePropertyType(app, key, options.value);
	let lastValue = options.value === undefined ? emptyValueForType(type) : options.value;
	const cleanups: Array<() => void> = [];
	let widgetInstance: unknown = null;

	hostEl.empty();
	hostEl.addClass("bases-structure-native-widget-host");

	const widget = getNativeWidgetForType(app, type);
	if (widget?.render) {
		try {
			widgetInstance = widget.render(hostEl, lastValue, {
				app,
				key,
				sourcePath,
				onChange: (changed: unknown) => {
					lastValue = changed;
					onChange(changed);
				},
				blur: () => {
					onBlur?.();
				},
			});
		} catch {
			mountTextFallback();
		}
	} else {
		mountTextFallback();
	}

	function mountTextFallback(): void {
		hostEl.empty();
		const inputEl = hostEl.createEl("input", {
			cls: "metadata-input metadata-input-text",
			type: "text",
		});
		inputEl.value =
			lastValue === null || lastValue === undefined
				? ""
				: Array.isArray(lastValue)
					? lastValue.map((item) => String(item)).join(", ")
					: typeof lastValue === "string" || typeof lastValue === "number" || typeof lastValue === "boolean"
						? String(lastValue)
						: "";
		const onInput = () => {
			lastValue = inputEl.value;
			onChange(inputEl.value);
		};
		const onInputBlur = () => onBlur?.();
		inputEl.addEventListener("input", onInput);
		inputEl.addEventListener("blur", onInputBlur);
		cleanups.push(() => {
			inputEl.removeEventListener("input", onInput);
			inputEl.removeEventListener("blur", onInputBlur);
		});
	}

	const destroy = () => {
		for (const cb of cleanups.splice(0)) {
			try {
				cb();
			} catch {
				/* ignore */
			}
		}
		closeWidgetLifecycle(widgetInstance);
		widgetInstance = null;
		hostEl.empty();
		hostEl.removeClass("bases-structure-native-widget-host");
	};

	const focus = () => {
		const focusable = hostEl.querySelector<HTMLElement>(
			"input, textarea, [contenteditable='true'], select, button",
		);
		if (!focusable) return;
		focusable.focus();
		if (focusable.instanceOf(HTMLInputElement) && focusable.type === "text") {
			focusable.select();
		}
	};

	return {
		type,
		destroy,
		focus,
		getValue: () => lastValue,
	};
}

function closeWidgetLifecycle(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const owner = value as {
		close?: () => void;
		destroy?: () => void;
		unload?: () => void;
	};
	for (const method of ["close", "destroy", "unload"] as const) {
		const fn = owner[method];
		if (typeof fn === "function") {
			try {
				fn.call(value);
			} catch {
				/* ignore */
			}
		}
	}
}
