import {
	App,
	BasesEntry,
	BasesPropertyId,
	BasesView,
	LinkValue,
	ListValue,
	NullValue,
	QueryController,
	TFile,
	Value,
	ViewOption,
	Notice,
	Menu,
	setIcon,
} from "obsidian";
import { getPluginLocale, t, type PluginLocale } from "./i18n";
import type BasesStructurePlugin from "./main";
import { openRenameNoteModal } from "./rename-note-modal";
import {
	applyExplicitTemplaterTemplate,
	subNoteTemplateFileFilter,
	waitForAutomaticTemplaterOnFile,
} from "./templater-subnote";
import {
	formatEntryFilterText,
	formatTreeLabel,
	parseBasesPropertyKey,
	renderPropertyCell,
	resolveColumnWidth,
	splitVisibleProperties,
	type CellController,
	type StructureColumnModel,
} from "./structure-cells";
import { getPropertyTypeIcon } from "./native-property-widget";

type ParentPath = string | null;

interface TreeNode {
	entry: BasesEntry;
	filePath: string;
	parentPath: ParentPath;
	children: TreeNode[];
	depth: number;
	descendantCount: number;
	branchKey: string;
}

interface VisibleRowRef {
	branchKey: string;
	filePath: string;
	parentPath: ParentPath;
	depth: number;
}

interface DragSourceItem {
	filePath: string;
	parentPath: ParentPath;
}

interface DragState {
	sources: DragSourceItem[];
	isCopyMode: boolean;
}

const VIEW_TYPE = "structure";
const DEFAULT_RELATION_PROPERTY = "up";
/** Passed to `file-menu` so plugins can tell this view from e.g. File explorer. */
const FILE_MENU_SOURCE = "bases-structure";

export class StructureView extends BasesView {
	type = VIEW_TYPE;
	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	plugin: BasesStructurePlugin;

