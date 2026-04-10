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

export class StructureView extends BasesView {
	type = VIEW_TYPE;
	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	plugin: BasesStructurePlugin;

	private expandedPaths = new Set<string>();
	private dragState: DragState | null = null;
	private relationProperty = DEFAULT_RELATION_PROPERTY;
	private isCtrlPressed = false;
	/** Local tree filter (does not use Bases query — keeps full entry set). */
	private filterQuery = "";
	private searchDebounceHandle: number | undefined;
	private toolbarEl: HTMLElement | null = null;
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

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: BasesStructurePlugin) {
		super(controller);
		this.scrollEl = scrollEl;
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: "bases-structure-container" });
	}

	onload(): void {
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
				const path = row.getAttr("data-file-path");
				if (path) {
					this.toggleExpanded(path);
				}
			}
			this.render();
		});
	}

	onunload(): void {
		window.clearTimeout(this.searchDebounceHandle);
	}

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	public onDataUpdated(): void {
		this.render();
	}

	private render(): void {
		this.relationProperty = this.getRelationPropertyFromConfig();
		this.ensureToolbarShell();
		this.filterQuery = this.searchInputEl?.value ?? "";

		const treeMount = this.treeMountEl;
		if (!treeMount) return;

		treeMount.empty();

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

		this.visibleRowOrder = [];
		for (const root of tree) {
			this.renderNode(treeMount, root, true, false);
		}
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
			this.expandedPaths.clear();
			this.render();
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

		const treeMount = this.containerEl.createDiv({ cls: "bases-structure-tree" });
		this.treeMountEl = treeMount;
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
					this.expandedPaths.add(node.filePath);
					walk(node.children);
				}
			}
		};
		walk(nodes);
	}

	private nodeNameMatchesFilter(node: TreeNode): boolean {
		const q = this.filterQuery.trim().toLowerCase();
		if (!q) return false;
		return node.entry.file.basename.toLowerCase().includes(q);
	}

	/** Show node, path to matches, and full subtree under any matching node. */
	private shouldShowNodeInFilter(node: TreeNode, underMatchedParent: boolean): boolean {
		const q = this.filterQuery.trim();
		if (!q) return true;
		if (underMatchedParent) return true;
		if (this.nodeNameMatchesFilter(node)) return true;
		return node.children.some((child) => this.shouldShowNodeInFilter(child, false));
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

	private buildTree(entries: BasesEntry[]): TreeNode[] {
		const entryMap = new Map<string, BasesEntry>();
		for (const entry of entries) {
			entryMap.set(entry.file.path, entry);
		}

		const parentMap = new Map<string, string[]>();
		for (const entry of entries) {
			parentMap.set(entry.file.path, this.extractParentPaths(entry, entries));
		}

		const childrenMap = new Map<string, string[]>();
		for (const [childPath, parents] of parentMap.entries()) {
			for (const parentPath of parents) {
				const list = childrenMap.get(parentPath) ?? [];
				list.push(childPath);
				childrenMap.set(parentPath, list);
			}
		}

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

	private extractParentPaths(entry: BasesEntry, allEntries: BasesEntry[]): string[] {
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

		const available = new Set(allEntries.map((it) => it.file.path));
		return Array.from(new Set(rawParents)).filter((path) => available.has(path));
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

	private renderNode(
		parentEl: HTMLElement,
		node: TreeNode,
		isLast: boolean,
		underMatchedParent: boolean,
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
		rowEl.style.display = "flex";
		rowEl.style.alignItems = "center";
		rowEl.style.width = "100%";
		rowEl.style.boxSizing = "border-box";
		rowEl.style.gap = "6px";
		rowEl.toggleClass("is-root", node.depth === 0);
		rowEl.toggleClass("is-selected", this.selectedBranchKeys.has(node.branchKey));

		this.visibleRowOrder.push({
			branchKey: node.branchKey,
			filePath: node.filePath,
			parentPath: node.parentPath,
			depth: node.depth,
		});

		this.setupDragAndDrop(rowEl, node);

		const nextUnderMatched =
			underMatchedParent || (filterActive && this.nodeNameMatchesFilter(node));
		const anyChildMatchesFilter =
			filterActive &&
			node.children.some((child) =>
				this.shouldShowNodeInFilter(child, nextUnderMatched),
			);
		const expanded =
			hasChildren &&
			(this.expandedPaths.has(node.filePath) ||
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
				this.toggleExpanded(node.filePath);
				this.render();
			});
		} else {
			toggleWrap.createSpan({ cls: "bases-structure-toggle-placeholder" });
		}

		const titleEl = rowEl.createDiv({ cls: "bases-structure-title" });
		titleEl.style.flex = "1 1 auto";
		titleEl.style.minWidth = "0";
		const linkEl = titleEl.createEl("a", {
			cls: "internal-link",
			text: node.entry.file.basename,
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
		counterEl.style.marginLeft = "auto";
		counterEl.style.textAlign = "right";

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
			);
		});
	}

	private toggleExpanded(filePath: string): void {
		if (this.expandedPaths.has(filePath)) {
			this.expandedPaths.delete(filePath);
		} else {
			this.expandedPaths.add(filePath);
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

	private setupDragAndDrop(rowEl: HTMLElement, node: TreeNode): void {
		rowEl.setAttr("draggable", "true");

		rowEl.addEventListener("dragstart", (evt) => {
			if (!evt.dataTransfer) return;
			const fromSelection =
				this.selectedBranchKeys.has(node.branchKey) && this.selectedBranchKeys.size > 0;
			let sources: DragSourceItem[] = this.visibleRowOrder
				.filter((r) => this.selectedBranchKeys.has(r.branchKey))
				.map((r) => ({ filePath: r.filePath, parentPath: r.parentPath }));
			if (!fromSelection) {
				this.selectedBranchKeys.clear();
				sources = [{ filePath: node.filePath, parentPath: node.parentPath }];
			}
			sources = this.dedupeDragSources(sources);
			if (sources.length === 0) {
				sources = [{ filePath: node.filePath, parentPath: node.parentPath }];
			}
			this.dragState = {
				sources,
				isCopyMode: evt.ctrlKey,
			};
			this.isCtrlPressed = evt.ctrlKey;
			// Must allow both move and copy so Ctrl+drop can use dropEffect "copy".
			// With effectAllowed "move" only, the browser blocks copy and shows "not allowed".
			evt.dataTransfer.effectAllowed = "copyMove";
			evt.dataTransfer.setData(
				"text/plain",
				sources.map((s) => s.filePath).join("\n"),
			);
			rowEl.addClass("is-dragging");
		});

		rowEl.addEventListener("dragend", () => {
			this.dragState = null;
			this.isCtrlPressed = false;
			this.clearDropHighlights();
			rowEl.removeClass("is-dragging");
		});

		rowEl.addEventListener("dragover", (evt) => {
			if (!this.dragState) return;
			evt.preventDefault();
			this.isCtrlPressed = evt.ctrlKey;
			evt.dataTransfer!.dropEffect = this.isCtrlPressed ? "copy" : "move";
			this.clearDropHighlights();
			rowEl.addClass("is-drop-target");
		});

		rowEl.addEventListener("dragleave", (evt) => {
			const related = evt.relatedTarget as HTMLElement | null;
			if (related && rowEl.contains(related)) return;
			rowEl.removeClass("is-drop-target");
		});

		rowEl.addEventListener("drop", (evt) => {
			evt.preventDefault();
			const copyMode = evt.ctrlKey || this.isCtrlPressed || this.dragState?.isCopyMode === true;
			void this.handleDropOnNode(node, copyMode);
		});
	}

	private clearDropHighlights(): void {
		this.containerEl.querySelectorAll(".is-drop-target").forEach((el) => {
			el.removeClass("is-drop-target");
		});
	}

	private async handleDropOnNode(targetNode: TreeNode, isCopyMode: boolean): Promise<void> {
		const drag = this.dragState;
		this.dragState = null;
		this.isCtrlPressed = false;
		this.clearDropHighlights();
		if (!drag) return;

		const ordered = this.sortSourcesDeepestFirst(drag.sources);
		let moved = 0;
		for (const item of ordered) {
			if (item.filePath === targetNode.filePath) {
				continue;
			}
			const entries = this.getAllEntries();
			const entryMap = new Map(entries.map((e) => [e.file.path, e] as const));
			const sourceEntry = entryMap.get(item.filePath);
			const targetEntry = entryMap.get(targetNode.filePath);
			if (!sourceEntry || !targetEntry) {
				continue;
			}
			if (this.wouldCreateCycle(entries, item.filePath, targetNode.filePath)) {
				if (ordered.length === 1) {
					new Notice("This operation would create a cycle.");
				}
				continue;
			}
			await this.updateRelationForMove(
				sourceEntry.file,
				targetEntry.file.path,
				item.parentPath,
				isCopyMode,
			);
			moved += 1;
		}

		if (moved > 0) {
			this.selectedBranchKeys.clear();
			this.selectionAnchorBranchKey = null;
			this.expandedPaths.add(targetNode.filePath);
		}
		this.render();
	}

	private wouldCreateCycle(entries: BasesEntry[], sourcePath: string, newParentPath: string): boolean {
		const childrenMap = new Map<string, string[]>();
		for (const entry of entries) {
			const childPath = entry.file.path;
			const parents = this.extractParentPaths(entry, entries);
			for (const parent of parents) {
				const list = childrenMap.get(parent) ?? [];
				list.push(childPath);
				childrenMap.set(parent, list);
			}
		}

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
		const newParentLink = this.toWikiLink(newParentPath, file);

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
			} else if (links.length === 1) {
				frontmatter[property] = links[0];
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

	private toWikiLink(path: string, sourceFile: TFile): string {
		const target = this.app.vault.getAbstractFileByPath(path);
		if (!(target instanceof TFile)) {
			const noExt = path.endsWith(".md") ? path.slice(0, -3) : path;
			return `[[${noExt}]]`;
		}
		const linktext = this.app.metadataCache.fileToLinktext(target, sourceFile.path, true);
		return `[[${linktext}]]`;
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
