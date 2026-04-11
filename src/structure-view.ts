import {
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
import type BasesStructurePlugin from "./main";

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
	/** Vertical scroll host for the tree (`.bases-structure-tree-scroll`). */
	private treeScrollEl: HTMLElement | null = null;
	private treeMountEl: HTMLElement | null = null;
	private searchWrapEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchClearBtn: HTMLButtonElement | null = null;
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
				const f = this.app.workspace.getActiveFile();
				const path = f?.path ?? "";
				if (path !== this.lastActiveFilePathForRevealCycle) {
					this.showActiveFileNextOccurrenceIndex = 0;
					this.lastActiveFilePathForRevealCycle = path;
				}
				this.syncActiveFileHighlight(true, "nearest");
			}),
		);

		this.plugin.registerDomEvent(this.containerEl, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target.closest(".bases-structure-toggle")) return;

			const row = target.closest(".bases-structure-row") as HTMLElement | null;
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
			) as HTMLElement | null;
			if (!row) return;
			const path = row.getAttr("data-file-path");
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) return;
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			this.app.workspace.trigger("file-menu", menu, file, FILE_MENU_SOURCE);
			this.addChild(menu);
			menu.showAtMouseEvent(evt);
		});

		this.registerDelegatedTreeDragDrop();
	}

	/** One listener set for the whole tree; avoids per-row addEventListener on every render. */
	private registerDelegatedTreeDragDrop(): void {
		this.plugin.registerDomEvent(this.containerEl, "dragstart", (evt: DragEvent) => {
			this.stopDragAutoScroll();
			const row = (evt.target as HTMLElement).closest(
				".bases-structure-row",
			) as HTMLElement | null;
			if (!row || !evt.dataTransfer) return;

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
			evt.dataTransfer.setData(
				"text/plain",
				sources.map((s) => s.filePath).join("\n"),
			);
			row.addClass("is-dragging");
			this.dragSourceRowEl = row;
		});

		this.plugin.registerDomEvent(this.containerEl, "dragend", (evt: DragEvent) => {
			const row =
				(evt.target as HTMLElement).closest(".bases-structure-row") ??
				this.dragSourceRowEl;
			this.stopDragAutoScroll();
			this.dragState = null;
			this.isCtrlPressed = false;
			this.clearDropHighlights();
			row?.removeClass("is-dragging");
			this.dragSourceRowEl = null;
		});

		this.plugin.registerDomEvent(this.containerEl, "dragover", (evt: DragEvent) => {
			if (!this.dragState) return;
			this.isCtrlPressed = evt.ctrlKey;
			this.lastDragPointerClientY = evt.clientY;
			if (this.wouldDragScrollChangeScrollTop()) {
				this.ensureDragAutoScrollLoop();
			}

			const row = (evt.target as HTMLElement).closest(
				".bases-structure-row",
			) as HTMLElement | null;
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
			const row = (evt.target as HTMLElement).closest(
				".bases-structure-row",
			) as HTMLElement | null;
			if (!row) return;
			const related = evt.relatedTarget as HTMLElement | null;
			if (related && row.contains(related)) return;
			row.removeClass("is-drop-target");
			if (this.dropHighlightRowEl === row) {
				this.dropHighlightRowEl = null;
			}
		});

		this.plugin.registerDomEvent(this.containerEl, "drop", (evt: DragEvent) => {
			const row = (evt.target as HTMLElement).closest(
				".bases-structure-row",
			) as HTMLElement | null;
			if (!row) return;
			const filePath = row.getAttr("data-file-path");
			const branchKey = row.getAttr("data-branch-key");
			if (!filePath || !branchKey) return;
			evt.preventDefault();
			const copyMode = evt.ctrlKey || this.isCtrlPressed || this.dragState?.isCopyMode === true;
			void this.handleDropOnFile(filePath, branchKey, copyMode);
		});
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
	}

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	public onDataUpdated(): void {
		window.clearTimeout(this.dataUpdateDebounceHandle);
		this.dataUpdateDebounceHandle = window.setTimeout(() => {
			this.dataUpdateDebounceHandle = undefined;
			this.render();
		}, 100);
	}

	private render(): void {
		this.relationProperty = this.getRelationPropertyFromConfig();
		this.ensureToolbarShell();
		this.filterQuery = this.searchInputEl?.value ?? "";

		const treeMount = this.treeMountEl;
		if (!treeMount) return;

		treeMount.empty();
		this.lastPaintedActiveFilePath = "";

		const entries = this.getAllEntries();
		if (entries.length === 0) {
			this.lastBuiltTree = [];
			treeMount.createEl("p", {
				text: "No entries found.",
				cls: "bases-structure-empty",
			});
			return;
		}

		const tree = this.buildTree(entries);
		this.lastBuiltTree = tree;

		if (tree.length === 0) {
			treeMount.createEl("p", {
				text: "No roots found. Check for cyclic relations.",
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
					text: `No notes match "${q}".`,
					cls: "bases-structure-empty",
				});
				return;
			}
		}

		const activePath = this.app.workspace.getActiveFile()?.path ?? "";
		this.visibleRowOrder = [];
		for (const root of tree) {
			this.renderNode(treeMount, root, true, false, activePath);
		}
		this.lastPaintedActiveFilePath = activePath;
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
		return Array.from(tm.querySelectorAll(this.activeRowSelectorForPath(filePath))) as HTMLElement[];
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
			text: "Expand all",
			attr: { type: "button", "aria-label": "Expand all branches" },
		});
		setIcon(expandBtn, "unfold-vertical");

		const collapseBtn = toolbarLeft.createEl("button", {
			cls: "bases-structure-toolbar-btn",
			text: "Collapse all",
			attr: { type: "button", "aria-label": "Collapse all branches" },
		});
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
			text: "Show active file",
			attr: {
				type: "button",
				"aria-label":
					"Expand path to active note, scroll to it; repeat to cycle duplicate rows",
			},
		});
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
				placeholder: "Filter tree…",
				"aria-label": "Filter tree by name",
				spellcheck: "false",
			},
		});
		this.searchInputEl = searchInput;

		const clearBtn = searchWrap.createEl("button", {
			cls: "bases-structure-search-clear clickable-icon",
			attr: { type: "button", "aria-label": "Clear filter" },
		});
		this.searchClearBtn = clearBtn;
		setIcon(clearBtn, "x");
		clearBtn.style.display = "none";

		clearBtn.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			searchInput.value = "";
			this.filterQuery = "";
			this.updateSearchAdornments();
			this.render();
			requestAnimationFrame(() => searchInput.focus());
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
		this.treeMountEl = treeScroll.createDiv({ cls: "bases-structure-tree" });
	}

	private updateSearchAdornments(): void {
		if (!this.searchWrapEl || !this.searchClearBtn || !this.searchInputEl) return;
		const has = this.searchInputEl.value.trim().length > 0;
		this.searchWrapEl.toggleClass("has-value", has);
		this.searchClearBtn.style.display = has ? "inline-flex" : "none";
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
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note.");
			return;
		}
		if (this.lastBuiltTree.length === 0) {
			new Notice("Nothing to show in this view.");
			return;
		}
		if (file.path !== this.lastActiveFilePathForRevealCycle) {
			this.showActiveFileNextOccurrenceIndex = 0;
			this.lastActiveFilePathForRevealCycle = file.path;
		}
		const chains = this.findAllChainsToFile(this.lastBuiltTree, file.path);
		if (chains.length === 0) {
			new Notice("Active note is not in this base.");
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
		requestAnimationFrame(() => {
			const { hasMatch, branchScrolled } = this.syncActiveFileHighlight(true, "center", {
				scrollToBranchKey: targetBranchKey,
			});
			if (!hasMatch) {
				new Notice("Active note is hidden by the current filter.");
			} else if (!branchScrolled) {
				new Notice("This occurrence is hidden by the current filter.");
			}
		});
	}

	private nodeNameMatchesFilter(node: TreeNode): boolean {
		const q = this.filterQuery.trim().toLowerCase();
		if (!q) return false;
		const hay = this.formatEntryRowLabel(node.entry).toLowerCase();
		const base = node.entry.file.basename.toLowerCase();
		return hay.includes(q) || base.includes(q);
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

	private getRelationPropertyId(): BasesPropertyId {
		return `note.${this.relationProperty}` as BasesPropertyId;
	}

	/**
	 * Property column order from Bases: {@link BasesViewConfig.getOrder}, or visible
	 * properties from the query when order is empty (see {@link BasesQueryResult.properties}).
	 */
	private getVisiblePropertyIds(): BasesPropertyId[] {
		const ordered = this.config?.getOrder() ?? [];
		if (ordered.length > 0) {
			return ordered;
		}
		return this.data?.properties ?? [];
	}

	/** Text for the tree row: visible Bases columns joined, or basename if none / all empty. */
	private formatEntryRowLabel(entry: BasesEntry): string {
		const ids = this.getVisiblePropertyIds();
		if (ids.length === 0) {
			return entry.file.basename;
		}
		const parts: string[] = [];
		for (const id of ids) {
			const value = entry.getValue(id);
			if (value == null || value instanceof NullValue) {
				continue;
			}
			const s = value.toString().trim();
			if (s.length > 0) {
				parts.push(s);
			}
		}
		return parts.length > 0 ? parts.join(" · ") : entry.file.basename;
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
			const rawFrontmatter = cache?.frontmatter?.[this.relationProperty];
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
		return m[2]!.trim();
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

		const toggleWrap = rowEl.createDiv({ cls: "bases-structure-toggle-wrap" });
		if (hasChildren) {
			const btn = toggleWrap.createEl("button", {
				cls: "bases-structure-toggle clickable-icon",
				attr: { "aria-label": "Expand or collapse branch" },
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

		const titleEl = rowEl.createDiv({ cls: "bases-structure-title" });
		const linkEl = titleEl.createEl("a", {
			cls: "internal-link",
			text: this.formatEntryRowLabel(node.entry),
			attr: { href: node.filePath },
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

		const counterEl = rowEl.createDiv({
			cls: "bases-structure-counter",
			text: `${node.descendantCount}`,
		});
		if (!hasChildren || !expanded) {
			return;
		}

		const childrenEl = itemEl.createDiv({ cls: "bases-structure-children" });
		node.children.forEach((child, index) => {
			this.renderNode(
				childrenEl,
				child,
				index === node.children.length - 1,
				nextUnderMatched,
				activePath,
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
					new Notice("This operation would create a cycle.");
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
					`Could not save relation for "${sourceEntry.file.basename}": ${detail}`,
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

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const current = frontmatter[property];
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
				delete frontmatter[property];
			} else {
				frontmatter[property] = links;
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

	static getViewOptions(): ViewOption[] {
		return [
			{
				key: "relationProperty",
				displayName: "Relation property",
				type: "text",
				default: DEFAULT_RELATION_PROPERTY,
				placeholder: "up",
			},
		];
	}
}