	/** Expanded state per tree row (`branchKey`), not file path — same note can appear under several parents. */
	private expandedBranchKeys = new Set<string>();
	private dragState: DragState | null = null;
	/** Row that started the current drag (for dragend cleanup if target is not the row). */
	private dragSourceRowEl: HTMLElement | null = null;
	private lastDragPointerClientY = 0;
	private dragAutoScrollRafId: number | undefined;
	/** Row currently shown as drop target; avoids querySelectorAll on every dragover. */
	private dropHighlightRowEl: HTMLElement | null = null;
	private relationProperty = DEFAULT_RELATION_PROPERTY;
	private isCtrlPressed = false;
	/** Local tree filter (does not use Bases query — keeps full entry set). */
	private filterQuery = "";
	private searchDebounceHandle: number | undefined;
	private toolbarEl: HTMLElement | null = null;
	/** Scroll host for header + tree (`.bases-structure-tree-scroll`). */
	private treeScrollEl: HTMLElement | null = null;
	/** Sticky column header row above the tree. */
	private headerEl: HTMLElement | null = null;
	private treeMountEl: HTMLElement | null = null;
	/** Latest Bases column split (tree first, rest as table). */
	private columnModel: StructureColumnModel = {
		treePropertyId: null,
		tablePropertyIds: [],
		order: [],
	};
	/** Pixel widths from Bases `columnSize` (and live resize). */
	private columnWidths = new Map<BasesPropertyId, number>();
	/**
	 * Local column order override. Bases `config.set("order")` does not reliably update
	 * {@link BasesViewConfig.getOrder}, so drag-reorder is applied here and merged with Bases.
	 */
	private columnOrderOverride: BasesPropertyId[] | null = null;
	private lastBasesOrderKey = "";
	private ignoreNextBasesOrderChange = false;
	/** Active property cell controllers (destroyed on each full render). */
	private cellControllers: CellController[] = [];
	/** Focused editable cells — suppresses full re-render from our own writes. */
	private focusedCellCount = 0;
	private pendingRenderWhileFocused = false;
	private columnResizeState: {
		propertyId: BasesPropertyId;
		startX: number;
		startWidth: number;
	} | null = null;
	private headerDragPropertyId: BasesPropertyId | null = null;
	private searchWrapEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchClearBtn: HTMLButtonElement | null = null;
	private toolbarExpandBtn: HTMLButtonElement | null = null;
	private toolbarCollapseBtn: HTMLButtonElement | null = null;
	private toolbarRevealBtn: HTMLButtonElement | null = null;
	/** Latest tree from last render; used by toolbar actions wired once. */
	private lastBuiltTree: TreeNode[] = [];
	/** Visible rows in tree order (for Shift+range selection). */
	private visibleRowOrder: VisibleRowRef[] = [];
	/** Selected tree positions (`branchKey` is unique per row). */
	private selectedBranchKeys = new Set<string>();
	/** Anchor for the next Shift+click range (set on plain row click). */
	private selectionAnchorBranchKey: string | null = null;
	/** Memo for `shouldShowNodeInFilter` during one render (filter active). */
	private filterVisibilityCache: Map<string, boolean> | null = null;
	private dataUpdateDebounceHandle: number | undefined;
	/** Coalesced connector layout after render / resize. */
	private treeConnectorLayoutRaf: number | undefined;
	private treeLayoutObserver: ResizeObserver | null = null;
	/** Next occurrence index for "Show active file" (cycles; reset when active note path changes). */
	private showActiveFileNextOccurrenceIndex = 0;
	private lastActiveFilePathForRevealCycle: string | null = null;
	/** Path last reflected in row `is-active-file` (for incremental updates on tab change). */
	private lastPaintedActiveFilePath = "";

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: BasesStructurePlugin) {
		super(controller);
		this.scrollEl = scrollEl;
		this.scrollEl.addClass("bases-structure-host");
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: "bases-structure-container" });
	}

	onload(): void {
		this.plugin.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshActiveFileHighlightFromWorkspace();
			}),
		);
		/** Same-leaf file switches do not always fire `active-leaf-change`; keep row highlight in sync. */
		this.plugin.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.refreshActiveFileHighlightFromWorkspace();
			}),
		);

		this.plugin.registerDomEvent(this.containerEl, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			const spine = target.closest(".bases-structure-spine");
			if (spine) {
				evt.preventDefault();
				evt.stopPropagation();
				const parentKey = spine.getAttr("data-branch-key");
				if (parentKey) {
					this.expandedBranchKeys.delete(parentKey);
					this.render();
				}
				return;
			}
			if (target.closest(".bases-structure-toggle")) return;
			if (target.closest(".bases-structure-cell")) return;
			if (target.closest(".bases-structure-header")) return;

			const row = target.closest(".bases-structure-row");
			if (!row) return;

			const branchKey = row.getAttr("data-branch-key");
			if (!branchKey) return;

			if (target.closest("a.internal-link")) return;

			if (evt.shiftKey) {
				evt.preventDefault();
				this.applyShiftRangeSelection(branchKey);
				this.render();
				return;
			}

			this.selectionAnchorBranchKey = branchKey;
			this.selectedBranchKeys.clear();

			const hasChildren = row.getAttr("data-has-children") === "true";
			if (hasChildren) {
				this.toggleExpanded(branchKey);
			}
			this.render();
		});

		this.plugin.registerDomEvent(this.containerEl, "contextmenu", (evt: MouseEvent) => {
			const row = (evt.target as HTMLElement).closest(
				".bases-structure-row",
			);
			if (!row) return;
			const path = row.getAttr("data-file-path");
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			this.app.workspace.trigger("file-menu", menu, file, FILE_MENU_SOURCE);
			menu.addSeparator();
			const loc = getPluginLocale();
			menu.addItem((item) =>
				item
					.setTitle(t(loc, "menuRename"))
					.setIcon("pencil")
					.onClick(() => {
						openRenameNoteModal(this.app, file);
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle(t(loc, "menuDeleteFile"))
					.setIcon("trash")
					.setWarning(true)
					.onClick(() => {
						void this.app.fileManager.promptForDeletion(file);
					}),
			);
			menu.addSeparator();
			const parentBranchKey = row.getAttr("data-branch-key") ?? "";
			menu.addItem((item) =>
				item
					.setTitle(t(loc, "menuCreateSubNote"))
					.setIcon("file-plus")
					.onClick(() => {
						void this.createSubNoteUnder(file, parentBranchKey);
					}),
			);
			this.addChild(menu);
			menu.showAtMouseEvent(evt);
		});

		this.plugin.registerDomEvent(this.containerEl, "keydown", (evt: KeyboardEvent) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			const spine = (evt.target as HTMLElement).closest(
				".bases-structure-spine",
			);
			if (!spine) return;
			evt.preventDefault();
			const parentKey = spine.getAttr("data-branch-key");
			if (parentKey) {
				this.expandedBranchKeys.delete(parentKey);
				this.render();
			}
		});

		this.registerDelegatedTreeDragDrop();
	}

	/** One listener set for the whole tree; avoids per-row addEventListener on every render. */
	private registerDelegatedTreeDragDrop(): void {
		this.plugin.registerDomEvent(this.containerEl, "dragstart", (evt: DragEvent) => {
			this.stopDragAutoScroll();
			const target = evt.target as HTMLElement;
			if (target.closest(".bases-structure-header")) {
				return;
			}
			if (target.closest(".bases-structure-cell")) {
				evt.preventDefault();
				return;
			}
			const rowEl = target.closest(".bases-structure-row");
			if (!(rowEl instanceof HTMLElement) || !evt.dataTransfer) return;
			const row = rowEl;

			const branchKey = row.getAttr("data-branch-key");
			const filePath = row.getAttr("data-file-path");
			const parentPathRaw = row.getAttr("data-parent-path");
			if (!branchKey || !filePath) return;

			const parentPath: ParentPath =
				parentPathRaw && parentPathRaw.length > 0 ? parentPathRaw : null;

			const fromSelection =
				this.selectedBranchKeys.has(branchKey) && this.selectedBranchKeys.size > 0;
			let sources: DragSourceItem[] = this.visibleRowOrder
				.filter((r) => this.selectedBranchKeys.has(r.branchKey))
				.map((r) => ({ filePath: r.filePath, parentPath: r.parentPath }));
			if (!fromSelection) {
				this.selectedBranchKeys.clear();
				sources = [{ filePath, parentPath }];
			}
			sources = this.dedupeDragSources(sources);
			if (sources.length === 0) {
				sources = [{ filePath, parentPath }];
			}
			this.dragState = {
				sources,
				isCopyMode: evt.ctrlKey,
			};
			this.isCtrlPressed = evt.ctrlKey;
			evt.dataTransfer.effectAllowed = "copyMove";
			this.setNoteDragPlainText(evt.dataTransfer, sources);
			row.addClass("is-dragging");
			this.dragSourceRowEl = row;
		});

		this.plugin.registerDomEvent(this.containerEl, "dragend", (evt: DragEvent) => {
			const rowEl =
				(evt.target as HTMLElement).closest(".bases-structure-row") ??
				this.dragSourceRowEl;
			this.stopDragAutoScroll();
			this.dragState = null;
			this.isCtrlPressed = false;
			this.clearDropHighlights();
			if (rowEl instanceof HTMLElement) {
				rowEl.removeClass("is-dragging");
			}
			this.dragSourceRowEl = null;
		});

		this.plugin.registerDomEvent(this.containerEl, "dragover", (evt: DragEvent) => {
			if ((evt.target as HTMLElement).closest(".bases-structure-header")) {
				return;
			}
			if (!this.dragState) return;
			this.isCtrlPressed = evt.ctrlKey;
			this.lastDragPointerClientY = evt.clientY;
			if (this.wouldDragScrollChangeScrollTop()) {
				this.ensureDragAutoScrollLoop();
			}

			const rowEl = (evt.target as HTMLElement).closest(".bases-structure-row");
			const row = rowEl instanceof HTMLElement ? rowEl : null;
			const overTreeScroll =
				this.treeScrollEl?.contains(evt.target as Node) ?? false;
			if (row) {
				evt.preventDefault();
				if (evt.dataTransfer) {
					evt.dataTransfer.dropEffect = this.isCtrlPressed ? "copy" : "move";
				}
				if (this.dropHighlightRowEl !== row) {
					this.dropHighlightRowEl?.removeClass("is-drop-target");
					this.dropHighlightRowEl = row;
					row.addClass("is-drop-target");
				}
			} else if (overTreeScroll) {
				evt.preventDefault();
				if (evt.dataTransfer) {
					evt.dataTransfer.dropEffect = this.isCtrlPressed ? "copy" : "move";
				}
			}
		});

		this.plugin.registerDomEvent(this.containerEl, "dragleave", (evt: DragEvent) => {
			if (!this.dragState) return;
			const rowEl = (evt.target as HTMLElement).closest(".bases-structure-row");
			if (!(rowEl instanceof HTMLElement)) return;
			const row = rowEl;
			const related = evt.relatedTarget as HTMLElement | null;
			if (related && row.contains(related)) return;
			row.removeClass("is-drop-target");
			if (this.dropHighlightRowEl === row) {
				this.dropHighlightRowEl = null;
			}
		});

		this.plugin.registerDomEvent(this.containerEl, "drop", (evt: DragEvent) => {
			if ((evt.target as HTMLElement).closest(".bases-structure-header")) {
				return;
			}
			const rowEl = (evt.target as HTMLElement).closest(".bases-structure-row");
			if (!(rowEl instanceof HTMLElement)) return;
			const row = rowEl;
			const filePath = row.getAttr("data-file-path");
			const branchKey = row.getAttr("data-branch-key");
			if (!filePath || !branchKey) return;
			evt.preventDefault();
			const copyMode = evt.ctrlKey || this.isCtrlPressed || this.dragState?.isCopyMode === true;
			void this.handleDropOnFile(filePath, branchKey, copyMode);
		});
	}

	/**
	 * Clipboard payload when dragging notes into the editor: wikilink or Markdown link per vault settings
	 * (see {@link FileManager.generateMarkdownLink}), not a raw path or `app://` URL.
	 */
	private setNoteDragPlainText(dataTransfer: DataTransfer, sources: DragSourceItem[]): void {
		const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";
		const lines: string[] = [];
		for (const s of sources) {
			const file = this.app.vault.getAbstractFileByPath(s.filePath);
			if (file instanceof TFile) {
				lines.push(this.app.fileManager.generateMarkdownLink(file, sourcePath));
			} else {
				lines.push(s.filePath);
			}
		}
		dataTransfer.setData("text/plain", lines.join("\n"));
	}

	/** Pixels to add to `scrollTop` this frame (negative = up), or 0 if pointer outside edge bands. */
	private computeDragScrollStepPx(): number {
		const el = this.treeScrollEl;
		if (!el || !this.dragState) return 0;
		const rect = el.getBoundingClientRect();
		const zone = 48;
		const y = this.lastDragPointerClientY;
		if (y < rect.top + zone) {
			const k = Math.min(1, (rect.top + zone - y) / zone);
			return -Math.max(2, Math.round(2 + k * 14));
		}
		if (y > rect.bottom - zone) {
			const k = Math.min(1, (y - (rect.bottom - zone)) / zone);
			return Math.max(2, Math.round(2 + k * 14));
		}
		return 0;
	}

	private wouldDragScrollChangeScrollTop(): boolean {
		const el = this.treeScrollEl;
		if (!el || !this.dragState) return false;
		const delta = this.computeDragScrollStepPx();
		if (delta === 0) return false;
		const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
		const next = Math.max(0, Math.min(maxScroll, el.scrollTop + delta));
		return next !== el.scrollTop;
	}

	private ensureDragAutoScrollLoop(): void {
		if (this.dragAutoScrollRafId != null) return;
		if (!this.wouldDragScrollChangeScrollTop()) return;
		const step = (): void => {
			this.dragAutoScrollRafId = undefined;
			if (!this.dragState || !this.treeScrollEl) return;
			const el = this.treeScrollEl;
			const delta = this.computeDragScrollStepPx();
			if (delta === 0) return;
			const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
			const prevTop = el.scrollTop;
			el.scrollTop = Math.max(0, Math.min(maxScroll, el.scrollTop + delta));
			if (el.scrollTop === prevTop) return;
			if (this.dragState && this.wouldDragScrollChangeScrollTop()) {
				this.dragAutoScrollRafId = window.requestAnimationFrame(step);
			}
		};
		this.dragAutoScrollRafId = window.requestAnimationFrame(step);
	}

	private stopDragAutoScroll(): void {
		if (this.dragAutoScrollRafId != null) {
			window.cancelAnimationFrame(this.dragAutoScrollRafId);
			this.dragAutoScrollRafId = undefined;
		}
	}

	onunload(): void {
		window.clearTimeout(this.searchDebounceHandle);
		window.clearTimeout(this.dataUpdateDebounceHandle);
		this.stopDragAutoScroll();
		this.destroyCellControllers();
		if (this.treeConnectorLayoutRaf != null) {
			window.cancelAnimationFrame(this.treeConnectorLayoutRaf);
			this.treeConnectorLayoutRaf = undefined;
		}
		this.treeLayoutObserver?.disconnect();
		this.treeLayoutObserver = null;
	}

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	public onDataUpdated(): void {
		if (this.focusedCellCount > 0 || this.columnResizeState) {
			this.pendingRenderWhileFocused = true;
			return;
		}
		window.clearTimeout(this.dataUpdateDebounceHandle);
		this.dataUpdateDebounceHandle = window.setTimeout(() => {
			this.dataUpdateDebounceHandle = undefined;
			this.render();
		}, 100);
	}

	private destroyCellControllers(): void {
		for (const c of this.cellControllers) {
			c.destroy({ silent: true });
		}
		this.cellControllers = [];
		this.focusedCellCount = 0;
	}

	private onCellFocusChange(focused: boolean): void {
		if (focused) {
			this.focusedCellCount++;
			return;
		}
		this.focusedCellCount = Math.max(0, this.focusedCellCount - 1);
		if (this.focusedCellCount === 0 && this.pendingRenderWhileFocused) {
			// Defer so focus moving cell→cell does not remount mid-click.
			window.setTimeout(() => {
				if (this.focusedCellCount === 0 && this.pendingRenderWhileFocused) {
					this.pendingRenderWhileFocused = false;
					this.render();
				}
			}, 0);
		}
	}

	private onBeforeCellWrite(): void {
		// Keep focus while Bases refreshes from our write.
		this.pendingRenderWhileFocused = true;
	}

	private getColumnSizeMap(): Record<string, number> {
		const raw: unknown = this.config?.get("columnSize");
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return {};
		}
		const out: Record<string, number> = {};
		for (const key of Object.keys(raw)) {
			const value: unknown = Reflect.get(raw, key);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				out[key] = value;
			}
		}
		return out;
	}

	private persistColumnSize(propertyId: BasesPropertyId, width: number): void {
		const sizes = this.getColumnSizeMap();
		sizes[propertyId] = Math.round(width);
		this.config.set("columnSize", sizes);
	}

	private persistPropertyOrder(order: BasesPropertyId[]): void {
		this.columnOrderOverride = [...order];
		this.ignoreNextBasesOrderChange = true;
		this.lastBasesOrderKey = order.join("\0");
		try {
			this.config.set("order", order);
		} catch {
			/* Bases may ignore unknown writes; local override still applies. */
		}
	}

	private syncColumnWidthsFromConfig(): void {
		const sizes = this.getColumnSizeMap();
		this.columnWidths.clear();
		for (const id of this.columnModel.order) {
			this.columnWidths.set(id, resolveColumnWidth(this.app, id, sizes));
		}
	}

	private render(): void {
		this.relationProperty = this.getRelationPropertyFromConfig();
		this.ensureToolbarShell();
		const loc = getPluginLocale();
		this.refreshToolbarI18n(loc);
		this.filterQuery = this.searchInputEl?.value ?? "";
		this.columnModel = splitVisibleProperties(this.getVisiblePropertyIds());
		this.syncColumnWidthsFromConfig();
		this.applyGridColumnTemplate();

		const treeMount = this.treeMountEl;
		if (!treeMount) return;

		this.destroyCellControllers();
		treeMount.empty();
		this.renderColumnHeader();
		this.lastPaintedActiveFilePath = "";

		const entries = this.getAllEntries();
		if (entries.length === 0) {
			this.lastBuiltTree = [];
			treeMount.createEl("p", {
				text: t(loc, "emptyNoEntries"),
				cls: "bases-structure-empty",
			});
			return;
		}

		const tree = this.buildTree(entries);
		this.lastBuiltTree = tree;

		if (tree.length === 0) {
			treeMount.createEl("p", {
				text: t(loc, "emptyNoRoots"),
				cls: "bases-structure-empty",
			});
			return;
		}

		const q = this.filterQuery.trim();
		const filterActive = q.length > 0;
		this.filterVisibilityCache = filterActive ? new Map() : null;
		if (filterActive) {
			const anyVisible = tree.some((root) => this.shouldShowNodeInFilter(root, false));
			if (!anyVisible) {
				treeMount.createEl("p", {
					text: t(loc, "emptyNoMatch", { q }),
					cls: "bases-structure-empty",
				});
				return;
			}
		}

		const activePath = this.app.workspace.getActiveFile()?.path ?? "";
		this.visibleRowOrder = [];
		for (const root of tree) {
			this.renderNode(treeMount, root, true, false, activePath, loc);
		}
		this.lastPaintedActiveFilePath = activePath;
		this.ensureTreeLayoutObserver();
		this.scheduleTreeConnectorLayout();
	}

	private applyGridColumnTemplate(): void {
		const scroll = this.treeScrollEl;
		if (!scroll) return;
		const cols = this.columnModel.order.map((id) => {
			const w = this.columnWidths.get(id) ?? resolveColumnWidth(this.app, id, {});
			return `${w}px`;
		});
		const template = cols.length > 0 ? cols.join(" ") : "minmax(220px, 1fr)";
		scroll.style.setProperty("--bases-structure-grid-cols", template);
		scroll.toggleClass("has-property-columns", this.columnModel.tablePropertyIds.length > 0);
	}

	private renderColumnHeader(): void {
		const header = this.headerEl;
		if (!header) return;
		header.empty();

		const order = this.columnModel.order;
		if (order.length === 0) {
			const treeHead = header.createDiv({ cls: "bases-structure-header-cell is-tree" });
			treeHead.createDiv({
				cls: "bases-structure-header-label",
				text: t(getPluginLocale(), "basesViewName"),
			});
			return;
		}

		order.forEach((propId, index) => {
			const isTree = index === 0;
			const cell = header.createDiv({
				cls: "bases-structure-header-cell" + (isTree ? " is-tree" : ""),
				attr: {
					"data-property-id": propId,
					draggable: "true",
				},
			});
			const labelWrap = cell.createDiv({ cls: "bases-structure-header-label-wrap" });
			const { type: propType, name: propName } = parseBasesPropertyKey(propId);
			const iconEl = labelWrap.createDiv({ cls: "bases-structure-header-icon" });
			setIcon(iconEl, getPropertyTypeIcon(this.app, propType, propName));
			labelWrap.createDiv({
				cls: "bases-structure-header-label",
				text: this.config.getDisplayName(propId),
			});
			const resizer = cell.createDiv({ cls: "bases-structure-header-resizer" });
			resizer.addEventListener("mousedown", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				this.beginColumnResize(propId, evt.clientX);
			});
			this.bindHeaderColumnDrag(cell, propId);
		});
	}

	private beginColumnResize(propertyId: BasesPropertyId, startX: number): void {
		const startWidth =
			this.columnWidths.get(propertyId) ?? resolveColumnWidth(this.app, propertyId, {});
		this.columnResizeState = { propertyId, startX, startWidth };
		this.treeScrollEl?.addClass("is-resizing-columns");

		const onMove = (evt: MouseEvent) => {
			if (!this.columnResizeState) return;
			const delta = evt.clientX - this.columnResizeState.startX;
			const next = Math.max(40, this.columnResizeState.startWidth + delta);
			this.columnWidths.set(this.columnResizeState.propertyId, next);
			this.applyGridColumnTemplate();
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			const state = this.columnResizeState;
			this.columnResizeState = null;
			this.treeScrollEl?.removeClass("is-resizing-columns");
			if (state) {
				const width = this.columnWidths.get(state.propertyId) ?? state.startWidth;
				this.persistColumnSize(state.propertyId, width);
			}
			if (this.pendingRenderWhileFocused && this.focusedCellCount === 0) {
				this.pendingRenderWhileFocused = false;
				this.render();
			}
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}

	private bindHeaderColumnDrag(cell: HTMLElement, propertyId: BasesPropertyId): void {
		cell.addEventListener("dragstart", (evt) => {
			if (this.columnResizeState) {
				evt.preventDefault();
				return;
			}
			evt.stopPropagation();
			this.headerDragPropertyId = propertyId;
			cell.addClass("is-dragging-header");
			if (evt.dataTransfer) {
				evt.dataTransfer.setData("text/plain", propertyId);
				evt.dataTransfer.setData("application/x-bases-structure-column", propertyId);
				evt.dataTransfer.effectAllowed = "move";
			}
		});
		cell.addEventListener("dragend", (evt) => {
			evt.stopPropagation();
			this.headerDragPropertyId = null;
			cell.removeClass("is-dragging-header");
			this.clearHeaderDropHighlights();
		});
		cell.addEventListener("dragover", (evt) => {
			const fromId =
				this.headerDragPropertyId ??
				(evt.dataTransfer?.types.includes("application/x-bases-structure-column")
					? "pending"
					: null);
			if (!fromId || this.headerDragPropertyId === propertyId) return;
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			this.clearHeaderDropHighlights();
			cell.addClass("is-drop-target-header");
		});
		cell.addEventListener("dragleave", (evt) => {
			if (!cell.contains(evt.relatedTarget as Node)) {
				cell.removeClass("is-drop-target-header");
			}
		});
		cell.addEventListener("drop", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			cell.removeClass("is-drop-target-header");
			const fromData =
				evt.dataTransfer?.getData("application/x-bases-structure-column") ||
				evt.dataTransfer?.getData("text/plain") ||
				"";
			const fromId = (this.headerDragPropertyId ?? fromData) as BasesPropertyId;
			this.headerDragPropertyId = null;
			if (!fromId || fromId === propertyId) return;
			if (!this.columnModel.order.includes(fromId)) return;
			const order = [...this.columnModel.order];
			const fromIdx = order.indexOf(fromId);
			const toIdx = order.indexOf(propertyId);
			if (fromIdx < 0 || toIdx < 0) return;
			order.splice(fromIdx, 1);
			order.splice(toIdx, 0, fromId);
			this.persistPropertyOrder(order);
			this.render();
		});
	}

	private clearHeaderDropHighlights(): void {
		const header = this.headerEl;
		if (!header) return;
		header.querySelectorAll(".is-drop-target-header").forEach((el) => {
			el.removeClass("is-drop-target-header");
		});
	}

	/**
	 * Updates which tree row is marked active for the current workspace note.
	 * Does not scroll: scrolling is reserved for explicit “Show active file” and reveal flows;
	 * otherwise focusing the bases pane (active-leaf-change) mimicked that button.
	 */
	private refreshActiveFileHighlightFromWorkspace(): void {
		const f = this.app.workspace.getActiveFile();
		const path = f?.path ?? "";
		if (path !== this.lastActiveFilePathForRevealCycle) {
			this.showActiveFileNextOccurrenceIndex = 0;
			this.lastActiveFilePathForRevealCycle = path;
		}
		this.syncActiveFileHighlight(false, "nearest");
	}

	/**
	 * Highlights rows whose `data-file-path` matches the editor’s active note.
	 * @returns hasMatch: any such row in the DOM; branchScrolled: if scrolling, the target row was found (see options.scrollToBranchKey).
	 */
	private syncActiveFileHighlight(
		scrollToRow: boolean,
		scrollBlock: ScrollLogicalPosition = "nearest",
		options?: { scrollToBranchKey?: string },
	): { hasMatch: boolean; branchScrolled: boolean } {
		const path = this.app.workspace.getActiveFile()?.path ?? "";
		this.patchActiveFileHighlightInDom(path);
		const pathMatches = this.queryRowElsByFilePath(path);
		const hasMatch = pathMatches.length > 0;
		let branchScrolled = true;
		if (scrollToRow) {
			let scrollTarget: HTMLElement | null = null;
			const branchKey = options?.scrollToBranchKey;
			if (branchKey) {
				scrollTarget =
					pathMatches.find((r) => r.getAttr("data-branch-key") === branchKey) ?? null;
				branchScrolled = scrollTarget !== null;
			} else {
				scrollTarget = pathMatches[0] ?? null;
				branchScrolled = scrollTarget !== null;
			}
			scrollTarget?.scrollIntoView({ block: scrollBlock, inline: "nearest" });
		}
		return { hasMatch, branchScrolled };
	}

	private activeRowSelectorForPath(filePath: string): string {
		return `.bases-structure-row[data-file-path="${CSS.escape(filePath)}"]`;
	}

	private queryRowElsByFilePath(filePath: string): HTMLElement[] {
		const tm = this.treeMountEl;
		if (!filePath || !tm) return [];
		return Array.from(tm.querySelectorAll(this.activeRowSelectorForPath(filePath)));
	}

	/** Update row classes when the active file changed without a full `render()`. */
	private patchActiveFileHighlightInDom(newPath: string): void {
		const tm = this.treeMountEl;
		if (!tm) return;
		const oldPath = this.lastPaintedActiveFilePath;
		if (oldPath && oldPath !== newPath) {
			Array.from(tm.querySelectorAll(this.activeRowSelectorForPath(oldPath))).forEach((el) => {
				(el as HTMLElement).removeClass("is-active-file");
			});
		}
		if (newPath && newPath !== oldPath) {
			Array.from(tm.querySelectorAll(this.activeRowSelectorForPath(newPath))).forEach((el) => {
				(el as HTMLElement).addClass("is-active-file");
			});
		}
		this.lastPaintedActiveFilePath = newPath;
	}

	private ensureToolbarShell(): void {
		if (this.toolbarEl && this.treeMountEl) return;

		const toolbar = this.containerEl.createDiv({ cls: "bases-structure-toolbar" });
		this.toolbarEl = toolbar;

		const toolbarLeft = toolbar.createDiv({ cls: "bases-structure-toolbar-left" });

		const expandBtn = toolbarLeft.createEl("button", {
			cls: "bases-structure-toolbar-btn",
			attr: { type: "button" },
		});
		this.toolbarExpandBtn = expandBtn;
		setIcon(expandBtn, "unfold-vertical");

		const collapseBtn = toolbarLeft.createEl("button", {
			cls: "bases-structure-toolbar-btn",
			attr: { type: "button" },
		});
		this.toolbarCollapseBtn = collapseBtn;
		setIcon(collapseBtn, "fold-vertical");

		expandBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.expandAllFromTree(this.lastBuiltTree);
			this.render();
		});

		collapseBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.expandedBranchKeys.clear();
			this.render();
		});

		const revealActiveBtn = toolbarLeft.createEl("button", {
			cls: "bases-structure-toolbar-btn",
			attr: { type: "button" },
		});
		this.toolbarRevealBtn = revealActiveBtn;
		setIcon(revealActiveBtn, "scan-search");
		revealActiveBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			this.revealAndScrollToActiveFile();
		});

		const searchWrap = toolbar.createDiv({ cls: "bases-structure-search-wrap" });
		this.searchWrapEl = searchWrap;

		const searchInput = searchWrap.createEl("input", {
			cls: "bases-structure-search",
			type: "search",
			attr: {
				spellcheck: "false",
			},
		});
		this.searchInputEl = searchInput;

		const clearBtn = searchWrap.createEl("button", {
			cls: "bases-structure-search-clear clickable-icon",
			attr: { type: "button" },
		});
		this.searchClearBtn = clearBtn;
		setIcon(clearBtn, "x");

		clearBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			searchInput.value = "";
			this.filterQuery = "";
			this.updateSearchAdornments();
			this.render();
			window.requestAnimationFrame(() => searchInput.focus());
		});

		searchInput.addEventListener("input", () => {
			this.filterQuery = searchInput.value;
			this.updateSearchAdornments();
			window.clearTimeout(this.searchDebounceHandle);
			this.searchDebounceHandle = window.setTimeout(() => {
				this.render();
			}, 120);
		});
		searchInput.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape") {
				evt.stopPropagation();
				searchInput.value = "";
				this.filterQuery = "";
				this.updateSearchAdornments();
				this.render();
			}
		});

		const treeScroll = this.containerEl.createDiv({ cls: "bases-structure-tree-scroll" });
		this.treeScrollEl = treeScroll;
		this.headerEl = treeScroll.createDiv({ cls: "bases-structure-header" });
		this.treeMountEl = treeScroll.createDiv({ cls: "bases-structure-tree" });
		this.ensureTreeLayoutObserver();
	}

	private refreshToolbarI18n(locale: PluginLocale): void {
		const ex = this.toolbarExpandBtn;
		if (ex) {
			ex.setAttr("aria-label", t(locale, "expandAllAria"));
			ex.removeAttribute("title");
		}
		const col = this.toolbarCollapseBtn;
		if (col) {
			col.setAttr("aria-label", t(locale, "collapseAllAria"));
			col.removeAttribute("title");
		}
		const rev = this.toolbarRevealBtn;
		if (rev) {
			rev.setAttr("aria-label", t(locale, "showActiveFileAria"));
			rev.removeAttribute("title");
		}
		const search = this.searchInputEl;
		if (search) {
			search.setAttr("placeholder", t(locale, "filterPlaceholder"));
			search.setAttr("aria-label", t(locale, "filterAria"));
		}
		const clear = this.searchClearBtn;
		if (clear) {
			clear.setAttr("aria-label", t(locale, "clearFilterAria"));
		}
	}

	/** Observe tree size so connector segments stay aligned after layout changes. */
	private ensureTreeLayoutObserver(): void {
		const mount = this.treeMountEl;
		if (!mount) return;
		if (this.treeLayoutObserver) return;
		this.treeLayoutObserver = new ResizeObserver(() => {
			this.scheduleTreeConnectorLayout();
		});
		this.plugin.register(() => {
			this.treeLayoutObserver?.disconnect();
			this.treeLayoutObserver = null;
		});
		this.treeLayoutObserver.observe(mount);
	}

	private scheduleTreeConnectorLayout(): void {
		if (this.treeConnectorLayoutRaf != null) return;
		this.treeConnectorLayoutRaf = window.requestAnimationFrame(() => {
			this.treeConnectorLayoutRaf = undefined;
			this.layoutTreeConnectors();
		});
	}

	/**
	 * Positions each `.bases-structure-spine` so the vertical runs from the parent row
	 * center to the last *direct* child row center only (no tail through deeper subtrees).
	 */
	private layoutTreeConnectors(): void {
		const mount = this.treeMountEl;
		if (!mount) return;
		const blocks = mount.querySelectorAll(".bases-structure-children");
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i] as HTMLElement;
			const spineEl = block.querySelector(":scope > .bases-structure-spine");
			if (!(spineEl instanceof HTMLElement)) continue;

			const parentItem = block.parentElement;
			const parentRowEl =
				parentItem?.matches(".bases-structure-item") === true
					? parentItem.querySelector(":scope > .bases-structure-row")
					: null;
			const childItems = block.querySelectorAll(":scope > .bases-structure-item");
			if (!(parentRowEl instanceof HTMLElement) || childItems.length === 0) {
				spineEl.style.top = `${0}px`;
				spineEl.style.height = `${0}px`;
				continue;
			}

			const lastItem = childItems[childItems.length - 1] as HTMLElement;
			const lastRowEl = lastItem.querySelector(":scope > .bases-structure-row");
			if (!(lastRowEl instanceof HTMLElement)) {
				spineEl.style.top = `${0}px`;
				spineEl.style.height = `${0}px`;
				continue;
			}

			const br = block.getBoundingClientRect();
			const pr = parentRowEl.getBoundingClientRect();
			const lr = lastRowEl.getBoundingClientRect();
			const topPx = pr.top + pr.height / 2 - br.top;
			const bottomPx = lr.top + lr.height / 2 - br.top;
			const h = Math.max(0, bottomPx - topPx);
			spineEl.style.top = `${topPx}px`;
			spineEl.style.height = `${h}px`;
		}
	}

	private updateSearchAdornments(): void {
		if (!this.searchWrapEl || !this.searchInputEl) return;
		const has = this.searchInputEl.value.trim().length > 0;
		this.searchWrapEl.toggleClass("has-value", has);
	}

	private expandAllFromTree(nodes: TreeNode[]): void {
		const walk = (list: TreeNode[]) => {
			for (const node of list) {
				if (node.children.length > 0) {
					this.expandedBranchKeys.add(node.branchKey);
					walk(node.children);
				}
			}
		};
		walk(nodes);
	}

	/** All root→leaf chains whose leaf matches `targetPath` (preorder of end nodes). */
	private findAllChainsToFile(nodes: TreeNode[], targetPath: string): TreeNode[][] {
		const out: TreeNode[][] = [];
		const walk = (list: TreeNode[], prefix: TreeNode[]) => {
			for (const node of list) {
				const chain = [...prefix, node];
				if (node.filePath === targetPath) {
					out.push(chain);
				}
				if (node.children.length > 0) {
					walk(node.children, chain);
				}
			}
		};
		walk(nodes, []);
		return out;
	}

	private revealAndScrollToActiveFile(): void {
		const loc = getPluginLocale();
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice(t(loc, "noticeNoActiveNote"));
			return;
		}
		if (this.lastBuiltTree.length === 0) {
			new Notice(t(loc, "noticeNothingToShow"));
			return;
		}
		if (file.path !== this.lastActiveFilePathForRevealCycle) {
			this.showActiveFileNextOccurrenceIndex = 0;
			this.lastActiveFilePathForRevealCycle = file.path;
		}
		const chains = this.findAllChainsToFile(this.lastBuiltTree, file.path);
		if (chains.length === 0) {
			new Notice(t(loc, "noticeActiveNotInBase"));
			return;
		}
		const n = chains.length;
		const idx = this.showActiveFileNextOccurrenceIndex % n;
		const chain = chains[idx]!;
		const targetBranchKey = chain[chain.length - 1]!.branchKey;

		for (let i = 0; i < chain.length - 1; i++) {
			const ancestor = chain[i]!;
			if (ancestor.children.length > 0) {
				this.expandedBranchKeys.add(ancestor.branchKey);
			}
		}
		this.showActiveFileNextOccurrenceIndex = (idx + 1) % n;

		this.render();
		window.requestAnimationFrame(() => {
			const { hasMatch, branchScrolled } = this.syncActiveFileHighlight(true, "center", {
				scrollToBranchKey: targetBranchKey,
			});
			if (!hasMatch) {
				new Notice(t(loc, "noticeActiveHiddenFilter"));
			} else if (!branchScrolled) {
				new Notice(t(loc, "noticeOccurrenceHiddenFilter"));
			}
		});
	}

	private nodeNameMatchesFilter(node: TreeNode): boolean {
		const q = this.filterQuery.trim().toLowerCase();
		if (!q) return false;
		const hay = formatEntryFilterText(node.entry, this.columnModel.order).toLowerCase();
		return hay.includes(q);
	}

	/** Show node, path to matches, and full subtree under any matching node. */
	private shouldShowNodeInFilter(node: TreeNode, underMatchedParent: boolean): boolean {
		const q = this.filterQuery.trim();
		if (!q) return true;
		const cache = this.filterVisibilityCache;
		const cacheKey = `${node.branchKey}\0${underMatchedParent}`;
		if (cache?.has(cacheKey)) {
			return cache.get(cacheKey)!;
		}
		let result: boolean;
		if (underMatchedParent) {
			result = true;
		} else if (this.nodeNameMatchesFilter(node)) {
			result = true;
		} else {
			result = node.children.some((child) => this.shouldShowNodeInFilter(child, false));
		}
		cache?.set(cacheKey, result);
		return result;
	}

	private getAllEntries(): BasesEntry[] {
		const groupedData = this.data?.groupedData ?? [];
		if (groupedData.length > 0) {
			const allEntries: BasesEntry[] = [];
			for (const group of groupedData) {
				allEntries.push(...group.entries);
			}
			return allEntries;
		}
		return this.data?.data ?? [];
	}

	private getRelationPropertyFromConfig(): string {
		const raw = this.config?.get("relationProperty");
		if (typeof raw === "string" && raw.trim().length > 0) {
			return raw.trim();
		}
		return DEFAULT_RELATION_PROPERTY;
	}

	/** Vault path to a Templater template `.md` for “Create sub-note”; empty = rely on Templater’s new-file rules only. */
	private getSubNoteTemplatePathFromConfig(): string {
		const raw = this.config?.get("subNoteTemplate");
		return typeof raw === "string" ? raw.trim() : "";
	}

	private getRelationPropertyId(): BasesPropertyId {
		return `note.${this.relationProperty}` as BasesPropertyId;
	}

	/**
	 * Property column order from Bases: {@link BasesViewConfig.getOrder}, or visible
	 * properties from the query when order is empty (see {@link BasesQueryResult.properties}).
	 * Drag-reorder is applied via {@link columnOrderOverride}.
	 */
	private getVisiblePropertyIds(): BasesPropertyId[] {
		const ordered = this.config?.getOrder() ?? [];
		const basesList =
			ordered.length > 0 ? ordered : (this.data?.properties ?? []);
		const basesKey = basesList.join("\0");

		if (basesKey !== this.lastBasesOrderKey) {
			if (this.ignoreNextBasesOrderChange) {
				this.ignoreNextBasesOrderChange = false;
			} else {
				this.columnOrderOverride = null;
			}
			this.lastBasesOrderKey = basesKey;
		}

		if (!this.columnOrderOverride || this.columnOrderOverride.length === 0) {
			return [...basesList];
		}

		const remaining = new Set(basesList);
		const merged: BasesPropertyId[] = [];
		for (const id of this.columnOrderOverride) {
			if (remaining.has(id)) {
				merged.push(id);
				remaining.delete(id);
			}
		}
		for (const id of basesList) {
			if (remaining.has(id)) {
				merged.push(id);
			}
		}
		return merged;
	}

	/**
	 * Parent links for all entries (one `extractParentPaths` per entry, shared path set — O(n)).
	 */
	private buildRelationMaps(entries: BasesEntry[]): {
		parentMap: Map<string, string[]>;
		childrenMap: Map<string, string[]>;
	} {
		const availablePaths = new Set(entries.map((e) => e.file.path));
		const parentMap = new Map<string, string[]>();
		for (const entry of entries) {
			parentMap.set(entry.file.path, this.extractParentPaths(entry, availablePaths));
		}
		const childrenMap = new Map<string, string[]>();
		for (const [childPath, parents] of parentMap.entries()) {
			for (const parentPath of parents) {
				const list = childrenMap.get(parentPath) ?? [];
				list.push(childPath);
				childrenMap.set(parentPath, list);
			}
		}
		return { parentMap, childrenMap };
	}

	private buildTree(entries: BasesEntry[]): TreeNode[] {
		const entryMap = new Map<string, BasesEntry>();
		for (const entry of entries) {
			entryMap.set(entry.file.path, entry);
		}

		const { parentMap, childrenMap } = this.buildRelationMaps(entries);

		const roots = entries.filter((entry) => {
			const parents = parentMap.get(entry.file.path) ?? [];
			return parents.length === 0;
		});

		const buildNode = (
			entry: BasesEntry,
			parentPath: ParentPath,
			depth: number,
			ancestry: Set<string>,
			branchKey: string,
		): TreeNode => {
			const filePath = entry.file.path;
			const nextAncestry = new Set(ancestry);
			nextAncestry.add(filePath);

			const childPaths = childrenMap.get(filePath) ?? [];
			const children: TreeNode[] = [];

			for (const childPath of childPaths) {
				if (nextAncestry.has(childPath)) {
					continue;
				}
				const childEntry = entryMap.get(childPath);
				if (!childEntry) {
					continue;
				}

				const childBranchKey = `${branchKey}>${childPath}`;
				children.push(
					buildNode(childEntry, filePath, depth + 1, nextAncestry, childBranchKey),
				);
			}

			return {
				entry,
				filePath,
				parentPath,
				children,
				depth,
				descendantCount: this.countDescendants(children),
				branchKey,
			};
		};

		return roots.map((root) =>
			buildNode(root, null, 0, new Set<string>(), root.file.path),
		);
	}

	private countDescendants(children: TreeNode[]): number {
		let total = 0;
		for (const child of children) {
			total += 1 + child.descendantCount;
		}
		return total;
	}

	private extractParentPaths(entry: BasesEntry, availablePaths: Set<string>): string[] {
		const propertyId = this.getRelationPropertyId();
		const value = entry.getValue(propertyId);
		const rawParents: string[] = [];

		if (value && !(value instanceof NullValue)) {
			rawParents.push(...this.extractPathsFromValue(value, entry.file));
		}

		if (rawParents.length === 0) {
			const cache = this.app.metadataCache.getFileCache(entry.file);
			const fm = cache?.frontmatter;
			let rawFrontmatter: unknown;
			if (fm && typeof fm === "object" && !Array.isArray(fm)) {
				rawFrontmatter = (fm as Record<string, unknown>)[this.relationProperty];
			} else {
				rawFrontmatter = undefined;
			}
			rawParents.push(...this.extractPathsFromFrontmatter(rawFrontmatter, entry.file));
		}

		return Array.from(new Set(rawParents)).filter((path) => availablePaths.has(path));
	}

	private extractPathsFromValue(value: Value, currentFile: TFile): string[] {
		if (value instanceof ListValue) {
			const anyList = value as unknown as { data?: Value[] };
			const values = anyList.data ?? [];
			const results: string[] = [];
			for (const item of values) {
				const resolved = this.resolvePathFromValueItem(item, currentFile);
				if (resolved) results.push(resolved);
			}
			return results;
		}

		const single = this.resolvePathFromValueItem(value, currentFile);
		return single ? [single] : [];
	}

	private extractPathsFromFrontmatter(rawValue: unknown, currentFile: TFile): string[] {
		if (!rawValue) return [];

		if (Array.isArray(rawValue)) {
			const results: string[] = [];
			for (const item of rawValue) {
				if (typeof item !== "string") continue;
				const resolved = this.resolvePathFromString(item, currentFile);
				if (resolved) results.push(resolved);
			}
			return results;
		}

		if (typeof rawValue === "string") {
			const resolved = this.resolvePathFromString(rawValue, currentFile);
			return resolved ? [resolved] : [];
		}

		return [];
	}

	private resolvePathFromValueItem(value: Value, currentFile: TFile): string | null {
		if (value instanceof LinkValue) {
			const anyLink = value as unknown as { path?: string };
			const maybePath = anyLink.path ?? value.toString();
			return this.resolvePathFromString(maybePath, currentFile);
		}
		return this.resolvePathFromString(value.toString(), currentFile);
	}

	private resolvePathFromString(raw: string, currentFile: TFile): string | null {
		const source = raw.trim();
		if (!source) return null;

		const mdHref = this.tryExtractMarkdownLinkHref(source);
		if (mdHref !== null) {
			const fromMd = this.resolveVaultHrefToPath(mdHref, currentFile);
			if (fromMd) return fromMd;
		}

		const wikiMatch = source.match(/\[\[([^\]]+)\]\]/);
		const wiki = wikiMatch && wikiMatch[1] ? wikiMatch[1] : source;
		const linkTarget = wiki.split("|")[0]?.trim() ?? "";
		if (!linkTarget) return null;
		const resolved = this.app.metadataCache.getFirstLinkpathDest(linkTarget, currentFile.path);
		if (resolved instanceof TFile) {
			return resolved.path;
		}
		return null;
	}

	/** First `[label](href)` in the string, or null if none (avoids touching `[[wikilinks]]`). */
	private tryExtractMarkdownLinkHref(source: string): string | null {
		if (!source.includes("](")) return null;
		const m = source.match(/\[([^\]]*)\]\(([^)]+)\)/);
		if (!m?.[2]) return null;
		return m[2].trim();
	}

	/** Resolve a vault path or relative `.md` href from a markdown link to canonical file path. */
	private resolveVaultHrefToPath(href: string, currentFile: TFile): string | null {
		let path = href.trim();
		if (!path) return null;
		if (/^https?:\/\//i.test(path) || /^mailto:/i.test(path)) return null;
		try {
			path = decodeURIComponent(path);
		} catch {
			/* keep encoded */
		}
		const pathOnly = path.split("#")[0] ?? "";
		if (!pathOnly) return null;
		const normalized = pathOnly.replace(/\\/g, "/");
		const resolved = this.app.metadataCache.getFirstLinkpathDest(normalized, currentFile.path);
		if (resolved instanceof TFile) {
			return resolved.path;
		}
		return null;
	}

	private renderNode(
		parentEl: HTMLElement,
		node: TreeNode,
		isLast: boolean,
		underMatchedParent: boolean,
		activePath: string,
		locale: PluginLocale,
	): void {
		const filterActive = this.filterQuery.trim().length > 0;
		if (filterActive && !this.shouldShowNodeInFilter(node, underMatchedParent)) {
			return;
		}

		const itemEl = parentEl.createDiv({ cls: "bases-structure-item" });
		itemEl.toggleClass("is-last", isLast);

		const hasChildren = node.children.length > 0;
		const rowEl = itemEl.createDiv({
			cls: "bases-structure-row",
			attr: {
				"data-file-path": node.filePath,
				"data-parent-path": node.parentPath ?? "",
				"data-branch-key": node.branchKey,
				"data-depth": String(node.depth),
				...(hasChildren ? { "data-has-children": "true" } : {}),
			},
		});
		rowEl.toggleClass("is-root", node.depth === 0);
		rowEl.toggleClass("is-selected", this.selectedBranchKeys.has(node.branchKey));
		rowEl.toggleClass("is-active-file", Boolean(activePath) && node.filePath === activePath);

		this.visibleRowOrder.push({
			branchKey: node.branchKey,
			filePath: node.filePath,
			parentPath: node.parentPath,
			depth: node.depth,
		});

		rowEl.setAttr("draggable", "true");

		const nextUnderMatched =
			underMatchedParent || (filterActive && this.nodeNameMatchesFilter(node));
		const anyChildMatchesFilter =
			filterActive &&
			node.children.some((child) =>
				this.shouldShowNodeInFilter(child, nextUnderMatched),
			);
		const expanded =
			hasChildren &&
			(this.expandedBranchKeys.has(node.branchKey) ||
				(filterActive && anyChildMatchesFilter));

		const treeCell = rowEl.createDiv({
			cls: "bases-structure-tree-cell",
			attr: { "data-depth": String(node.depth) },
		});
		treeCell.toggleClass("is-root", node.depth === 0);
		treeCell.style.setProperty("--bases-structure-depth", String(node.depth));

		const treeInner = treeCell.createDiv({ cls: "bases-structure-tree-inner" });

		const toggleWrap = treeInner.createDiv({ cls: "bases-structure-toggle-wrap" });
		if (hasChildren) {
			const btn = toggleWrap.createEl("button", {
				cls: "bases-structure-toggle clickable-icon",
				attr: { "aria-label": t(locale, "toggleBranchAria") },
			});
			setIcon(btn, expanded ? "minus" : "plus");
			btn.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.toggleExpanded(node.branchKey);
				this.render();
			});
		} else {
			toggleWrap.createSpan({ cls: "bases-structure-toggle-placeholder" });
		}

		const titleEl = treeInner.createDiv({ cls: "bases-structure-title" });
		const treeLabel = formatTreeLabel(node.entry, this.columnModel.treePropertyId);
		const linkEl = titleEl.createEl("a", {
			cls: "internal-link" + (treeLabel.length === 0 ? " is-empty-label" : ""),
			text: treeLabel.length > 0 ? treeLabel : "\u00A0",
			/** Native link drags use `app://…` URLs in `text/plain`; row drag uses {@link setNoteDragPlainText}. */
			attr: {
				href: node.filePath,
				draggable: "false",
				title: node.entry.file.basename,
			},
		});
		linkEl.addEventListener("click", (evt) => {
			if (evt.shiftKey) {
				evt.preventDefault();
				evt.stopPropagation();
				this.applyShiftRangeSelection(node.branchKey);
				this.render();
				return;
			}
			evt.preventDefault();
			void this.app.workspace.openLinkText(node.filePath, "", evt.ctrlKey || evt.metaKey);
		});
		linkEl.addEventListener("mouseover", (evt) => {
			this.app.workspace.trigger("hover-link", {
				event: evt,
				source: FILE_MENU_SOURCE,
				hoverParent: this.app.renderContext,
				targetEl: linkEl,
				linktext: node.filePath,
			});
		});

		treeInner.createDiv({
			cls: "bases-structure-counter",
			text: `${node.descendantCount}`,
		});

		for (const propId of this.columnModel.tablePropertyIds) {
			const cellEl = rowEl.createDiv({ cls: "bases-structure-cell" });
			const controller = renderPropertyCell({
				app: this.app,
				cellEl,
				entry: node.entry,
				propertyId: propId,
				onFocusChange: (focused) => this.onCellFocusChange(focused),
				onBeforeWrite: () => this.onBeforeCellWrite(),
			});
			this.cellControllers.push(controller);
		}

		if (!hasChildren || !expanded) {
			return;
		}

		const childrenEl = itemEl.createDiv({
			cls: "bases-structure-children",
			attr: { "data-parent-depth": String(node.depth) },
		});
		childrenEl.style.setProperty("--bases-structure-parent-depth", String(node.depth));
		childrenEl.createDiv({
			cls: "bases-structure-spine",
			attr: {
				role: "button",
				tabindex: "0",
				"aria-label": t(locale, "spineCollapseAria"),
				"data-branch-key": node.branchKey,
			},
		});
		node.children.forEach((child, index) => {
			this.renderNode(
				childrenEl,
				child,
				index === node.children.length - 1,
				nextUnderMatched,
				activePath,
				locale,
			);
		});
	}

	private toggleExpanded(branchKey: string): void {
		if (this.expandedBranchKeys.has(branchKey)) {
			this.expandedBranchKeys.delete(branchKey);
		} else {
			this.expandedBranchKeys.add(branchKey);
		}
	}

	private applyShiftRangeSelection(clickedBranchKey: string): void {
		const order = this.visibleRowOrder;
		if (this.selectionAnchorBranchKey === null) {
			this.selectionAnchorBranchKey = clickedBranchKey;
			this.selectedBranchKeys = new Set([clickedBranchKey]);
			return;
		}
		const i0 = order.findIndex((r) => r.branchKey === this.selectionAnchorBranchKey);
		const i1 = order.findIndex((r) => r.branchKey === clickedBranchKey);
		if (i0 < 0 || i1 < 0) {
			this.selectionAnchorBranchKey = clickedBranchKey;
			this.selectedBranchKeys = new Set([clickedBranchKey]);
			return;
		}
		const lo = Math.min(i0, i1);
		const hi = Math.max(i0, i1);
		this.selectedBranchKeys = new Set(order.slice(lo, hi + 1).map((r) => r.branchKey));
	}

	private dedupeDragSources(sources: DragSourceItem[]): DragSourceItem[] {
		const seen = new Set<string>();
		const out: DragSourceItem[] = [];
		for (const s of sources) {
			if (seen.has(s.filePath)) continue;
			seen.add(s.filePath);
			out.push(s);
		}
		return out;
	}

	private sortSourcesDeepestFirst(sources: DragSourceItem[]): DragSourceItem[] {
		const depthByPath = new Map(this.visibleRowOrder.map((r) => [r.filePath, r.depth] as const));
		return [...sources].sort((a, b) => {
			const da = depthByPath.get(a.filePath) ?? 0;
			const db = depthByPath.get(b.filePath) ?? 0;
			return db - da;
		});
	}

	private clearDropHighlights(): void {
		this.dropHighlightRowEl?.removeClass("is-drop-target");
		this.dropHighlightRowEl = null;
	}

	/**
	 * Ensures the row for {@link branchKey} and every ancestor row is expanded.
	 * Keys follow {@link buildTree}: `rootPath`, then `rootPath>childPath`, etc.
	 */
	private expandAncestorsByBranchKey(branchKey: string): void {
		if (!branchKey) return;
		const parts = branchKey.split(">");
		let prefix = "";
		for (let i = 0; i < parts.length; i++) {
			const segment = parts[i];
			if (segment === undefined || segment.length === 0) continue;
			prefix = i === 0 ? segment : `${prefix}>${segment}`;
			this.expandedBranchKeys.add(prefix);
		}
	}

	private async getUniqueNotePath(folderPath: string, baseName: string): Promise<string> {
		const prefix =
			folderPath === "" || folderPath === "/" ? "" : folderPath.replace(/\/$/, "") + "/";
		let path = `${prefix}${baseName}.md`;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${prefix}${baseName} ${i}.md`;
			i++;
		}
		return path;
	}

	private async createSubNoteUnder(parentFile: TFile, parentBranchKey: string): Promise<void> {
		const loc = getPluginLocale();
		this.relationProperty = this.getRelationPropertyFromConfig();
		const folderPath = parentFile.parent?.path ?? "";
		try {
			const notePath = await this.getUniqueNotePath(folderPath, t(loc, "newNoteBaseName"));
			const newFile = await this.app.vault.create(notePath, "");
			await this.app.workspace.getLeaf(false).openFile(newFile);

			const templatePath = this.getSubNoteTemplatePathFromConfig();
			if (templatePath.length > 0) {
				const applied = await applyExplicitTemplaterTemplate(
					this.app,
					templatePath,
					newFile,
					loc,
				);
				if (!applied.ok) {
					if (applied.reason.length > 0) {
						new Notice(applied.reason, 8000);
					}
					await waitForAutomaticTemplaterOnFile(this.app, newFile);
				}
			} else {
				await waitForAutomaticTemplaterOnFile(this.app, newFile);
			}

			const parentLink = this.formatRelationLinkToParent(parentFile.path, newFile);
			await this.app.fileManager.processFrontMatter(newFile, (fm: Record<string, unknown>) => {
				fm[this.relationProperty] = [parentLink];
			});
			this.expandAncestorsByBranchKey(parentBranchKey);
			this.render();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			new Notice(t(loc, "couldNotCreateSubNote", { detail }), 8000);
		}
	}

	private async handleDropOnFile(
		targetFilePath: string,
		targetBranchKey: string,
		isCopyMode: boolean,
	): Promise<void> {
		this.stopDragAutoScroll();
		const drag = this.dragState;
		this.dragState = null;
		this.isCtrlPressed = false;
		this.clearDropHighlights();
		if (!drag) return;

		const loc = getPluginLocale();
		const ordered = this.sortSourcesDeepestFirst(drag.sources);
		let moved = 0;
		for (const item of ordered) {
			if (item.filePath === targetFilePath) {
				continue;
			}
			const entries = this.getAllEntries();
			const entryMap = new Map(entries.map((e) => [e.file.path, e] as const));
			const sourceEntry = entryMap.get(item.filePath);
			const targetEntry = entryMap.get(targetFilePath);
			if (!sourceEntry || !targetEntry) {
				continue;
			}
			const { childrenMap } = this.buildRelationMaps(entries);
			if (this.wouldCreateCycle(item.filePath, targetFilePath, childrenMap)) {
				if (ordered.length === 1) {
					new Notice(t(loc, "noticeCycle"));
				}
				continue;
			}
			try {
				await this.updateRelationForMove(
					sourceEntry.file,
					targetEntry.file.path,
					item.parentPath,
					isCopyMode,
				);
				moved += 1;
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				new Notice(
					t(loc, "couldNotSaveRelation", {
						name: sourceEntry.file.basename,
						detail,
					}),
					8000,
				);
			}
		}

		if (moved > 0) {
			this.selectedBranchKeys.clear();
			this.selectionAnchorBranchKey = null;
			this.expandedBranchKeys.add(targetBranchKey);
		}
		this.render();
	}

	private wouldCreateCycle(
		sourcePath: string,
		newParentPath: string,
		childrenMap: Map<string, string[]>,
	): boolean {
		const stack = [sourcePath];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const current = stack.pop()!;
			if (current === newParentPath) {
				return true;
			}
			if (seen.has(current)) continue;
			seen.add(current);
			const children = childrenMap.get(current) ?? [];
			stack.push(...children);
		}
		return false;
	}

	private async updateRelationForMove(
		file: TFile,
		newParentPath: string,
		oldParentPath: ParentPath,
		isCopyMode: boolean,
	): Promise<void> {
		const property = this.relationProperty;
		const newParentLink = this.formatRelationLinkToParent(newParentPath, file);

		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const current = fm[property];
			const rawLinks = this.normalizeFrontmatterLinks(current);
			const relationItems = rawLinks.map((raw) => ({
				raw,
				resolvedPath: this.resolvePathFromString(raw, file),
			}));

			const alreadyHasNewParent = relationItems.some(
				(item) => item.resolvedPath === newParentPath,
			);
			if (!alreadyHasNewParent) {
				relationItems.push({ raw: newParentLink, resolvedPath: newParentPath });
			}

			if (!isCopyMode && oldParentPath) {
				for (let i = relationItems.length - 1; i >= 0; i--) {
					const item = relationItems[i];
					if (item && item.resolvedPath === oldParentPath) {
						relationItems.splice(i, 1);
						break;
					}
				}
			}

			const links = relationItems.map((item) => item.raw);
			if (links.length === 0) {
				delete fm[property];
			} else {
				fm[property] = links;
			}
		});
	}

	private normalizeFrontmatterLinks(rawValue: unknown): string[] {
		if (!rawValue) return [];
		if (Array.isArray(rawValue)) {
			return rawValue.filter((v): v is string => typeof v === "string");
		}
		if (typeof rawValue === "string") {
			return [rawValue];
		}
		return [];
	}

	/**
	 * Link text for `relationProperty` when reparenting — matches vault **Settings → Files & links**
	 * (wikilinks vs Markdown links) and shortest path, same as the editor.
	 */
	private formatRelationLinkToParent(parentPath: string, childFile: TFile): string {
		const parent = this.app.vault.getAbstractFileByPath(parentPath);
		if (!(parent instanceof TFile)) {
			return this.formatFallbackRelationLink(parentPath);
		}
		return this.app.fileManager.generateMarkdownLink(parent, childFile.path);
	}

	private useMarkdownLinksSetting(): boolean {
		const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
		return Boolean(vault.getConfig?.("useMarkdownLinks"));
	}

	/** If the parent file is missing from the vault, approximate user link style (wikilink vs md). */
	private formatFallbackRelationLink(path: string): string {
		const useMd = this.useMarkdownLinksSetting();
		const normalized = path.replace(/\\/g, "/");
		const stem = normalized.endsWith(".md") ? normalized.slice(0, -3) : normalized;
		const label = stem.includes("/") ? (stem.split("/").pop() ?? stem) : stem;
		if (useMd) {
			const href = encodeURI(normalized + (normalized.endsWith(".md") ? "" : ".md"));
			return `[${label}](${href})`;
		}
		return `[[${stem}]]`;
	}

	static getViewOptions(app: App): ViewOption[] {
		const loc = getPluginLocale();
		return [
			{
				key: "relationProperty",
				displayName: t(loc, "viewOptionRelationProperty"),
				type: "text",
				default: DEFAULT_RELATION_PROPERTY,
				placeholder: t(loc, "viewOptionRelationPlaceholder"),
			},
			{
				key: "subNoteTemplate",
				displayName: t(loc, "viewOptionSubNoteTemplate"),
				type: "file",
				default: "",
				placeholder: t(loc, "viewOptionSubNotePlaceholder"),
				filter: (file: TFile) => subNoteTemplateFileFilter(app, file),
			},
		];
	}
}
