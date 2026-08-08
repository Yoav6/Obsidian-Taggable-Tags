import { ItemView, WorkspaceLeaf, TFile, setIcon, Modal, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { renameTag } from '../sync/rename-command';
import { createTagFile } from '../sync/auto-create';
import { markPluginInitiatedChange } from '../sync/file-rename-sync';
import { removeTagFromFile } from '../sync/delete-tag';
import { addDeleteTagSubmenu, addNewSubmenu } from './tag-context-menu';

export const TAG_EXPLORER_VIEW_TYPE = 'taggable-tags-explorer';

// Represents either a single tag or a group of combined tags
interface TagOrGroup {
	tags: string[];  // One or more tags (combined if they have identical children)
	displayName: string;  // e.g., "history" or "history + fiction"
}

/** A place where the active file appears in the explorer */
interface FileInstance {
	/** Unique key matching data-instance-key on the rendered element */
	instanceKey: string;
	/** Tree paths that must be expanded to make this instance visible */
	expandPaths: string[];
}

export class TagExplorerView extends ItemView {
	private plugin: TaggableTagsPlugin;
	// Track expanded state by tree path (e.g., "root>parent>child") to allow
	// independent expansion of the same tag appearing in multiple places
	private expandedPaths: Set<string> = new Set();
	// Track scroll position for navigation
	private tagElements: Map<string, HTMLElement> = new Map();
	// Filter tags - show only descendants of ALL these tags
	private filterTags: Set<string> = new Set();
	// Exclude tags - hide descendants of these tags from results
	private excludeTags: Set<string> = new Set();
	// Style element (kept outside contentEl so it persists across refreshes)
	private styleEl: HTMLStyleElement | null = null;
	// View mode: tree (hierarchical) or list (flat)
	private viewMode: 'tree' | 'list' = 'tree';
	// Content mode: what to show in the view
	private contentMode: 'all' | 'tags' | 'files' = 'all';
	// Cycle-reveal: which file we're cycling and the next index to show
	private revealCycleFilePath: string | null = null;
	private revealCycleIndex: number = 0;
	// After refresh, scroll/highlight this instance key (skip scroll restore)
	private pendingRevealKey: string | null = null;
	private pendingRevealFilePath: string | null = null;
	private highlightTimeout: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: TaggableTagsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	/**
	 * Build a tree path string from an array of ancestor tags
	 * Used as a unique key for tracking expansion state of each tree position
	 */
	private buildTreePath(ancestors: string[], tag: string): string {
		return [...ancestors, tag].join('>');
	}

	/**
	 * Check if a tag at a specific tree position is expanded
	 */
	private isPathExpanded(treePath: string): boolean {
		return this.expandedPaths.has(treePath);
	}

	/**
	 * Toggle expansion state for a tag at a specific tree position
	 */
	private togglePathExpansion(treePath: string, expand: boolean): void {
		if (expand) {
			this.expandedPaths.add(treePath);
		} else {
			this.expandedPaths.delete(treePath);
		}
	}

	/**
	 * Expand all tags recursively, building proper tree paths
	 */
	private expandAllTagsRecursively(): void {
		const rootTags = this.plugin.tagIndex.getRootTags();
		for (const tag of rootTags) {
			this.expandTagAndChildren(tag, []);
		}
	}

	/**
	 * Recursively expand a tag and all its children, tracking the ancestor path
	 */
	private expandTagAndChildren(tag: string, ancestors: string[], visited: Set<string> = new Set()): void {
		// Prevent infinite recursion on cycles
		if (visited.has(tag)) {
			return;
		}
		visited.add(tag);

		const treePath = this.buildTreePath(ancestors, tag);
		this.expandedPaths.add(treePath);

		const children = this.plugin.tagIndex.getChildTags(tag);
		const newAncestors = [...ancestors, tag];
		for (const child of children) {
			this.expandTagAndChildren(child, newAncestors, new Set(visited));
		}
	}

	getViewType(): string {
		return TAG_EXPLORER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Tag Explorer';
	}

	getIcon(): string {
		return 'tags';
	}

	/**
	 * Get the icon for the current content mode
	 */
	private getContentModeIcon(): string {
		switch (this.contentMode) {
			case 'all': return 'layout-list';
			case 'tags': return 'tag';
			case 'files': return 'file';
		}
	}

	/**
	 * Get the label for the current content mode button
	 */
	private getContentModeLabel(): string {
		switch (this.contentMode) {
			case 'all': return 'Showing tags and files (click to show only tags)';
			case 'tags': return 'Showing only tags (click to show only files)';
			case 'files': return 'Showing only files (click to show tags and files)';
		}
	}

	async onOpen(): Promise<void> {
		this.contentEl = this.containerEl.children[1] as HTMLElement;
		this.contentEl.empty();
		this.contentEl.addClass('taggable-tags-explorer');

		// Add styles to containerEl (not contentEl) so they persist across refreshes
		this.addStyles();

		// Render the tree
		await this.refresh();

		// Listen for changes to rebuild
		this.registerEvent(
			this.plugin.app.metadataCache.on('changed', () => {
				this.debouncedRefresh();
			})
		);

		this.registerEvent(
			this.plugin.app.vault.on('rename', () => {
				this.debouncedRefresh();
			})
		);

		this.registerEvent(
			this.plugin.app.vault.on('delete', () => {
				this.debouncedRefresh();
			})
		);

		this.registerEvent(
			this.plugin.app.vault.on('create', () => {
				this.debouncedRefresh();
			})
		);
	}

	private refreshTimeout: number | null = null;
	private debouncedRefresh(): void {
		if (this.refreshTimeout) {
			window.clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = window.setTimeout(() => {
			this.refresh();
		}, 500);
	}

	async refresh(): Promise<void> {
		// Rebuild the tag index
		await this.plugin.tagIndex.rebuild();

		// Save scroll position before clearing
		const oldScrollContainer = this.contentEl.querySelector('.scroll-container');
		const savedScrollTop = oldScrollContainer?.scrollTop ?? 0;

		// Clear and re-render
		this.contentEl.empty();
		this.tagElements.clear();

		// Create fixed header container that wraps both nav-header and filter-bar
		const fixedHeader = this.contentEl.createEl('div', { cls: 'fixed-header' });

		// Create header with buttons
		const header = fixedHeader.createEl('div', { cls: 'nav-header' });
		const headerButtons = header.createEl('div', { cls: 'nav-buttons-container' });
		
		// Toggle expand/collapse button
		const allTags = this.plugin.tagIndex.getAllTags();
		// Check if anything is expanded (simplified check)
		const hasExpanded = this.expandedPaths.size > 0;
		const toggleBtn = headerButtons.createEl('div', { 
			cls: 'clickable-icon nav-action-button', 
			attr: { 'aria-label': hasExpanded ? 'Collapse all' : 'Expand all' } 
		});
		setIcon(toggleBtn, hasExpanded ? 'chevrons-down-up' : 'chevrons-up-down');
		toggleBtn.addEventListener('click', () => {
			if (hasExpanded) {
				this.expandedPaths.clear();
			} else {
				// Expand all tags at all positions - we'll collect paths during render
				this.expandAllTagsRecursively();
			}
			this.refresh();
		});

		// New note button
		const newNoteBtn = headerButtons.createEl('div', { 
			cls: 'clickable-icon nav-action-button', 
			attr: { 'aria-label': 'New note' } 
		});
		setIcon(newNoteBtn, 'file-plus');
		newNoteBtn.addEventListener('click', () => {
			// Trigger Obsidian's default new file command
			(this.plugin.app as any).commands.executeCommandById('file-explorer:new-file');
		});

		// New tag button
		const newTagBtn = headerButtons.createEl('div', { 
			cls: 'clickable-icon nav-action-button', 
			attr: { 'aria-label': 'New tag' } 
		});
		setIcon(newTagBtn, 'tag');
		newTagBtn.addEventListener('click', () => {
			new CreateTagModal(this.plugin, () => this.refresh()).open();
		});

		// Tree/List view mode toggle
		// In files-only mode with tree view: disabled (grayed out) since files are always flat
		// In files-only mode with list view: clicking switches to tags-and-files mode (tree view)
		const isFilesOnlyTreeMode = this.contentMode === 'files' && this.viewMode === 'tree';
		const viewModeBtn = headerButtons.createEl('div', { 
			cls: `clickable-icon nav-action-button${isFilesOnlyTreeMode ? ' is-disabled' : ''}`, 
			attr: { 'aria-label': isFilesOnlyTreeMode ? 'Tree view not available in files-only mode' : (this.viewMode === 'tree' ? 'Switch to list view' : 'Switch to tree view') } 
		});
		setIcon(viewModeBtn, this.viewMode === 'tree' ? 'list-tree' : 'list');
		if (!isFilesOnlyTreeMode) {
			viewModeBtn.addEventListener('click', () => {
				if (this.contentMode === 'files' && this.viewMode === 'list') {
					// In files-only list mode, switching to tree also switches to tags-and-files mode
					this.viewMode = 'tree';
					this.contentMode = 'all';
				} else {
					this.viewMode = this.viewMode === 'tree' ? 'list' : 'tree';
				}
				this.refresh();
			});
		}

		// Content mode toggle (tags+files / only tags / only files)
		const contentModeBtn = headerButtons.createEl('div', { 
			cls: 'clickable-icon nav-action-button', 
			attr: { 'aria-label': this.getContentModeLabel() } 
		});
		setIcon(contentModeBtn, this.getContentModeIcon());
		contentModeBtn.addEventListener('click', () => {
			// Cycle through modes: all -> tags -> files -> all
			if (this.contentMode === 'all') {
				this.contentMode = 'tags';
			} else if (this.contentMode === 'tags') {
				this.contentMode = 'files';
			} else {
				this.contentMode = 'all';
			}
			this.refresh();
		});

		// Reveal / cycle active file instances
		const revealBtn = headerButtons.createEl('div', {
			cls: 'clickable-icon nav-action-button',
			attr: { 'aria-label': 'Reveal active file' }
		});
		setIcon(revealBtn, 'crosshair');
		revealBtn.addEventListener('click', () => {
			this.revealNextActiveFileInstance();
		});

		// Render filter bar inside the fixed header
		this.renderFilterBar(fixedHeader);

		// Create scrollable content area
		const scrollContainer = this.contentEl.createEl('div', { cls: 'scroll-container' });

		// Get tags to display (filtered or all root tags)
		const tagsToRender = this.getFilteredTags();
		
		// Get untagged files if enabled and not filtering
		const untaggedFiles = (this.plugin.settings.showUntaggedFiles && this.filterTags.size === 0 && this.contentMode !== 'tags')
			? this.plugin.tagIndex.getUntaggedFiles()
			: [];

		// Get vault-root attachments if enabled and not filtering
		const rootAttachments = (this.plugin.settings.displayAttachments && this.filterTags.size === 0 && this.contentMode !== 'tags')
			? this.getRootAttachments()
			: [];
		
		// Determine what content to show based on content mode
		const showTags = this.contentMode !== 'files';
		const showFiles = this.contentMode !== 'tags';
		
		const hasContent = (showTags && tagsToRender.tags.length > 0) || 
			(showFiles && (tagsToRender.files.length > 0 || untaggedFiles.length > 0 || rootAttachments.length > 0));
		
		if (!hasContent) {
			// Render empty state outside the tree to avoid hover/click issues
			if (this.filterTags.size > 0) {
				scrollContainer.createEl('div', { 
					text: 'No items match all selected filters.',
					cls: 'empty-state'
				});
			} else {
				scrollContainer.createEl('div', { 
					text: 'No tags found. Create a tag in any file to get started.',
					cls: 'empty-state'
				});
			}
		} else {
			// Create the tree container only when there's content
			const treeContainer = scrollContainer.createEl('div', { cls: 'nav-files-container node-insert-event' });
			const tree = treeContainer.createEl('div', { cls: 'tree-item nav-folder mod-root' });
			
			if (this.contentMode === 'files') {
				// Only files mode - show flat list of all files
				const allFiles = this.getAllFilesForDisplay(tagsToRender);
				for (const file of allFiles.sort((a, b) => a.basename.localeCompare(b.basename))) {
					this.renderFileNode(tree, file, 0, true, 'file:__flat__');
				}
			} else if (this.viewMode === 'list') {
				// List mode - flat list without nesting, interleaved alphabetically
				const allTags = showTags ? this.getAllTagsForDisplay(tagsToRender.tags) : [];
				const allFiles = showFiles ? this.getAllFilesForDisplay(tagsToRender) : [];
				
				// Create combined list with type info for sorting
				const items: Array<{ type: 'tag' | 'file', name: string, tag?: string, file?: TFile }> = [];
				for (const tag of allTags) {
					items.push({ type: 'tag', name: tag, tag });
				}
				for (const file of allFiles) {
					items.push({ type: 'file', name: file.basename, file });
				}
				
				// Sort alphabetically by name
				items.sort((a, b) => a.name.localeCompare(b.name));
				
				// Render in sorted order
				for (const item of items) {
					if (item.type === 'tag' && item.tag) {
						this.renderFlatTagNode(tree, item.tag);
					} else if (item.type === 'file' && item.file) {
						this.renderFileNode(tree, item.file, 0, true, 'file:__flat__');
					}
				}
			} else {
				// Tree mode - hierarchical rendering
				if (showTags) {
					const groups = this.groupTagsByChildren(tagsToRender.tags);
					for (const group of groups) {
						this.renderTagOrGroupNode(tree, group, 0);
					}
				}
				// Render files directly under root if filtering (and showing files)
				if (showFiles && this.filterTags.size > 0) {
					for (const file of tagsToRender.files.sort((a, b) => a.basename.localeCompare(b.basename))) {
						this.renderFileNode(tree, file, 0, false, 'file:__root__');
					}
				}
			}
			
			// Render untagged files at the bottom (only when not filtering and showing files)
			if (showFiles && untaggedFiles.length > 0 && this.viewMode === 'tree') {
				if (this.plugin.settings.groupUntaggedFiles) {
					// Render as a collapsible "Untagged" group
					this.renderUntaggedGroup(tree, untaggedFiles);
				} else {
					// Render files directly at top level
					for (const file of untaggedFiles) {
						this.renderFileNode(tree, file, 0, false, 'file:__root__');
					}
					// Attachments referenced by untagged files, shown alongside them
					const untaggedAttachments = this.collectAlongsideAttachments(untaggedFiles);
					this.renderAttachmentGroup(tree, untaggedAttachments, '__attachments__:__untagged__', 0);
				}
			}

			// Render vault-root attachments (only when not filtering and showing files)
			if (this.plugin.settings.displayAttachments && showFiles && rootAttachments.length > 0 && this.viewMode === 'tree') {
				this.renderAttachmentGroup(tree, rootAttachments, '__attachments__:root', 0);
			}
		}

		// Restore scroll position after re-render (unless we're revealing an instance)
		const newScrollContainer = this.contentEl.querySelector('.scroll-container');
		if (this.pendingRevealKey) {
			const key = this.pendingRevealKey;
			const filePath = this.pendingRevealFilePath;
			this.pendingRevealKey = null;
			this.pendingRevealFilePath = null;
			// Apply immediately so the next paint already shows the target position
			this.applyRevealHighlight(key, filePath);
		} else if (newScrollContainer && savedScrollTop > 0) {
			newScrollContainer.scrollTop = savedScrollTop;
		}
	}

	/**
	 * Get all tags for display in list mode (flat, no duplicates)
	 */
	private getAllTagsForDisplay(rootTags: string[]): string[] {
		if (this.filterTags.size > 0) {
			// When filtering, get all descendant tags
			const allTags = new Set<string>();
			for (const tag of rootTags) {
				allTags.add(tag);
				for (const descendant of this.getAllDescendantTags(tag)) {
					allTags.add(descendant);
				}
			}
			return Array.from(allTags);
		} else {
			// No filtering - get all tags
			return this.plugin.tagIndex.getAllTags();
		}
	}

	/**
	 * Get all files for display in list/files-only mode
	 */
	private getAllFilesForDisplay(tagsToRender: { tags: string[], files: TFile[] }): TFile[] {
		const allFiles = new Set<TFile>();
		
		if (this.filterTags.size > 0) {
			// When filtering, use the filtered files
			for (const file of tagsToRender.files) {
				allFiles.add(file);
			}
		} else {
			// No filtering - get all files with tags
			for (const tag of this.plugin.tagIndex.getAllTags()) {
				for (const file of this.plugin.tagIndex.getFilesWithTag(tag)) {
					allFiles.add(file);
				}
			}
		}
		
		return Array.from(allFiles);
	}

	/**
	 * Render a flat tag node (for list mode)
	 */
	private renderFlatTagNode(container: HTMLElement, tag: string): void {
		const hasTagFile = this.plugin.tagIndex.getTagFile(tag) !== null;
		
		const tagItem = container.createEl('div', { 
			cls: `tree-item nav-folder is-collapsed${!hasTagFile ? ' tag-no-file' : ''}`
		});
		
		this.tagElements.set(tag, tagItem);

		const tagTitle = tagItem.createEl('div', { 
			cls: 'tree-item-self is-clickable tag-item list-mode-item',
			attr: { 
				'data-tag': tag,
				'data-instance-key': `tag:__flat__:${tag}`
			}
		});

		// Tag icon (replaces the expand/collapse arrow in list mode)
		const tagIcon = tagTitle.createEl('div', { cls: 'list-mode-icon' });
		setIcon(tagIcon, 'tag');

		// Tag name container
		const tagNameContainer = tagTitle.createEl('span', { cls: 'tag-name' });
		tagNameContainer.textContent = tag;
		
		// Left click on name opens the file (Ctrl+click opens in new tab)
		tagNameContainer.addEventListener('click', async (e) => {
			e.stopPropagation();
			const tagFile = this.plugin.tagIndex.getTagFile(tag);
			if (tagFile) {
				const leaf = e.ctrlKey || e.metaKey 
					? this.plugin.app.workspace.getLeaf('tab')
					: this.plugin.app.workspace.getLeaf();
				await leaf.openFile(tagFile);
			}
		});

		// Right click shows context menu
		tagTitle.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showTagContextMenu(e, tag, []);
		});
	}

	/**
	 * Render a tag or group of combined tags
	 * @param ancestors - Array of ancestor tag names (for building tree path)
	 * @param ancestorSet - Set of tags in the current ancestor path (for cycle detection)
	 */
	private renderTagOrGroupNode(container: HTMLElement, group: TagOrGroup, depth: number, ancestors: string[] = [], ancestorSet: Set<string> = new Set()): void {
		// Use the first tag for expansion state and children lookup
		const primaryTag = group.tags[0];
		
		// Build tree path for this specific position in the tree
		const treePath = this.buildTreePath(ancestors, primaryTag);
		const isExpanded = this.isPathExpanded(treePath);
		
		// Get children, excluding any that are already in our ancestor path (cycle prevention)
		// Also filter out children that are exceptions to this tag or are exclusive
		const allChildren = this.plugin.tagIndex.getChildTags(primaryTag);
		// Build the full ancestor set including the current tag for exception checking
		const fullAncestorSet = new Set([...ancestorSet, primaryTag]);
		const children = allChildren.filter(child => {
			// Cycle prevention
			if (ancestorSet.has(child)) return false;
			// Exception tag filtering: if child is an exception to any ancestor, don't show it here
			if (this.isExceptionToAnyAncestor(child, fullAncestorSet)) return false;
			// Exclusive tag filtering: exclusive tags only show as roots, not under other tags
			if (this.plugin.tagIndex.isExclusiveTag(child)) return false;
			// Check if child has any parent tag that is an exception to any ancestor
			if (this.hasExceptionTagToAnyAncestor(child, fullAncestorSet)) return false;
			return true;
		});
		// Create a set of child tag names for quick lookup
		const files = this.getVisibleFilesUnderTag(primaryTag, children, fullAncestorSet);
		const attachmentsHere = this.collectTagAttachments(group.tags, files);
		const hasChildren = children.length > 0 || files.length > 0 || attachmentsHere.length > 0;

		// Single tags without a file get parent-level graying; combined tags
		// use per-part tag-name-no-file instead (avoids stacked opacity).
		const isCombined = group.tags.length > 1;
		const hasTagFile = this.plugin.tagIndex.getTagFile(primaryTag) !== null;
		const applyParentNoFile = !isCombined && !hasTagFile;

		// Create the tag item
		const tagItem = container.createEl('div', { 
			cls: `tree-item nav-folder${isExpanded ? ' is-expanded' : ''}${!hasChildren ? ' is-collapsed' : ''}${applyParentNoFile ? ' tag-no-file' : ''}`
		});
		
		// Store reference for navigation (for all tags in the group)
		for (const tag of group.tags) {
			this.tagElements.set(tag, tagItem);
		}

		const tagTitle = tagItem.createEl('div', { 
			cls: 'tree-item-self is-clickable tag-item',
			attr: { 
				'data-tag': group.tags.join(','),
				'data-instance-key': `tag:${treePath}`
			}
		});
		tagTitle.style.paddingLeft = `${depth * 12 + 4}px`;

		// Expand/collapse arrow
		const expandIcon = tagTitle.createEl('div', { 
			cls: 'nav-folder-collapse-indicator collapse-icon' 
		});
		setIcon(expandIcon, isExpanded ? 'chevron-down' : 'chevron-right');

		// Tag name container
		const tagNameContainer = tagTitle.createEl('span', { cls: 'tag-name' });
		
		if (group.tags.length === 1) {
			// Single tag - simple clickable name
			tagNameContainer.textContent = group.displayName;
			// Left click on name opens the file (Ctrl+click opens in new tab)
			tagNameContainer.addEventListener('click', async (e) => {
				e.stopPropagation();
				const tagFile = this.plugin.tagIndex.getTagFile(primaryTag);
				if (tagFile) {
					const leaf = e.ctrlKey || e.metaKey 
						? this.plugin.app.workspace.getLeaf('tab')
						: this.plugin.app.workspace.getLeaf();
					await leaf.openFile(tagFile);
				}
			});
			// Right click on name shows full context menu (handled by tagTitle contextmenu)
		} else {
			// Combined tags - each tag is individually clickable
			group.tags.forEach((tag, index) => {
				if (index > 0) {
					tagNameContainer.createEl('span', { text: ' + ', cls: 'tag-name-separator' });
				}
				// Check if this specific tag has a file
				const tagHasFile = this.plugin.tagIndex.getTagFile(tag) !== null;
				const tagSpan = tagNameContainer.createEl('span', { 
					text: tag, 
					cls: `tag-name-part${!tagHasFile ? ' tag-name-no-file' : ''}`
				});
				// Left click on tag name opens its file (Ctrl+click opens in new tab)
				tagSpan.addEventListener('click', async (e) => {
					e.stopPropagation();
					const tagFile = this.plugin.tagIndex.getTagFile(tag);
					if (tagFile) {
						const leaf = e.ctrlKey || e.metaKey 
							? this.plugin.app.workspace.getLeaf('tab')
							: this.plugin.app.workspace.getLeaf();
						await leaf.openFile(tagFile);
					}
				});
				// Right click on tag name shows its full context menu
				tagSpan.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.showTagContextMenu(e, tag);
				});
			});
		}

		// Click handler for expand/collapse (clicking anywhere except the name)
		tagTitle.addEventListener('click', (e) => {
			e.stopPropagation();
			// Toggle expansion for this specific tree position
			this.togglePathExpansion(treePath, !isExpanded);
			this.refresh();
		});

		// Right click handler - different behavior for single vs combined tags
		tagTitle.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (group.tags.length === 1) {
				// Single tag: show full context menu anywhere
				this.showTagContextMenu(e, primaryTag, ancestors);
			} else {
				// Combined tags: show collapse/expand only menu (unless clicking on a tag name, which is handled above)
				this.showCollapseExpandMenu(e, group.tags, ancestors);
			}
		});

		// Render children if expanded
		if (isExpanded && hasChildren) {
			const childrenContainer = tagItem.createEl('div', { cls: 'tree-item-children nav-folder-children' });

			// Build the new ancestor path including all tags in this group
			const newAncestors = [...ancestors, primaryTag];
			const newAncestorSet = new Set(ancestorSet);
			for (const tag of group.tags) {
				newAncestorSet.add(tag);
			}

			// Render child tags first (grouped)
			const childGroups = this.groupTagsByChildren(children);
			for (const childGroup of childGroups) {
				this.renderTagOrGroupNode(childrenContainer, childGroup, depth + 1, newAncestors, newAncestorSet);
			}

			// Then render files
			for (const file of files.sort((a, b) => a.basename.localeCompare(b.basename))) {
				this.renderFileNode(childrenContainer, file, depth + 1, false, `file:${treePath}`);
			}

			// Then render attachments (folder-connected + referenced alongside notes)
			this.renderAttachmentGroup(childrenContainer, attachmentsHere, `__attachments__:${treePath}`, depth + 1);
		}
	}

	private renderTagNode(container: HTMLElement, tag: string, depth: number, ancestors: string[] = [], ancestorSet: Set<string> = new Set()): void {
		// Delegate to renderTagOrGroupNode with a single-tag group
		this.renderTagOrGroupNode(container, { tags: [tag], displayName: tag }, depth, ancestors, ancestorSet);
	}

	private renderFileNode(container: HTMLElement, file: TFile, depth: number, listMode: boolean = false, instanceKey: string = 'file:__flat__'): void {
		const fileItem = container.createEl('div', { cls: 'tree-item nav-file' });
		
		const fileTitle = fileItem.createEl('div', { 
			cls: `tree-item-self is-clickable file-item${listMode ? ' list-mode-item' : ''}`,
			attr: { 
				'data-path': file.path,
				'data-instance-key': instanceKey
			}
		});
		
		if (listMode) {
			// List mode - add file icon, no extra padding
			const fileIcon = fileTitle.createEl('div', { cls: 'list-mode-icon' });
			setIcon(fileIcon, 'file');
		} else {
			// Tree mode - indent to align with tag names (after the arrow)
			fileTitle.style.paddingLeft = `${depth * 12 + 8}px`;
		}

		// File name
		const fileName = fileTitle.createEl('span', { cls: 'file-name' });
		fileName.textContent = file.basename;

		// Show the file format on the right for non-markdown files (like Obsidian's file explorer)
		if (file.extension !== 'md') {
			const fileTag = fileTitle.createEl('span', { cls: 'nav-file-tag' });
			fileTag.textContent = file.extension.toUpperCase();
		}

		// Click to open file (Ctrl+click opens in new tab)
		fileTitle.addEventListener('click', async (e) => {
			e.stopPropagation();
			const leaf = e.ctrlKey || e.metaKey 
				? this.plugin.app.workspace.getLeaf('tab')
				: this.plugin.app.workspace.getLeaf();
			await leaf.openFile(file);
		});

		// Context menu
		fileTitle.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.showFileContextMenu(e, file);
		});
	}

	/**
	 * Render the "Untagged" group with collapsible files
	 */
	private renderUntaggedGroup(container: HTMLElement, files: TFile[]): void {
		const UNTAGGED_KEY = '__untagged__';
		const isExpanded = this.expandedPaths.has(UNTAGGED_KEY);
		
		// Create the untagged item
		const untaggedItem = container.createEl('div', { 
			cls: `tree-item nav-folder${isExpanded ? ' is-expanded' : ''}`
		});

		const untaggedTitle = untaggedItem.createEl('div', { 
			cls: 'tree-item-self is-clickable tag-item untagged-item',
		});
		untaggedTitle.style.paddingLeft = '4px';

		// Expand/collapse arrow
		const expandIcon = untaggedTitle.createEl('div', { 
			cls: 'nav-folder-collapse-indicator collapse-icon' 
		});
		setIcon(expandIcon, isExpanded ? 'chevron-down' : 'chevron-right');

		// "Untagged" label
		const label = untaggedTitle.createEl('span', { cls: 'tag-name untagged-label' });
		label.textContent = 'Untagged';

		// Click handler for expand/collapse
		untaggedTitle.addEventListener('click', (e) => {
			e.stopPropagation();
			if (isExpanded) {
				this.expandedPaths.delete(UNTAGGED_KEY);
			} else {
				this.expandedPaths.add(UNTAGGED_KEY);
			}
			this.refresh();
		});

		// Render children if expanded
		if (isExpanded) {
			const childrenContainer = untaggedItem.createEl('div', { cls: 'tree-item-children nav-folder-children' });
			for (const file of files) {
				this.renderFileNode(childrenContainer, file, 1, false, 'file:__untagged__');
			}
			// Attachments referenced by untagged files, shown alongside them
			const attachments = this.collectAlongsideAttachments(files);
			this.renderAttachmentGroup(childrenContainer, attachments, '__attachments__:__untagged__', 2);
		}
	}

	/**
	 * Collect referenced attachments for a set of notes (for "alongside" placement).
	 * Returns an empty array when attachments are disabled, the alongside setting is
	 * "no", or the content mode hides files.
	 */
	private collectAlongsideAttachments(notes: TFile[]): TFile[] {
		if (!this.plugin.settings.displayAttachments
			|| this.plugin.settings.attachmentsAlongside === 'no'
			|| this.contentMode === 'tags') {
			return [];
		}
		const result: TFile[] = [];
		for (const note of notes) {
			for (const file of this.plugin.tagIndex.getReferencedAttachments(note)) {
				result.push(file);
			}
		}
		return result;
	}

	/**
	 * Collect the attachments to show under a tag: folder-connected attachments for
	 * the tag(s), plus (when enabled) attachments referenced by the notes shown there.
	 */
	private collectTagAttachments(tags: string[], notesUnderTag: TFile[]): TFile[] {
		if (!this.plugin.settings.displayAttachments || this.contentMode === 'tags') {
			return [];
		}
		const result: TFile[] = [];
		for (const tag of tags) {
			for (const file of this.plugin.tagIndex.getFolderAttachmentsForTag(tag)) {
				result.push(file);
			}
		}
		result.push(...this.collectAlongsideAttachments(notesUnderTag));
		return result;
	}

	/**
	 * Compute the attachments shown at the vault root, per the placement rules:
	 * - folder-connected attachments live under their tag (never at root)
	 * - unreferenced attachments are always at root
	 * - referenced attachments are at root unless the alongside setting is "instead"
	 */
	private getRootAttachments(): TFile[] {
		const alongside = this.plugin.settings.attachmentsAlongside;
		const result: TFile[] = [];
		for (const file of this.plugin.tagIndex.getAllAttachments()) {
			if (this.plugin.tagIndex.isFolderConnectedAttachment(file)) {
				continue;
			}
			if (this.plugin.tagIndex.isAttachmentReferenced(file)) {
				if (alongside !== 'instead') {
					result.push(file);
				}
			} else {
				result.push(file);
			}
		}
		return result;
	}

	/**
	 * Deduplicate attachments by path and sort by basename.
	 */
	private dedupSortedAttachments(attachments: TFile[]): TFile[] {
		const seen = new Set<string>();
		const result: TFile[] = [];
		for (const file of attachments) {
			if (seen.has(file.path)) continue;
			seen.add(file.path);
			result.push(file);
		}
		return result.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/**
	 * Render a set of attachments according to the "Group attachments" setting:
	 * inline, under a collapsible "Attachments" group, or (when split) that group
	 * divided into "Referenced" and "Unreferenced" subgroups.
	 *
	 * With "split", subgroups are only used when the group contains both referenced
	 * and unreferenced attachments. If it only has referenced attachments, they are
	 * listed directly under "Attachments"; if it only has unreferenced attachments,
	 * they are listed directly under "Unreferenced attachments".
	 */
	private renderAttachmentGroup(container: HTMLElement, attachments: TFile[], keyBase: string, depth: number): void {
		if (!this.plugin.settings.displayAttachments) return;
		const unique = this.dedupSortedAttachments(attachments);
		if (unique.length === 0) return;

		const grouping = this.plugin.settings.attachmentGrouping;

		if (grouping === 'no') {
			for (const file of unique) {
				this.renderFileNode(container, file, depth, false, `attachment:${keyBase}`);
			}
			return;
		}

		// Determine whether "split" actually needs subgroups and the group's label.
		let referenced: TFile[] = [];
		let unreferenced: TFile[] = [];
		let useSubgroups = false;
		let labelText = 'Attachments';
		if (grouping === 'split') {
			referenced = unique.filter(f => this.plugin.tagIndex.isAttachmentReferenced(f));
			unreferenced = unique.filter(f => !this.plugin.tagIndex.isAttachmentReferenced(f));
			useSubgroups = referenced.length > 0 && unreferenced.length > 0;
			if (!useSubgroups && referenced.length === 0) {
				// Only unreferenced attachments - label the group accordingly.
				labelText = 'Unreferenced attachments';
			}
		}

		// 'yes' or 'split': collapsible group folder
		const isExpanded = this.expandedPaths.has(keyBase);
		const item = container.createEl('div', {
			cls: `tree-item nav-folder${isExpanded ? ' is-expanded' : ''}`
		});

		const title = item.createEl('div', {
			cls: 'tree-item-self is-clickable tag-item attachment-group-item',
		});
		title.style.paddingLeft = `${depth * 12 + 4}px`;

		const expandIcon = title.createEl('div', {
			cls: 'nav-folder-collapse-indicator collapse-icon'
		});
		setIcon(expandIcon, isExpanded ? 'chevron-down' : 'chevron-right');

		const label = title.createEl('span', { cls: 'tag-name attachment-group-label' });
		label.textContent = labelText;

		title.addEventListener('click', (e) => {
			e.stopPropagation();
			if (isExpanded) {
				this.expandedPaths.delete(keyBase);
			} else {
				this.expandedPaths.add(keyBase);
			}
			this.refresh();
		});

		if (!isExpanded) return;

		const childrenContainer = item.createEl('div', { cls: 'tree-item-children nav-folder-children' });

		if (grouping === 'split' && useSubgroups) {
			this.renderAttachmentSubgroup(childrenContainer, 'Referenced', `${keyBase}:ref`, depth + 1, referenced);
			this.renderAttachmentSubgroup(childrenContainer, 'Unreferenced', `${keyBase}:unref`, depth + 1, unreferenced);
		} else {
			for (const file of unique) {
				this.renderFileNode(childrenContainer, file, depth + 1, false, `attachment:${keyBase}`);
			}
		}
	}

	/**
	 * Render a collapsible subgroup ("Referenced" / "Unreferenced") of attachments.
	 */
	private renderAttachmentSubgroup(container: HTMLElement, labelText: string, key: string, depth: number, files: TFile[]): void {
		if (files.length === 0) return;

		const isExpanded = this.expandedPaths.has(key);
		const item = container.createEl('div', {
			cls: `tree-item nav-folder${isExpanded ? ' is-expanded' : ''}`
		});

		const title = item.createEl('div', {
			cls: 'tree-item-self is-clickable tag-item attachment-subgroup-item',
		});
		title.style.paddingLeft = `${depth * 12 + 4}px`;

		const expandIcon = title.createEl('div', {
			cls: 'nav-folder-collapse-indicator collapse-icon'
		});
		setIcon(expandIcon, isExpanded ? 'chevron-down' : 'chevron-right');

		const label = title.createEl('span', { cls: 'tag-name attachment-subgroup-label' });
		label.textContent = labelText;

		title.addEventListener('click', (e) => {
			e.stopPropagation();
			if (isExpanded) {
				this.expandedPaths.delete(key);
			} else {
				this.expandedPaths.add(key);
			}
			this.refresh();
		});

		if (!isExpanded) return;

		const childrenContainer = item.createEl('div', { cls: 'tree-item-children nav-folder-children' });
		for (const file of files) {
			this.renderFileNode(childrenContainer, file, depth + 1, false, `attachment:${key}`);
		}
	}

	private showTagContextMenu(event: MouseEvent, tag: string, ancestors: string[] = []): void {
		const menu = new (require('obsidian').Menu)();
		const tagFile = this.plugin.tagIndex.getTagFile(tag);
		
		if (tagFile) {
			// Tag has a file - show normal options
			menu.addItem((item: any) => {
				item.setTitle('Open tag file')
					.setIcon('file-text')
					.onClick(async () => {
						await this.plugin.app.workspace.getLeaf().openFile(tagFile);
					});
			});

			menu.addItem((item: any) => {
				item.setTitle('Rename tag')
					.setIcon('pencil')
					.onClick(() => {
						new RenameTagModal(this.plugin, tag).open();
					});
			});
		} else {
			// Tag has no file - show create/delete options
			menu.addItem((item: any) => {
				item.setTitle('Create tag file')
					.setIcon('file-plus')
					.onClick(async () => {
						const newFile = await createTagFile(this.plugin, tag);
						if (newFile) {
							new Notice(`Created tag file for #${tag}`);
							this.refresh();
						}
					});
			});

			menu.addItem((item: any) => {
				item.setTitle('Delete all tag instances')
					.setIcon('trash-2')
					.onClick(async () => {
						await this.deleteAllTagInstances(tag);
					});
			});
		}

		menu.addSeparator();

		// Add "New" submenu (new file with tag, child tag, parent tag)
		addNewSubmenu(this.plugin, menu, tag, () => this.refresh());

		menu.addSeparator();

		// Show split/merge option for non-root tags
		const parentTags = this.plugin.tagIndex.getParentTags(tag);
		if (parentTags.length > 0) {
			const menuTitle = parentTags.length > 1 ? 'Split tag' : 'Merge tag into parent';
			menu.addItem((item: any) => {
				item.setTitle(menuTitle)
					.setIcon('git-branch')
					.onClick(() => {
						const childTags = this.plugin.tagIndex.getChildTags(tag);
						const childFiles = this.plugin.tagIndex.getFilesWithTag(tag);
						new SplitTagModal(this.plugin, tag, parentTags, childTags, childFiles).open();
					});
			});
		}

		menu.addSeparator();

		// Filter options
		menu.addItem((item: any) => {
			item.setTitle('Filter by tag')
				.setIcon('filter')
				.onClick(() => {
					this.addFilterTag(tag);
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Filter out tag')
				.setIcon('filter-x')
				.onClick(() => {
					this.addExcludeTag(tag);
				});
		});

		menu.addSeparator();

		menu.addItem((item: any) => {
			item.setTitle('Expand all children')
				.setIcon('chevrons-up-down')
				.onClick(() => {
					this.expandTagRecursively(tag, ancestors);
					this.refresh();
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Collapse all children')
				.setIcon('chevrons-down-up')
				.onClick(() => {
					this.collapseTagRecursively(tag, ancestors);
					this.refresh();
				});
		});

		// Add delete submenu
		addDeleteTagSubmenu(this.plugin, menu, tag, () => this.refresh());

		menu.showAtMouseEvent(event);
	}

	/**
	 * Show a context menu with only collapse/expand options (for combined tags)
	 */
	private showCollapseExpandMenu(event: MouseEvent, tags: string[], ancestors: string[] = []): void {
		const menu = new (require('obsidian').Menu)();
		
		menu.addItem((item: any) => {
			item.setTitle('Expand all children')
				.setIcon('chevrons-up-down')
				.onClick(() => {
					for (const tag of tags) {
						this.expandTagRecursively(tag, ancestors);
					}
					this.refresh();
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Collapse all children')
				.setIcon('chevrons-down-up')
				.onClick(() => {
					for (const tag of tags) {
						this.collapseTagRecursively(tag, ancestors);
					}
					this.refresh();
				});
		});

		menu.showAtMouseEvent(event);
	}

	private showFileContextMenu(event: MouseEvent, file: TFile): void {
		const menu = new (require('obsidian').Menu)();
		const app = this.plugin.app;
		
		// === Section 1: Open actions ===
		menu.addItem((item: any) => {
			item.setTitle('Open in new tab')
				.setIcon('file-plus')
				.onClick(async () => {
					await app.workspace.getLeaf('tab').openFile(file);
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Open to the right')
				.setIcon('separator-vertical')
				.onClick(async () => {
					await app.workspace.getLeaf('split').openFile(file);
				});
		});

		menu.addSeparator();

		// === Section 2: File actions ===
		menu.addItem((item: any) => {
			item.setTitle('Make a copy')
				.setIcon('documents')
				.onClick(async () => {
					const dir = file.parent?.path || '';
					const baseName = file.basename;
					const ext = file.extension;
					let copyNum = 1;
					let newPath = dir ? `${dir}/${baseName} ${copyNum}.${ext}` : `${baseName} ${copyNum}.${ext}`;
					// Find a unique name
					while (app.vault.getAbstractFileByPath(newPath)) {
						copyNum++;
						newPath = dir ? `${dir}/${baseName} ${copyNum}.${ext}` : `${baseName} ${copyNum}.${ext}`;
					}
					const content = await app.vault.read(file);
					await app.vault.create(newPath, content);
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Rename...')
				.setIcon('pencil')
				.onClick(() => {
					this.startInlineRename(file);
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Delete')
				.setIcon('trash')
				.setWarning(true)
				.onClick(async () => {
					await app.vault.trash(file, true);
				});
		});

		menu.addSeparator();

		// === Section 3: Let plugins add their items (Open in default app, Copy path, Bookmark, etc.) ===
		app.workspace.trigger('file-menu', menu, file, 'file-explorer');

		// Remove duplicate items that we've already added or don't want
		// @ts-ignore - accessing internal menu items
		const items = menu.items;
		if (items) {
			const titlesToRemove = [
				'Open in new window',      // Duplicate
				'Reveal file in navigation', // Not needed
				'Reveal in file explorer',  // Not needed (we're already in an explorer)
				'Move file to...',         // Not needed
			];
			for (let i = items.length - 1; i >= 0; i--) {
				const item = items[i];
				// @ts-ignore - accessing internal item properties
				const title = item.titleEl?.textContent || item.title || '';
				if (titlesToRemove.includes(title)) {
					items.splice(i, 1);
				}
			}
		}
		
		menu.showAtMouseEvent(event);
	}

	// Track if a rename is currently in progress to prevent concurrent renames
	private activeRenameInput: HTMLInputElement | null = null;

	private startInlineRename(file: TFile): void {
		// Prevent concurrent renames
		if (this.activeRenameInput) {
			return;
		}

		// Find the file element by data-path attribute
		const fileEl = this.contentEl.querySelector(`[data-path="${CSS.escape(file.path)}"]`);
		if (!fileEl) return;
		
		const fileNameEl = fileEl.querySelector('.file-name');
		if (!fileNameEl) return;
		
		// Store original name
		const originalName = file.basename;
		
		// Create input element
		const input = document.createElement('input');
		input.type = 'text';
		input.value = originalName;
		input.className = 'rename-input';
		this.activeRenameInput = input;
		
		// Replace text with input
		fileNameEl.textContent = '';
		fileNameEl.appendChild(input);
		input.focus();
		input.select();
		
		// Flag to prevent double-execution
		let isFinished = false;
		
		// Handle completion
		const finishRename = async (save: boolean) => {
			// Prevent double-execution (blur can fire after Enter/Escape)
			if (isFinished) return;
			isFinished = true;
			this.activeRenameInput = null;
			
			const newName = input.value.trim();
			if (save && newName && newName !== originalName) {
				// Build new path preserving the directory and extension
				const dir = file.parent?.path || '';
				const newPath = dir ? `${dir}/${newName}.${file.extension}` : `${newName}.${file.extension}`;
				try {
					await this.plugin.app.vault.rename(file, newPath);
					// View will refresh automatically due to vault rename event
				} catch (e) {
					// Restore original name on error
					fileNameEl.textContent = originalName;
					new Notice(`Failed to rename: ${e.message || e}`);
				}
			} else {
				// Restore original display
				fileNameEl.textContent = originalName;
			}
		};
		
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				finishRename(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finishRename(false);
			}
		});
		
		input.addEventListener('blur', () => finishRename(true));
	}

	private expandTagRecursively(tag: string, ancestors: string[], visited: Set<string> = new Set()): void {
		// Prevent infinite recursion on cycles
		if (visited.has(tag)) {
			return;
		}
		visited.add(tag);
		
		const treePath = this.buildTreePath(ancestors, tag);
		this.expandedPaths.add(treePath);
		
		const newAncestors = [...ancestors, tag];
		for (const child of this.plugin.tagIndex.getChildTags(tag)) {
			this.expandTagRecursively(child, newAncestors, new Set(visited));
		}
	}

	private collapseTagRecursively(tag: string, ancestors: string[], visited: Set<string> = new Set()): void {
		// Prevent infinite recursion on cycles
		if (visited.has(tag)) {
			return;
		}
		visited.add(tag);
		
		const treePath = this.buildTreePath(ancestors, tag);
		this.expandedPaths.delete(treePath);
		
		const newAncestors = [...ancestors, tag];
		for (const child of this.plugin.tagIndex.getChildTags(tag)) {
			this.collapseTagRecursively(child, newAncestors, new Set(visited));
		}
	}

	/**
	 * Get child tags visible under a parent at a given tree position
	 * (same filtering as renderTagOrGroupNode).
	 */
	private getVisibleChildTags(primaryTag: string, ancestorSet: Set<string>): string[] {
		const allChildren = this.plugin.tagIndex.getChildTags(primaryTag);
		const fullAncestorSet = new Set([...ancestorSet, primaryTag]);
		return allChildren.filter(child => {
			if (ancestorSet.has(child)) return false;
			if (this.isExceptionToAnyAncestor(child, fullAncestorSet)) return false;
			if (this.plugin.tagIndex.isExclusiveTag(child)) return false;
			if (this.hasExceptionTagToAnyAncestor(child, fullAncestorSet)) return false;
			return true;
		});
	}

	/**
	 * Get files visible directly under a tag node (same filtering as render).
	 */
	private getVisibleFilesUnderTag(primaryTag: string, children: string[], fullAncestorSet: Set<string>): TFile[] {
		if (this.contentMode === 'tags') {
			return [];
		}
		const allFiles = this.plugin.tagIndex.getFilesWithTag(primaryTag);
		const childTagsSet = new Set(children);
		return allFiles.filter(file => {
			if (this.plugin.tagIndex.isTagFile(file)) {
				const tagName = this.plugin.tagIndex.fileToTagName(file);
				if (tagName && (childTagsSet.has(tagName) || fullAncestorSet.has(tagName))) {
					return false;
				}
			}
			if (this.plugin.tagIndex.isExclusiveTag(primaryTag)) return true;
			const fileTags = this.plugin.tagIndex.getAllTagsFromFile(file);
			for (const fileTag of fileTags) {
				if (this.plugin.tagIndex.isExclusiveTag(fileTag)) {
					return false;
				}
				if (this.isExceptionToAnyAncestor(fileTag, fullAncestorSet)) {
					return false;
				}
			}
			return true;
		});
	}

	/**
	 * Build the list of expandPaths needed to reveal a node at treePath
	 * (every ancestor segment must be expanded, including the node itself).
	 */
	private getExpandPathsForTreePath(treePath: string): string[] {
		if (!treePath) return [];
		const parts = treePath.split('>');
		const paths: string[] = [];
		for (let i = 0; i < parts.length; i++) {
			paths.push(parts.slice(0, i + 1).join('>'));
		}
		return paths;
	}

	/**
	 * Expand paths for ancestor tags only (so a tag node itself becomes visible).
	 */
	private getExpandPathsForAncestors(ancestors: string[]): string[] {
		const paths: string[] = [];
		for (let i = 0; i < ancestors.length; i++) {
			paths.push(ancestors.slice(0, i + 1).join('>'));
		}
		return paths;
	}

	/**
	 * Collect every place the given file appears in the current explorer view.
	 */
	private collectFileInstances(file: TFile): FileInstance[] {
		const instances: FileInstance[] = [];
		const tagsToRender = this.getFilteredTags();
		const showTags = this.contentMode !== 'files';
		const showFiles = this.contentMode !== 'tags';

		// Flat modes: at most one file-item instance
		if (this.contentMode === 'files' || this.viewMode === 'list') {
			if (showFiles) {
				const allFiles = this.getAllFilesForDisplay(tagsToRender);
				if (allFiles.some(f => f.path === file.path)) {
					instances.push({ instanceKey: 'file:__flat__', expandPaths: [] });
				}
			}
			// Tag file as a flat tag row (list mode only)
			if (showTags && this.viewMode === 'list' && this.plugin.tagIndex.isTagFile(file)) {
				const tagName = this.plugin.tagIndex.fileToTagName(file);
				if (tagName) {
					const allTags = this.getAllTagsForDisplay(tagsToRender.tags);
					if (allTags.includes(tagName)) {
						instances.push({
							instanceKey: `tag:__flat__:${tagName}`,
							expandPaths: []
						});
					}
				}
			}
			return instances;
		}

		// Tree mode
		if (showTags) {
			const groups = this.groupTagsByChildren(tagsToRender.tags);
			for (const group of groups) {
				this.collectInstancesUnderTagGroup(group, file, [], new Set(), instances);
			}
		}

		if (showFiles && this.filterTags.size > 0) {
			if (tagsToRender.files.some(f => f.path === file.path)) {
				instances.push({ instanceKey: 'file:__root__', expandPaths: [] });
			}
		}

		if (showFiles && this.filterTags.size === 0 && this.plugin.settings.showUntaggedFiles) {
			const untaggedFiles = this.plugin.tagIndex.getUntaggedFiles();
			if (untaggedFiles.some(f => f.path === file.path)) {
				if (this.plugin.settings.groupUntaggedFiles) {
					instances.push({
						instanceKey: 'file:__untagged__',
						expandPaths: ['__untagged__']
					});
				} else {
					instances.push({ instanceKey: 'file:__root__', expandPaths: [] });
				}
			}
		}

		return instances;
	}

	/**
	 * Recursively collect instances of a file under a tag group in tree mode.
	 */
	private collectInstancesUnderTagGroup(
		group: TagOrGroup,
		file: TFile,
		ancestors: string[],
		ancestorSet: Set<string>,
		instances: FileInstance[]
	): void {
		const primaryTag = group.tags[0];
		const treePath = this.buildTreePath(ancestors, primaryTag);
		const children = this.getVisibleChildTags(primaryTag, ancestorSet);
		const fullAncestorSet = new Set([...ancestorSet, primaryTag]);

		// Tag node itself represents the tag file
		if (this.plugin.tagIndex.isTagFile(file)) {
			const tagName = this.plugin.tagIndex.fileToTagName(file);
			if (tagName && group.tags.includes(tagName)) {
				instances.push({
					instanceKey: `tag:${treePath}`,
					expandPaths: this.getExpandPathsForAncestors(ancestors)
				});
			}
		}

		const files = this.getVisibleFilesUnderTag(primaryTag, children, fullAncestorSet);
		if (files.some(f => f.path === file.path)) {
			instances.push({
				instanceKey: `file:${treePath}`,
				expandPaths: this.getExpandPathsForTreePath(treePath)
			});
		}

		const newAncestors = [...ancestors, primaryTag];
		const newAncestorSet = new Set(ancestorSet);
		for (const tag of group.tags) {
			newAncestorSet.add(tag);
		}

		const childGroups = this.groupTagsByChildren(children);
		for (const childGroup of childGroups) {
			this.collectInstancesUnderTagGroup(childGroup, file, newAncestors, newAncestorSet, instances);
		}
	}

	/**
	 * Cycle through explorer instances of the active file: expand, scroll, highlight.
	 */
	private async revealNextActiveFileInstance(): Promise<void> {
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active file');
			return;
		}

		const instances = this.collectFileInstances(file);
		if (instances.length === 0) {
			new Notice('Active file is not visible in the explorer');
			return;
		}

		if (this.revealCycleFilePath !== file.path) {
			this.revealCycleFilePath = file.path;
			this.revealCycleIndex = 0;
		}

		const instance = instances[this.revealCycleIndex % instances.length];
		this.revealCycleIndex = (this.revealCycleIndex + 1) % instances.length;

		for (const path of instance.expandPaths) {
			this.expandedPaths.add(path);
		}

		this.pendingRevealKey = instance.instanceKey;
		this.pendingRevealFilePath = file.path;
		await this.refresh();
	}

	/**
	 * Scroll to and briefly highlight the revealed instance.
	 */
	private applyRevealHighlight(instanceKey: string, filePath: string | null): void {
		// Clear any previous highlight
		this.contentEl.querySelectorAll('.is-highlighted').forEach(el => {
			el.removeClass('is-highlighted');
		});
		if (this.highlightTimeout) {
			window.clearTimeout(this.highlightTimeout);
			this.highlightTimeout = null;
		}

		let el: HTMLElement | null = null;
		if (instanceKey.startsWith('file:') && filePath) {
			el = this.contentEl.querySelector(
				`[data-instance-key="${CSS.escape(instanceKey)}"][data-path="${CSS.escape(filePath)}"]`
			) as HTMLElement | null;
		} else {
			el = this.contentEl.querySelector(
				`[data-instance-key="${CSS.escape(instanceKey)}"]`
			) as HTMLElement | null;
		}
		if (!el) return;

		// Jump directly within the explorer scroll container (no smooth scroll from top)
		const scrollContainer = this.contentEl.querySelector('.scroll-container') as HTMLElement | null;
		if (scrollContainer) {
			const elRect = el.getBoundingClientRect();
			const containerRect = scrollContainer.getBoundingClientRect();
			const offset =
				scrollContainer.scrollTop +
				(elRect.top - containerRect.top) -
				(containerRect.height / 2) +
				(elRect.height / 2);
			scrollContainer.scrollTop = Math.max(0, offset);
		} else {
			el.scrollIntoView({ block: 'center', behavior: 'auto' });
		}
		el.addClass('is-highlighted');

		this.highlightTimeout = window.setTimeout(() => {
			el!.removeClass('is-highlighted');
			this.highlightTimeout = null;
		}, 1500);
	}

	/**
	 * Check if a tag is an exception to any of the given ancestor tags.
	 */
	private isExceptionToAnyAncestor(tag: string, ancestors: Set<string>): boolean {
		for (const ancestor of ancestors) {
			if (this.plugin.tagIndex.isExceptionTo(tag, ancestor)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check if a tag (child tag) has any parent tags that are exceptions to any of the given ancestors.
	 * This is used to filter out children that belong to an exception tag.
	 * For example, if #disliked is an exception to #liked, and #bad-movie has parent #disliked,
	 * then #bad-movie should not appear anywhere under #liked (even if nested deeper).
	 * This check is recursive through the child's parent chain.
	 */
	private hasExceptionTagToAnyAncestor(childTag: string, ancestors: Set<string>, visited: Set<string> = new Set()): boolean {
		// Prevent infinite loops from circular references
		if (visited.has(childTag)) return false;
		visited.add(childTag);

		const parentTags = this.plugin.tagIndex.getParentTags(childTag);
		for (const parent of parentTags) {
			// Check if this parent is an exception to any ancestor in the tree path
			if (this.isExceptionToAnyAncestor(parent, ancestors)) {
				return true;
			}
			// Recursively check if any of the parent's ancestors is an exception
			if (this.hasExceptionTagToAnyAncestor(parent, ancestors, visited)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Set the filter to a single tag, replacing any existing filters.
	 * This is called when clicking a tag with "replace" behavior.
	 */
	setFilterTag(tag: string): void {
		const normalizedTag = this.plugin.tagIndex.normalizeTag(tag);
		this.filterTags.clear();
		this.excludeTags.clear();
		this.filterTags.add(normalizedTag);
		this.refresh();
	}

	/**
	 * Add a tag to the current filters.
	 * This is called when clicking a tag with "add" behavior.
	 */
	addFilterTagPublic(tag: string): void {
		const normalizedTag = this.plugin.tagIndex.normalizeTag(tag);
		// Don't add if already in filters or excludes
		if (!this.filterTags.has(normalizedTag) && !this.excludeTags.has(normalizedTag)) {
			this.filterTags.add(normalizedTag);
			this.refresh();
		}
	}

	/**
	 * Add a tag to the exclude list.
	 * This is called from the context menu to filter out a tag.
	 */
	addExcludeTagPublic(tag: string): void {
		const normalizedTag = this.plugin.tagIndex.normalizeTag(tag);
		// Don't add if already in filters or excludes
		if (!this.filterTags.has(normalizedTag) && !this.excludeTags.has(normalizedTag)) {
			this.excludeTags.add(normalizedTag);
			this.refresh();
		}
	}

	/**
	 * Compute a signature for a tag's children (child tags + files).
	 * Tags with identical signatures can be combined.
	 */
	private getChildrenSignature(tag: string): string {
		const childTags = this.plugin.tagIndex.getChildTags(tag).sort();
		const files = this.plugin.tagIndex.getFilesWithTag(tag).map(f => f.path).sort();
		return JSON.stringify({ childTags, files });
	}

	/**
	 * Group tags by their children signature.
	 * Returns TagOrGroup items - either single tags or combined groups.
	 */
	private groupTagsByChildren(tags: string[]): TagOrGroup[] {
		if (!this.plugin.settings.combineIdenticalTags) {
			// No combining - return each tag as its own group
			return tags.map(tag => ({ tags: [tag], displayName: tag }));
		}

		// Group tags by their children signature
		const signatureToTags = new Map<string, string[]>();
		for (const tag of tags) {
			const sig = this.getChildrenSignature(tag);
			if (!signatureToTags.has(sig)) {
				signatureToTags.set(sig, []);
			}
			signatureToTags.get(sig)!.push(tag);
		}

		// Convert to TagOrGroup items
		const result: TagOrGroup[] = [];
		for (const groupTags of signatureToTags.values()) {
			groupTags.sort();
			result.push({
				tags: groupTags,
				displayName: groupTags.join(' + ')
			});
		}

		// Sort by display name
		result.sort((a, b) => a.displayName.localeCompare(b.displayName));
		return result;
	}

	/**
	 * Render the filter bar with tag input and selected filter chips
	 */
	private renderFilterBar(container: HTMLElement): void {
		const filterBar = container.createEl('div', { cls: 'filter-bar' });

		// Filter input container (with dropdown)
		const inputContainer = filterBar.createEl('div', { cls: 'filter-input-container' });
		const input = inputContainer.createEl('input', {
			cls: 'filter-input',
			attr: { 
				type: 'text',
				placeholder: 'Filter by tag...'
			}
		});

		// Suggestions dropdown
		const suggestionsEl = inputContainer.createEl('div', { cls: 'filter-suggestions' });
		suggestionsEl.style.display = 'none';
		suggestionsEl.style.pointerEvents = 'none';

		// Get available tags (exclude already selected or excluded)
		const availableTags = this.plugin.tagIndex.getAllTags()
			.filter(t => !this.filterTags.has(t) && !this.excludeTags.has(t))
			.sort();

		let selectedIndex = -1;
		let filteredSuggestions: string[] = [];

		const hideSuggestions = () => {
			suggestionsEl.style.display = 'none';
			suggestionsEl.style.pointerEvents = 'none';
			suggestionsEl.empty();
			selectedIndex = -1;
			filteredSuggestions = [];
		};

		const updateSuggestions = () => {
			const query = input.value.toLowerCase().trim();
			
			// Only show suggestions if there's text in the input
			if (!query) {
				hideSuggestions();
				return;
			}

			filteredSuggestions = availableTags.filter(t => t.toLowerCase().includes(query));

			suggestionsEl.empty();
			selectedIndex = -1;

			if (filteredSuggestions.length === 0) {
				hideSuggestions();
				return;
			}

			suggestionsEl.style.display = 'block';
			suggestionsEl.style.pointerEvents = 'auto';
			for (let i = 0; i < Math.min(filteredSuggestions.length, 10); i++) {
				const tag = filteredSuggestions[i];
				const item = suggestionsEl.createEl('div', { 
					cls: 'filter-suggestion-item'
				});
				
				// Tag name (clickable to include)
				const tagText = item.createEl('span', { 
					cls: 'filter-suggestion-text',
					text: tag
				});
				tagText.addEventListener('mousedown', (e) => {
					e.preventDefault(); // Prevent blur before click registers
					this.addFilterTag(tag);
					input.value = '';
					hideSuggestions();
				});
				
				// Exclude button
				const excludeBtn = item.createEl('span', { 
					cls: 'filter-suggestion-exclude',
					text: '🛇',
					attr: { 'aria-label': 'Exclude this tag' }
				});
				excludeBtn.addEventListener('mousedown', (e) => {
					e.preventDefault();
					e.stopPropagation();
					this.addExcludeTag(tag);
					input.value = '';
					hideSuggestions();
				});
				
				item.addEventListener('mouseenter', () => {
					selectedIndex = i;
					updateSelectedSuggestion();
				});
			}
		};

		const updateSelectedSuggestion = () => {
			const items = suggestionsEl.querySelectorAll('.filter-suggestion-item');
			items.forEach((item, i) => {
				if (i === selectedIndex) {
					item.addClass('is-selected');
				} else {
					item.removeClass('is-selected');
				}
			});
		};

		input.addEventListener('input', updateSuggestions);

		input.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (filteredSuggestions.length > 0) {
					selectedIndex = Math.min(selectedIndex + 1, Math.min(filteredSuggestions.length - 1, 9));
					updateSelectedSuggestion();
				}
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (filteredSuggestions.length > 0) {
					selectedIndex = Math.max(selectedIndex - 1, 0);
					updateSelectedSuggestion();
				}
			} else if (e.key === 'Enter') {
				e.preventDefault();
				if (selectedIndex >= 0 && selectedIndex < filteredSuggestions.length) {
					this.addFilterTag(filteredSuggestions[selectedIndex]);
					input.value = '';
					hideSuggestions();
				}
			} else if (e.key === 'Escape') {
				hideSuggestions();
				input.blur();
			}
		});

		// Hide suggestions when clicking outside or losing focus
		input.addEventListener('blur', () => {
			// Small delay to allow click events on suggestions to fire first
			setTimeout(() => hideSuggestions(), 150);
		});

		// Filter action buttons - only show when 2+ total tags are selected (include + exclude)
		if (this.filterTags.size + this.excludeTags.size >= 2) {
			const filterActionsContainer = filterBar.createEl('div', { cls: 'filter-actions-container' });
			
			// "Create tag from filters" button
			const createTagBtn = filterActionsContainer.createEl('button', {
				cls: 'create-tag-button',
				text: 'Create tag from filters'
			});
			createTagBtn.addEventListener('click', () => {
				const filteredResults = this.getFilteredTags();
				new CreateTagFromFiltersModal(
					this.plugin,
					Array.from(this.filterTags),
					filteredResults.tags,
					filteredResults.files
				).open();
			});

			// Icon buttons container
			const iconButtonsContainer = filterActionsContainer.createEl('div', { cls: 'filter-action-buttons' });

			// "New note with tags" button
			const newNoteBtn = iconButtonsContainer.createEl('div', {
				cls: 'clickable-icon filter-action-button',
				attr: { 'aria-label': 'New note with tags' }
			});
			setIcon(newNoteBtn, 'file-plus-2');
			newNoteBtn.addEventListener('click', async () => {
				await this.createNoteWithFilterTags();
			});

			// "Add filters to search" button
			const searchBtn = iconButtonsContainer.createEl('div', {
				cls: 'clickable-icon filter-action-button',
				attr: { 'aria-label': 'Add filters to search' }
			});
			setIcon(searchBtn, 'search');
			searchBtn.addEventListener('click', () => {
				this.openSearchWithFilters();
			});
		}

		// Selected filter tags as chips (below the search bar)
		if (this.filterTags.size > 0 || this.excludeTags.size > 0) {
			const chipsContainer = filterBar.createEl('div', { cls: 'filter-chips' });
			
			// Render included filter tags (purple)
			for (const tag of this.filterTags) {
				this.renderFilterChip(chipsContainer, tag, false);
			}
			
			// Render excluded tags (red)
			for (const tag of this.excludeTags) {
				this.renderFilterChip(chipsContainer, tag, true);
			}
			
			// Clear all filters button
			const clearAllBtn = chipsContainer.createEl('div', { cls: 'filter-clear-all' });
			setIcon(clearAllBtn, 'x');
			clearAllBtn.setAttribute('aria-label', 'Clear all filters');
			clearAllBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.filterTags.clear();
				this.excludeTags.clear();
				this.refresh();
			});
		}
	}

	/**
	 * Add a tag to the filter
	 */
	private addFilterTag(tag: string): void {
		this.filterTags.add(tag);
		this.refresh();
	}

	/**
	 * Add a tag to the exclude list
	 */
	private addExcludeTag(tag: string): void {
		this.excludeTags.add(tag);
		this.refresh();
	}

	/**
	 * Create a new note with the current filter tags applied
	 */
	private async createNoteWithFilterTags(): Promise<void> {
		if (this.filterTags.size === 0) return;

		// Generate a unique filename - start with "Untitled", add number if needed
		let fileName = 'Untitled';
		let filePath = `${fileName}.md`;
		let counter = 1;
		
		// Ensure unique filename
		while (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
			fileName = `Untitled ${counter}`;
			filePath = `${fileName}.md`;
			counter++;
		}

		// Create frontmatter with tags
		const tagsArray = Array.from(this.filterTags);
		const frontmatter = `---\ntags: [${tagsArray.join(', ')}]\n---\n\n`;

		// Create the file
		const file = await this.plugin.app.vault.create(filePath, frontmatter);

		// Open the file
		const leaf = this.plugin.app.workspace.getLeaf();
		await leaf.openFile(file);

		// Trigger rename mode after Obsidian has fully initialized the view
		// Use a longer delay to avoid race conditions with Obsidian's own initialization
		setTimeout(() => {
			(this.plugin.app as any).commands.executeCommandById('workspace:edit-file-title');
		}, 300);
	}

	/**
	 * Open Obsidian's global search with the current filters as a query
	 */
	private openSearchWithFilters(): void {
		// Build the search query
		const queryParts: string[] = [];

		// Add inclusion tags
		for (const tag of this.filterTags) {
			queryParts.push(`tag:#${tag}`);
		}

		// Add exclusion tags
		for (const tag of this.excludeTags) {
			queryParts.push(`-tag:#${tag}`);
		}

		const query = queryParts.join(' ');

		// Open global search with the query
		const searchPlugin = (this.plugin.app as any).internalPlugins?.getPluginById('global-search');
		if (searchPlugin?.instance) {
			searchPlugin.instance.openGlobalSearch(query);
		}
	}

	/**
	 * Delete all instances of a tag from all files in the vault
	 */
	private async deleteAllTagInstances(tag: string): Promise<void> {
		const files = this.plugin.app.vault.getMarkdownFiles();
		let filesUpdated = 0;

		for (const file of files) {
			const modified = await removeTagFromFile(this.plugin, file, tag);
			if (modified) {
				filesUpdated++;
			}
		}

		if (filesUpdated > 0) {
			new Notice(`Removed #${tag} from ${filesUpdated} file${filesUpdated > 1 ? 's' : ''}`);
		} else {
			new Notice(`No instances of #${tag} found`);
		}

		this.refresh();
	}

	/**
	 * Render a filter chip (for included or excluded tags)
	 */
	private renderFilterChip(container: HTMLElement, tag: string, isExcluded: boolean): void {
		const chip = container.createEl('div', { 
			cls: `filter-chip${isExcluded ? ' filter-chip-excluded' : ''}` 
		});
		
		const chipText = chip.createEl('span', { text: tag, cls: 'filter-chip-text' });
		
		// Left click on text opens the tag file
		chipText.addEventListener('click', async (e) => {
			e.stopPropagation();
			const tagFile = this.plugin.tagIndex.getTagFile(tag);
			if (tagFile) {
				await this.plugin.app.workspace.getLeaf().openFile(tagFile);
			}
		});
		
		// Right click on text shows context menu
		chipText.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showFilterChipContextMenu(e, tag, isExcluded);
		});
		
		const removeBtn = chip.createEl('div', { cls: 'filter-chip-remove' });
		setIcon(removeBtn, 'x');
		removeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (isExcluded) {
				this.excludeTags.delete(tag);
			} else {
				this.filterTags.delete(tag);
			}
			this.refresh();
		});
	}

	/**
	 * Show context menu for a filter chip (without expand/collapse options)
	 */
	private showFilterChipContextMenu(event: MouseEvent, tag: string, isExcluded: boolean): void {
		const menu = new (require('obsidian').Menu)();
		
		menu.addItem((item: any) => {
			item.setTitle('Open tag file')
				.setIcon('file-text')
				.onClick(async () => {
					const tagFile = this.plugin.tagIndex.getTagFile(tag);
					if (tagFile) {
						await this.plugin.app.workspace.getLeaf().openFile(tagFile);
					}
				});
		});

		menu.addItem((item: any) => {
			item.setTitle('Rename tag')
				.setIcon('pencil')
				.onClick(() => {
					new RenameTagModal(this.plugin, tag).open();
				});
		});

		menu.addSeparator();

		menu.addItem((item: any) => {
			item.setTitle('Remove from filter')
				.setIcon('x')
				.onClick(() => {
					if (isExcluded) {
						this.excludeTags.delete(tag);
					} else {
						this.filterTags.delete(tag);
					}
					this.refresh();
				});
		});

		menu.showAtMouseEvent(event);
	}

	/**
	 * Get tags and files to display based on active filters
	 */
	private getFilteredTags(): { tags: string[], files: TFile[] } {
		// Build set of excluded tags and all their descendants
		const excludedTagsAndDescendants = new Set<string>();
		for (const excludeTag of this.excludeTags) {
			excludedTagsAndDescendants.add(excludeTag);
			for (const descendant of this.getAllDescendantTags(excludeTag)) {
				excludedTagsAndDescendants.add(descendant);
			}
		}

		// Build set of files under excluded tags
		const excludedFilePaths = new Set<string>();
		for (const excludeTag of this.excludeTags) {
			for (const file of this.getAllDescendantFiles(excludeTag)) {
				excludedFilePaths.add(file.path);
			}
		}

		if (this.filterTags.size === 0) {
			// No include filters - return root tags (minus excluded)
			const rootTags = this.plugin.tagIndex.getRootTags()
				.filter(t => !excludedTagsAndDescendants.has(t));
			return { 
				tags: rootTags,
				files: []
			};
		}

		// Find tags that are descendants of ALL filter tags (directly or transitively)
		const filterTagsArray = Array.from(this.filterTags);
		
		// Get all descendants for each filter tag
		const descendantSets: Set<string>[] = filterTagsArray.map(tag => 
			this.getAllDescendantTags(tag)
		);

		// Find intersection: tags that are descendants of ALL filter tags
		let matchingTags: Set<string>;
		if (descendantSets.length === 1) {
			matchingTags = descendantSets[0];
		} else {
			matchingTags = new Set(
				[...descendantSets[0]].filter(tag => 
					descendantSets.every(set => set.has(tag))
				)
			);
		}

		// Remove filter tags themselves (we want descendants, not the filter tags)
		for (const filterTag of filterTagsArray) {
			matchingTags.delete(filterTag);
		}

		// Remove excluded tags and their descendants
		for (const excludedTag of excludedTagsAndDescendants) {
			matchingTags.delete(excludedTag);
		}

		// Get files that should appear at the ROOT level of filtered results
		// A file appears at root only if it's directly tagged with at least one filter tag
		// (files only reachable through descendant tags will appear nested under those tags)
		const rootFileSets: Set<string>[] = filterTagsArray.map(tag => {
			// Get files directly tagged with this filter tag OR under descendant tags
			const files = this.getAllDescendantFiles(tag);
			return new Set(files.map(f => f.path));
		});

		// Find intersection: files that are descendants of ALL filter tags
		let allMatchingFilePaths: Set<string>;
		if (rootFileSets.length === 1) {
			allMatchingFilePaths = rootFileSets[0];
		} else {
			allMatchingFilePaths = new Set(
				[...rootFileSets[0]].filter(path => 
					rootFileSets.every(set => set.has(path))
				)
			);
		}

		// Remove files under excluded tags
		for (const excludedPath of excludedFilePaths) {
			allMatchingFilePaths.delete(excludedPath);
		}

		// Filter to only show "root" tags (those that should appear at the top level of filtered results)
		const rootTags = [...matchingTags].filter(tag => {
			const parents = this.plugin.tagIndex.getParentTags(tag);
			// A tag is a "root" in the filtered view if none of its parents are also in the matching set,
			// excluding filter tags themselves (which shouldn't prevent their direct children from being roots)
			return !parents.some(p => matchingTags.has(p) && !this.filterTags.has(p));
		});

		// Create a set of tags that will be shown as tag nodes for quick lookup
		const rootTagsSet = new Set(rootTags);

		// Filter to only show "root" files (those directly tagged with at least one filter tag)
		// Files only reachable through descendant tags will appear nested under those tags
		// Also exclude tag files whose corresponding tag is already shown as a tag node
		const rootFiles: TFile[] = [];
		for (const path of allMatchingFilePaths) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				// Skip tag files whose tag is already shown as a tag node
				if (this.plugin.tagIndex.isTagFile(file)) {
					const tagName = this.plugin.tagIndex.fileToTagName(file);
					if (tagName && rootTagsSet.has(tagName)) {
						continue; // This tag file's tag is already shown as a tag node
					}
				}

				// Check if this file is directly tagged with at least one filter tag
				const fileTagsSet = new Set(this.plugin.tagIndex.getAllTagsFromFile(file));
				const isDirectlyTaggedWithFilter = filterTagsArray.some(filterTag => fileTagsSet.has(filterTag));
				if (isDirectlyTaggedWithFilter) {
					rootFiles.push(file);
				}
			}
		}

		return {
			tags: rootTags.sort(),
			files: rootFiles
		};
	}

	/**
	 * Get all descendant tags of a tag (recursive, with cycle detection)
	 */
	private getAllDescendantTags(tag: string, visited: Set<string> = new Set()): Set<string> {
		const descendants = new Set<string>();
		
		// Prevent infinite recursion on cycles
		if (visited.has(tag)) {
			return descendants;
		}
		visited.add(tag);
		
		const children = this.plugin.tagIndex.getChildTags(tag);
		
		for (const child of children) {
			descendants.add(child);
			const childDescendants = this.getAllDescendantTags(child, new Set(visited));
			for (const d of childDescendants) {
				descendants.add(d);
			}
		}
		
		return descendants;
	}

	/**
	 * Get all files under a tag (including files under descendant tags, with cycle detection)
	 */
	private getAllDescendantFiles(tag: string, visited: Set<string> = new Set()): TFile[] {
		const files = new Set<TFile>();
		
		// Prevent infinite recursion on cycles
		if (visited.has(tag)) {
			return Array.from(files);
		}
		visited.add(tag);
		
		// Direct files
		for (const file of this.plugin.tagIndex.getFilesWithTag(tag)) {
			files.add(file);
		}
		
		// Files under child tags
		for (const child of this.plugin.tagIndex.getChildTags(tag)) {
			for (const file of this.getAllDescendantFiles(child, new Set(visited))) {
				files.add(file);
			}
		}
		
		return Array.from(files);
	}

	private addStyles(): void {
		// Only add styles once
		if (this.styleEl) return;
		
		// Add custom styles for the explorer to containerEl (persists across refreshes)
		this.styleEl = document.createElement('style');
		this.styleEl.textContent = `
			.taggable-tags-explorer {
				height: 100%;
				display: flex;
				flex-direction: column;
				overflow: hidden;
				padding: 0 !important;
			}
			/* Fixed header container - does not scroll */
			.taggable-tags-explorer .fixed-header {
				flex-shrink: 0;
				border-bottom: 1px solid var(--background-modifier-border);
			}
			/* Scrollable content area */
			.taggable-tags-explorer .scroll-container {
				flex: 1;
				overflow-y: auto;
				overflow-x: hidden;
				padding: 0;
				padding-left: 4px;
				padding-top: 5px;
				padding-bottom: 2px;
			}
			/* Remove padding/margin from containers to eliminate scrollbar gap */
			.taggable-tags-explorer .nav-files-container {
				padding: 0 !important;
				margin: 0 !important;
			}
			.taggable-tags-explorer .nav-folder.mod-root {
				padding: 0 !important;
				margin: 0 !important;
			}
			.taggable-tags-explorer .tree-item {
				padding-right: 0 !important;
				margin-right: 0 !important;
				margin-bottom: 4px;
			}
			.taggable-tags-explorer .tree-item-children {
				padding-right: 0 !important;
				margin-right: 0 !important;
			}
			.taggable-tags-explorer .nav-header {
				padding-top: 6px
				padding-right: 8px ;
				padding-bottom: 0;
				padding-left: 8;
			}
			.taggable-tags-explorer .nav-buttons-container {
				display: flex;
				align-items: center;
				justify-content: center;
				gap: 4px;
				margin-right: 16px;
			}
			.taggable-tags-explorer .nav-action-button {
				padding: 4px;
				border-radius: 4px;
			}
			.taggable-tags-explorer .nav-action-button:hover {
				background-color: var(--background-modifier-hover);
			}
			.taggable-tags-explorer .nav-action-button.is-active {
				background-color: var(--interactive-accent);
				color: var(--text-on-accent);
			}
			.taggable-tags-explorer .nav-action-button.is-disabled {
				opacity: 0.3;
				cursor: not-allowed;
				pointer-events: none;
			}
			.taggable-tags-explorer .empty-state {
				padding: 16px;
				color: var(--text-muted);
				font-style: italic;
				pointer-events: none;
			}
			/* Tag and file items */
			.taggable-tags-explorer .tree-item-self {
				display: flex;
				align-items: center;
				padding: 2px 8px;
				border-radius: 4px;
				gap: 6px;
			}
			.taggable-tags-explorer .file-item {
				cursor: pointer;
			}
			.taggable-tags-explorer .tree-item-self:hover {
				background-color: var(--background-modifier-hover);
			}
			/* Collapse arrow - like Obsidian file explorer */
			.taggable-tags-explorer .collapse-icon {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 18px;
				height: 18px;
				flex-shrink: 0;
				color: var(--nav-collapse-icon-color);
			}
			.taggable-tags-explorer .collapse-icon svg {
				width: 16px;
				height: 16px;
			}
			/* Tag name - clickable to open file */
			.taggable-tags-explorer .tag-name {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				cursor: pointer;
			}
			.taggable-tags-explorer .tag-name:hover {
				text-decoration: underline;
			}
			/* Combined tag parts - each individually clickable */
			.taggable-tags-explorer .tag-name-part {
				cursor: pointer;
			}
			.taggable-tags-explorer .tag-name-part:hover {
				text-decoration: underline;
			}
			.taggable-tags-explorer .tag-name-separator {
				color: var(--text-muted);
				cursor: default;
			}
			/* When hovering the container, don't underline everything */
			.taggable-tags-explorer .tag-name:has(.tag-name-part):hover {
				text-decoration: none;
			}
			/* Tags without corresponding files - grayed out */
			.taggable-tags-explorer .tag-no-file .tag-name {
				opacity: 0.5;
			}
			/* Individual tag name without file (in combined tags) */
			.taggable-tags-explorer .tag-name-no-file {
				opacity: 0.5;
			}
			/* List mode items - no extra padding, with icon */
			.taggable-tags-explorer .list-mode-item {
				padding-left: 4px !important;
			}
			.taggable-tags-explorer .list-mode-icon {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 18px;
				height: 18px;
				flex-shrink: 0;
				color: var(--text-muted);
			}
			.taggable-tags-explorer .list-mode-icon svg {
				width: 14px;
				height: 14px;
			}
			/* File name */
			.taggable-tags-explorer .file-name {
				flex-grow: 1;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				color: var(--text-muted);
			}
			/* Inline rename input - matches native file explorer styling */
			.taggable-tags-explorer .rename-input {
				all: unset;
				background: transparent;
				box-shadow: 0 0 0 2px var(--interactive-accent);
				border-radius: 5px;
				padding: 0 1px;
				font-size: inherit;
				font-family: inherit;
				color: var(--text-muted);
				width: 100%;
			}
			/* Highlighted state */
			.taggable-tags-explorer .is-highlighted {
				background-color: var(--text-selection) !important;
			}
			/* Untagged group */
			.taggable-tags-explorer .untagged-label {
				color: var(--text-muted);
				font-style: italic;
			}
			.taggable-tags-explorer .untagged-item:hover .untagged-label {
				text-decoration: none;
			}
			/* Attachment groups */
			.taggable-tags-explorer .attachment-group-label,
			.taggable-tags-explorer .attachment-subgroup-label {
				color: var(--text-muted);
				font-style: italic;
			}
			.taggable-tags-explorer .attachment-group-item:hover .attachment-group-label,
			.taggable-tags-explorer .attachment-subgroup-item:hover .attachment-subgroup-label {
				text-decoration: none;
			}
			/* File format label (right side, like Obsidian's file explorer) */
			.taggable-tags-explorer .nav-file-tag {
				flex-shrink: 0;
				font-size: var(--font-smaller);
				line-height: 1.4;
				text-transform: uppercase;
				color: var(--text-faint);
				background-color: transparent;
			}
			/* Filter bar */
			.taggable-tags-explorer .filter-bar {
				padding: 8px;
			}
			.taggable-tags-explorer .filter-input-container {
				position: relative;
				width: 100%;
			}
			.taggable-tags-explorer .filter-input {
				width: 100%;
				padding: 6px 8px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				background-color: var(--background-primary);
				color: var(--text-normal);
				font-size: 13px;
				box-sizing: border-box;
			}
			.taggable-tags-explorer .filter-input:focus {
				border-color: var(--interactive-accent);
				outline: none;
			}
			.taggable-tags-explorer .filter-input::placeholder {
				color: var(--text-muted);
			}
			.taggable-tags-explorer .filter-suggestions {
				position: absolute;
				top: 100%;
				left: 0;
				right: 0;
				max-height: 200px;
				overflow-y: auto;
				background-color: var(--background-secondary);
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				margin-top: 2px;
				z-index: 1000;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
			}
			.taggable-tags-explorer .filter-suggestion-item {
				display: flex;
				align-items: center;
				justify-content: space-between;
				padding: 6px 10px;
				cursor: pointer;
				font-size: 13px;
			}
			.taggable-tags-explorer .filter-suggestion-item:hover,
			.taggable-tags-explorer .filter-suggestion-item.is-selected {
				background-color: var(--background-modifier-hover);
			}
			.taggable-tags-explorer .filter-suggestion-text {
				flex-grow: 1;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.taggable-tags-explorer .filter-suggestion-exclude {
				flex-shrink: 0;
				padding: 2px 6px;
				margin-left: 8px;
				cursor: pointer;
				opacity: 0.5;
				font-size: 14px;
				border-radius: 4px;
			}
			.taggable-tags-explorer .filter-suggestion-exclude:hover {
				opacity: 1;
				background-color: rgba(var(--color-red-rgb, 255, 0, 0), 0.15);
			}
			/* Filter chips - styled like Obsidian tags */
			.taggable-tags-explorer .filter-chips {
				display: flex;
				flex-wrap: wrap;
				gap: 6px;
				margin-top: 8px;
				align-items: center;
			}
			.taggable-tags-explorer .filter-clear-all {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 20px;
				height: 20px;
				cursor: pointer;
				border-radius: 50%;
				color: var(--text-muted);
				opacity: 0.7;
				flex-shrink: 0;
			}
			.taggable-tags-explorer .filter-clear-all:hover {
				opacity: 1;
				background-color: var(--background-modifier-hover);
			}
			.taggable-tags-explorer .filter-clear-all svg {
				width: 14px;
				height: 14px;
			}
			.taggable-tags-explorer .filter-chip {
				display: inline-flex;
				align-items: center;
				gap: 4px;
				padding: 3px 8px;
				background-color: rgba(var(--interactive-accent-rgb), 0.15);
				color: var(--interactive-accent);
				border-radius: 14px;
				font-size: 13px;
				line-height: 1.4;
			}
			.taggable-tags-explorer .filter-chip-text {
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
				cursor: pointer;
			}
			.taggable-tags-explorer .filter-chip-text:hover {
				text-decoration: underline;
			}
			/* Excluded filter chips - red styling */
			.taggable-tags-explorer .filter-chip-excluded {
				background-color: rgba(var(--color-red-rgb, 255, 59, 48), 0.15);
				color: var(--color-red, #ff3b30);
			}
			.taggable-tags-explorer .filter-chip-remove {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 14px;
				height: 14px;
				cursor: pointer;
				border-radius: 50%;
				opacity: 0.7;
				flex-shrink: 0;
			}
			.taggable-tags-explorer .filter-chip-remove:hover {
				opacity: 1;
			}
			.taggable-tags-explorer .filter-chip-remove svg {
				width: 12px;
				height: 12px;
			}
			/* Filter actions container */
			.taggable-tags-explorer .filter-actions-container {
				display: flex;
				align-items: center;
				gap: 8px;
				margin-top: 8px;
			}
			/* Create tag from filters button */
			.taggable-tags-explorer .create-tag-button {
				flex: 1;
				padding: 6px 8px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				background-color: var(--background-secondary);
				color: var(--text-normal);
				font-size: 13px;
				cursor: pointer;
				box-sizing: border-box;
			}
			.taggable-tags-explorer .create-tag-button:hover {
				background-color: var(--background-modifier-hover);
			}
			/* Filter action icon buttons */
			.taggable-tags-explorer .filter-action-buttons {
				display: flex;
				gap: 4px;
				flex-shrink: 0;
			}
			.taggable-tags-explorer .filter-action-button {
				padding: 6px;
				border-radius: 4px;
				color: var(--text-muted);
			}
			.taggable-tags-explorer .filter-action-button:hover {
				background-color: var(--background-modifier-hover);
				color: var(--text-normal);
			}
			/* Create tag from filters modal */
			.create-tag-from-filters-modal {
				padding: 16px;
			}
			.create-tag-from-filters-modal .modal-label {
				font-size: 14px;
				color: var(--text-muted);
				margin: 12px 0 8px 0;
			}
			.create-tag-from-filters-modal .modal-label:first-child {
				margin-top: 0;
			}
			.create-tag-from-filters-modal .modal-chips-container {
				display: flex;
				flex-wrap: wrap;
				gap: 6px;
			}
			.create-tag-from-filters-modal .modal-chip {
				display: inline-flex;
				align-items: center;
				padding: 4px 10px;
				border-radius: 14px;
				font-size: 13px;
			}
			.create-tag-from-filters-modal .modal-chip-tag {
				background-color: rgba(var(--interactive-accent-rgb), 0.15);
				color: var(--interactive-accent);
			}
			.create-tag-from-filters-modal .modal-chip-item {
				background-color: var(--background-secondary);
				color: var(--text-normal);
			}
			.create-tag-from-filters-modal .modal-chip-file {
				background-color: var(--background-secondary);
				color: var(--text-muted);
			}
			.create-tag-from-filters-modal .modal-empty-text {
				color: var(--text-muted);
				font-style: italic;
				font-size: 13px;
			}
			.create-tag-from-filters-modal .modal-input-container {
				margin: 8px 0 16px 0;
			}
			.create-tag-from-filters-modal .modal-input {
				width: 100%;
				padding: 8px;
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				background-color: var(--background-primary);
				color: var(--text-normal);
				font-size: 14px;
				box-sizing: border-box;
			}
			.create-tag-from-filters-modal .modal-input:focus {
				border-color: var(--interactive-accent);
				outline: none;
			}
			.create-tag-from-filters-modal .modal-buttons {
				display: flex;
				justify-content: flex-end;
				gap: 8px;
			}
		`;
		this.containerEl.appendChild(this.styleEl);
	}

	async onClose(): Promise<void> {
		if (this.highlightTimeout) {
			window.clearTimeout(this.highlightTimeout);
			this.highlightTimeout = null;
		}
		// Cleanup styles
		if (this.styleEl) {
			this.styleEl.remove();
			this.styleEl = null;
		}
	}
}

/**
 * Modal for renaming a tag
 */
class RenameTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private oldTag: string;
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, oldTag: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.oldTag = oldTag;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		contentEl.createEl('h3', { text: `Rename tag #${this.oldTag}` });
		
		const inputContainer = contentEl.createEl('div', { cls: 'rename-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			value: this.oldTag,
			cls: 'rename-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		this.inputEl.select();
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performRename();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'rename-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const renameBtn = buttonContainer.createEl('button', { text: 'Rename', cls: 'mod-cta' });
		renameBtn.addEventListener('click', () => this.performRename());
	}

	private async performRename(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTag = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTag = newTag.startsWith('#') ? newTag.slice(1) : newTag;
		
		if (newTag === this.oldTag) {
			new Notice('New tag name is the same as the old one');
			return;
		}

		if (!newTag) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTag.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		try {
			this.close();
			await renameTag(this.plugin, this.oldTag, newTag);
			new Notice(`Renamed #${this.oldTag} to #${newTag}`);
		} catch (error) {
			console.error('Failed to rename tag:', error);
			new Notice(`Failed to rename tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for creating a new tag
 */
class CreateTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private inputEl: HTMLInputElement | null = null;
	private onComplete: (() => void) | null;

	constructor(plugin: TaggableTagsPlugin, onComplete?: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.onComplete = onComplete ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		contentEl.createEl('h3', { text: 'Create new tag' });
		
		const inputContainer = contentEl.createEl('div', { cls: 'create-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		const labelEl = inputContainer.createEl('label');
		labelEl.textContent = 'Tag name';
		labelEl.style.display = 'block';
		labelEl.style.marginBottom = '4px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter tag name...',
			cls: 'create-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performCreate();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'create-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performCreate());
		
		// Focus the input
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private async performCreate(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTagName = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTagName = newTagName.startsWith('#') ? newTagName.slice(1) : newTagName;
		
		if (!newTagName) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTagName.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		newTagName = this.plugin.tagIndex.normalizeTag(newTagName);

		// Check if tag already exists
		const existingFile = this.plugin.tagIndex.getTagFile(newTagName);
		if (existingFile) {
			new Notice(`Tag #${newTagName} already exists`);
			return;
		}

		try {
			this.close();
			
			// Create the tag file
			const tagFile = await createTagFile(this.plugin, newTagName);
			if (!tagFile) {
				new Notice('Failed to create tag file');
				return;
			}
			
			// Rebuild the index
			await this.plugin.tagIndex.rebuild();
			
			// Open the new tag file
			await this.plugin.app.workspace.getLeaf().openFile(tagFile);
			
			new Notice(`Created tag #${newTagName}`);
			
			// Call completion callback if provided
			if (this.onComplete) {
				this.onComplete();
			}
		} catch (error) {
			console.error('Failed to create tag:', error);
			new Notice(`Failed to create tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for creating a new tag from filter tags
 */
class CreateTagFromFiltersModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private filterTags: string[];
	private itemTags: string[];
	private itemFiles: TFile[];
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, filterTags: string[], itemTags: string[], itemFiles: TFile[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.filterTags = filterTags;
		this.itemTags = itemTags;
		this.itemFiles = itemFiles;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('create-tag-from-filters-modal');
		
		// "Replace" label
		contentEl.createEl('div', { text: 'Replace', cls: 'modal-label' });
		
		// Display filter tags as chips
		const tagsContainer = contentEl.createEl('div', { cls: 'modal-chips-container' });
		for (const tag of this.filterTags) {
			const chip = tagsContainer.createEl('span', { cls: 'modal-chip modal-chip-tag' });
			chip.textContent = `#${tag}`;
		}
		
		// "in" label
		contentEl.createEl('div', { text: 'in', cls: 'modal-label' });
		
		// Display items (tags and files)
		const itemsContainer = contentEl.createEl('div', { cls: 'modal-chips-container' });
		for (const tag of this.itemTags) {
			const chip = itemsContainer.createEl('span', { cls: 'modal-chip modal-chip-item' });
			chip.textContent = `#${tag}`;
		}
		for (const file of this.itemFiles) {
			const chip = itemsContainer.createEl('span', { cls: 'modal-chip modal-chip-file' });
			chip.textContent = file.basename;
		}
		
		// "with" label
		contentEl.createEl('div', { text: 'with', cls: 'modal-label' });
		
		// Input for new tag name
		const inputContainer = contentEl.createEl('div', { cls: 'modal-input-container' });
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			cls: 'modal-input',
			attr: { placeholder: 'New tag name...' }
		});
		this.inputEl.focus();
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performCreate();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		// Buttons
		const buttonContainer = contentEl.createEl('div', { cls: 'modal-buttons' });
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performCreate());
	}

	private async performCreate(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTag = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTag = newTag.startsWith('#') ? newTag.slice(1) : newTag;
		
		if (!newTag) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTag.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		// Check if tag already exists
		const existingTags = this.plugin.tagIndex.getAllTags();
		const normalizedNewTag = this.plugin.tagIndex.normalizeTag(newTag);
		if (existingTags.some(t => this.plugin.tagIndex.tagsMatch(t, normalizedNewTag))) {
			new Notice(`Tag #${newTag} already exists`);
			return;
		}

		try {
			this.close();
			
			// 1. Create the new tag file
			const newTagFile = await createTagFile(this.plugin, normalizedNewTag);
			if (!newTagFile) {
				new Notice('Failed to create tag file');
				return;
			}
			
			// 2. Tag the new file with the filter tags (make it a child of filter tags)
			await this.addTagsToFile(newTagFile, this.filterTags);
			
			// 3. For each item, remove filter tags and add the new tag
			for (const itemTag of this.itemTags) {
				const tagFile = this.plugin.tagIndex.getTagFile(itemTag);
				if (tagFile) {
					await this.replaceTagsInFile(tagFile, this.filterTags, newTag);
				}
			}
			
			for (const file of this.itemFiles) {
				await this.replaceTagsInFile(file, this.filterTags, newTag);
			}
			
			// 4. Rebuild the index
			await this.plugin.tagIndex.rebuild();
			
			new Notice(`Created tag #${newTag} and updated ${this.itemTags.length + this.itemFiles.length} items`);
		} catch (error) {
			console.error('Failed to create tag from filters:', error);
			new Notice(`Failed to create tag: ${error}`);
		}
	}

	/**
	 * Add tags to a file's frontmatter tags property
	 */
	private async addTagsToFile(file: TFile, tagsToAdd: string[]): Promise<void> {
		markPluginInitiatedChange(file.path);
		const content = await this.plugin.app.vault.read(file);
		
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		if (!match) return;
		
		const frontmatter = match[1];
		let newFrontmatter = frontmatter;
		
		// Check for existing tags property
		const tagsLineRegex = /^tags:\s*\[(.*)\]\s*$/m;
		const tagsListRegex = /^tags:\s*$/m;
		const tagsMatch = frontmatter.match(tagsLineRegex);
		
		if (tagsMatch) {
			// Tags in array format: tags: [tag1, tag2]
			const existingTags = tagsMatch[1].split(',').map(t => t.trim()).filter(t => t);
			const allTags = [...new Set([...existingTags, ...tagsToAdd])];
			newFrontmatter = frontmatter.replace(tagsLineRegex, `tags: [${allTags.join(', ')}]`);
		} else if (tagsListRegex.test(frontmatter)) {
			// Tags in list format - append to the list
			const tagsListItems = tagsToAdd.map(t => `  - ${t}`).join('\n');
			newFrontmatter = frontmatter.replace(tagsListRegex, `tags:\n${tagsListItems}`);
		} else {
			// No tags property - add one
			newFrontmatter = frontmatter + `\ntags: [${tagsToAdd.join(', ')}]`;
		}
		
		if (newFrontmatter !== frontmatter) {
			const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
			await this.plugin.app.vault.modify(file, newContent);
		}
	}

	/**
	 * Replace specified tags with a new tag in a file's frontmatter
	 */
	private async replaceTagsInFile(file: TFile, tagsToRemove: string[], tagToAdd: string): Promise<void> {
		markPluginInitiatedChange(file.path);
		const content = await this.plugin.app.vault.read(file);
		
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		if (!match) return;
		
		const frontmatter = match[1];
		let newFrontmatter = frontmatter;
		
		// Handle array format: tags: [tag1, tag2]
		const tagsLineRegex = /^(tags:\s*)\[(.*)\](\s*)$/m;
		const tagsMatch = frontmatter.match(tagsLineRegex);
		
		if (tagsMatch) {
			const existingTags = tagsMatch[2].split(',').map(t => t.trim()).filter(t => t);
			// Remove the filter tags and add the new tag
			const filteredTags = existingTags.filter(t => !tagsToRemove.includes(t));
			if (!filteredTags.includes(tagToAdd)) {
				filteredTags.push(tagToAdd);
			}
			newFrontmatter = frontmatter.replace(tagsLineRegex, `$1[${filteredTags.join(', ')}]$3`);
		} else {
			// Handle list format
			// First, remove the tags to remove
			for (const tagToRemove of tagsToRemove) {
				const listItemRegex = new RegExp(`^\\s*-\\s*${this.escapeRegex(tagToRemove)}\\s*$\\n?`, 'gm');
				newFrontmatter = newFrontmatter.replace(listItemRegex, '');
			}
			
			// Then add the new tag if there's a tags section
			const tagsHeaderRegex = /^tags:\s*$/m;
			if (tagsHeaderRegex.test(newFrontmatter)) {
				newFrontmatter = newFrontmatter.replace(tagsHeaderRegex, `tags:\n  - ${tagToAdd}`);
			}
		}
		
		if (newFrontmatter !== frontmatter) {
			const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
			await this.plugin.app.vault.modify(file, newContent);
		}
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for splitting/merging a tag into its parent tags
 */
class SplitTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private tag: string;
	private parentTags: string[];
	private childTags: string[];
	private childFiles: TFile[];

	constructor(plugin: TaggableTagsPlugin, tag: string, parentTags: string[], childTags: string[], childFiles: TFile[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.tag = tag;
		this.parentTags = parentTags;
		this.childTags = childTags;
		this.childFiles = childFiles;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('create-tag-from-filters-modal'); // Reuse same styling
		
		// "Replace" label
		contentEl.createEl('div', { text: 'Replace', cls: 'modal-label' });
		
		// Display the tag being split/merged
		const tagContainer = contentEl.createEl('div', { cls: 'modal-chips-container' });
		const tagChip = tagContainer.createEl('span', { cls: 'modal-chip modal-chip-tag' });
		tagChip.textContent = `#${this.tag}`;
		
		// "in" label
		contentEl.createEl('div', { text: 'in', cls: 'modal-label' });
		
		// Display direct children (tags and files)
		const itemsContainer = contentEl.createEl('div', { cls: 'modal-chips-container' });
		if (this.childTags.length === 0 && this.childFiles.length === 0) {
			itemsContainer.createEl('span', { text: '(no direct children)', cls: 'modal-empty-text' });
		} else {
			for (const childTag of this.childTags) {
				const chip = itemsContainer.createEl('span', { cls: 'modal-chip modal-chip-item' });
				chip.textContent = `#${childTag}`;
			}
			for (const file of this.childFiles) {
				const chip = itemsContainer.createEl('span', { cls: 'modal-chip modal-chip-file' });
				chip.textContent = file.basename;
			}
		}
		
		// "with" label
		contentEl.createEl('div', { text: 'with', cls: 'modal-label' });
		
		// Display parent tags (read-only)
		const parentsContainer = contentEl.createEl('div', { cls: 'modal-chips-container' });
		for (const parentTag of this.parentTags) {
			const chip = parentsContainer.createEl('span', { cls: 'modal-chip modal-chip-tag' });
			chip.textContent = `#${parentTag}`;
		}
		
		// Buttons
		const buttonContainer = contentEl.createEl('div', { cls: 'modal-buttons' });
		buttonContainer.style.marginTop = '16px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const actionText = this.parentTags.length > 1 ? 'Split' : 'Merge';
		const confirmBtn = buttonContainer.createEl('button', { text: actionText, cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => this.performSplit());
	}

	private async performSplit(): Promise<void> {
		try {
			this.close();
			
			// 1. For each direct child (tags and files), replace this tag with parent tags
			for (const childTag of this.childTags) {
				const tagFile = this.plugin.tagIndex.getTagFile(childTag);
				if (tagFile) {
					await this.replaceTagWithParents(tagFile);
				}
			}
			
			for (const file of this.childFiles) {
				await this.replaceTagWithParents(file);
			}
			
			// 2. Delete the tag file
			const tagFile = this.plugin.tagIndex.getTagFile(this.tag);
			if (tagFile) {
				markPluginInitiatedChange(tagFile.path);
				await this.plugin.app.vault.delete(tagFile);
			}
			
			// 3. Rebuild the index
			await this.plugin.tagIndex.rebuild();
			
			const actionText = this.parentTags.length > 1 ? 'Split' : 'Merged';
			new Notice(`${actionText} #${this.tag} into ${this.parentTags.map(t => '#' + t).join(', ')}`);
		} catch (error) {
			console.error('Failed to split/merge tag:', error);
			new Notice(`Failed to split/merge tag: ${error}`);
		}
	}

	/**
	 * Replace the tag with its parent tags in a file's frontmatter
	 */
	private async replaceTagWithParents(file: TFile): Promise<void> {
		markPluginInitiatedChange(file.path);
		const content = await this.plugin.app.vault.read(file);
		
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		if (!match) return;
		
		const frontmatter = match[1];
		let newFrontmatter = frontmatter;
		
		// Handle array format: tags: [tag1, tag2]
		const tagsLineRegex = /^(tags:\s*)\[(.*)\](\s*)$/m;
		const tagsMatch = frontmatter.match(tagsLineRegex);
		
		if (tagsMatch) {
			const existingTags = tagsMatch[2].split(',').map(t => t.trim()).filter(t => t);
			// Remove the tag being split and add parent tags
			const filteredTags = existingTags.filter(t => t !== this.tag);
			for (const parentTag of this.parentTags) {
				if (!filteredTags.includes(parentTag)) {
					filteredTags.push(parentTag);
				}
			}
			newFrontmatter = frontmatter.replace(tagsLineRegex, `$1[${filteredTags.join(', ')}]$3`);
		} else {
			// Handle list format
			// First, remove the tag being split
			const listItemRegex = new RegExp(`^\\s*-\\s*${this.escapeRegex(this.tag)}\\s*$\\n?`, 'gm');
			newFrontmatter = newFrontmatter.replace(listItemRegex, '');
			
			// Then add parent tags
			const tagsHeaderRegex = /^(tags:\s*)$/m;
			if (tagsHeaderRegex.test(newFrontmatter)) {
				const parentTagsList = this.parentTags.map(t => `  - ${t}`).join('\n');
				newFrontmatter = newFrontmatter.replace(tagsHeaderRegex, `$1\n${parentTagsList}`);
			}
		}
		
		if (newFrontmatter !== frontmatter) {
			const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
			await this.plugin.app.vault.modify(file, newContent);
		}
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Registers the Tag Explorer view
 */
export function registerTagExplorerView(plugin: TaggableTagsPlugin): void {
	plugin.registerView(
		TAG_EXPLORER_VIEW_TYPE,
		(leaf) => new TagExplorerView(leaf, plugin)
	);

	// Add command to open the view
	plugin.addCommand({
		id: 'open-tag-explorer',
		name: 'Open tag explorer',
		callback: () => {
			activateTagExplorerView(plugin);
		},
	});

	// Add ribbon icon
	plugin.addRibbonIcon('tags', 'Open Tag Explorer', () => {
		activateTagExplorerView(plugin);
	});
}

/**
 * Opens or focuses the Tag Explorer view
 */
export async function activateTagExplorerView(plugin: TaggableTagsPlugin): Promise<TagExplorerView | null> {
	const { workspace } = plugin.app;

	// Check if view is already open
	let leaf = workspace.getLeavesOfType(TAG_EXPLORER_VIEW_TYPE)[0];
	
	if (!leaf) {
		// Create new leaf in left sidebar
		const leftLeaf = workspace.getLeftLeaf(false);
		if (leftLeaf) {
			await leftLeaf.setViewState({
				type: TAG_EXPLORER_VIEW_TYPE,
				active: true,
			});
			leaf = leftLeaf;
		}
	}

	if (leaf) {
		workspace.revealLeaf(leaf);
		return leaf.view as TagExplorerView;
	}

	return null;
}

/**
 * Gets the Tag Explorer view if it's open
 */
export function getTagExplorerView(plugin: TaggableTagsPlugin): TagExplorerView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(TAG_EXPLORER_VIEW_TYPE);
	if (leaves.length > 0) {
		return leaves[0].view as TagExplorerView;
	}
	return null;
}
