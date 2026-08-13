import { Menu } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { activateTagExplorerView } from './tag-explorer-view';
import { addTagContextMenuItems } from './tag-context-menu';

// Track if we handled a property tag on pointerdown to prevent the click from firing
let handledPropertyTagPointerDown = false;

/**
 * Sets up click handling on tags to filter them in the Tag Explorer view.
 */
export function setupTagClickNavigation(plugin: TaggableTagsPlugin): void {
	// Handle pointerdown on property tags - this fires before Obsidian's handlers
	// We need this because property tags have their own click handling that we can't intercept with click events
	// Only handle left clicks (button 0), not right clicks
	plugin.registerDomEvent(document, 'pointerdown', (event: PointerEvent) => {
		handledPropertyTagPointerDown = false;
		
		// Only handle left mouse button (primary button)
		if (event.button !== 0) {
			return;
		}
		
		const target = event.target as HTMLElement;
		const propertyTagInfo = getPropertyTagInfo(target);
		
		if (!propertyTagInfo) {
			return;
		}

		// Ctrl/Cmd+click opens the tag file in a new pane
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			handledPropertyTagPointerDown = true;
			
			const tagFile = plugin.tagIndex.getTagFile(propertyTagInfo.tagName);
			if (tagFile) {
				void plugin.app.workspace.getLeaf('tab').openFile(tagFile);
			}
			return;
		}

		// Check the setting for tag click behavior
		const behavior = plugin.settings.tagClickBehavior;
		
		// If set to default, let Obsidian handle it
		if (behavior === 'default') {
			return;
		}

		// Mark that we're handling this
		handledPropertyTagPointerDown = true;

		// Prevent default behavior and stop propagation
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();

		// Handle the tag click asynchronously
		void handleTagFilter(plugin, propertyTagInfo.tagName, behavior);
	}, true); // Use capture phase

	// Also prevent the click event from firing on property tags we handled
	plugin.registerDomEvent(document, 'click', (event: MouseEvent) => {
		if (handledPropertyTagPointerDown) {
			const target = event.target as HTMLElement;
			if (getPropertyTagInfo(target)) {
				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();
			}
			handledPropertyTagPointerDown = false;
			return;
		}
	}, true);

	// Handle clicks on tags in reading view and editor (these work fine with click events)
	plugin.registerDomEvent(document, 'click', (event: MouseEvent) => { void (async () => {
		const target = event.target as HTMLElement;
		
		// Check if the target is a tag element (not property tags - those are handled above)
		// In reading view: a.tag
		// In editor: .cm-hashtag elements
		const isTagElement = target.matches('a.tag') || 
			target.classList.contains('cm-hashtag-end') ||
			(target.classList.contains('cm-hashtag') && !target.classList.contains('cm-hashtag-begin'));

		if (!isTagElement) {
			return;
		}

		// Get the tag name from the element
		const tagName = extractTagName(target);

		if (!tagName) {
			return;
		}

		// Ctrl/Cmd+click opens the tag file in a new pane
		if (event.ctrlKey || event.metaKey) {
			event.preventDefault();
			event.stopPropagation();
			
			const tagFile = plugin.tagIndex.getTagFile(tagName);
			if (tagFile) {
				await plugin.app.workspace.getLeaf('tab').openFile(tagFile);
			}
			return;
		}

		// Check the setting for tag click behavior
		const behavior = plugin.settings.tagClickBehavior;
		
		// If set to default, let Obsidian handle it
		if (behavior === 'default') {
			return;
		}

		// Prevent default behavior (opening search)
		event.preventDefault();
		event.stopPropagation();

		// Handle the tag filter
		await handleTagFilter(plugin, tagName, behavior);
	})(); }, true); // Use capture phase to intercept before Obsidian's handler

	// Add items to the editor context menu when right-clicking on a tag
	plugin.registerEvent(
		plugin.app.workspace.on('editor-menu', (menu, editor, view) => {
			// Get the tag at the cursor position
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			const tagName = findTagAtPosition(line, cursor.ch);
			
			if (tagName && view.file) {
				addTagContextMenuItems(plugin, menu, tagName, view.file);
			}
		})
	);

	// Handle context menu on property tags - add items to the existing menu
	// We use monkey-patching to intercept Menu.forEvent before the menu is shown
	plugin.registerDomEvent(document, 'contextmenu', (event: MouseEvent) => {
		const target = event.target as HTMLElement;
		
		// Check if the target is a property tag
		const propertyTagInfo = getPropertyTagInfo(target);
		if (propertyTagInfo) {
			const tagName = propertyTagInfo.tagName;
			// Get the current file from the active view
			const activeFile = plugin.app.workspace.getActiveFile();
			const originalForEvent = Menu.forEvent.bind(Menu);
			
			Menu.forEvent = ((e: PointerEvent | MouseEvent) => {
				const menu = originalForEvent(e);
				if (e === event) {
					addTagContextMenuItems(plugin, menu, tagName, activeFile ?? undefined);
					Menu.forEvent = originalForEvent;
				}
				return menu;
			});
			
			window.setTimeout(() => {
				Menu.forEvent = originalForEvent;
			}, 0);
		}
	}, true);
}

/**
 * Handle filtering by a tag in the explorer
 */
async function handleTagFilter(plugin: TaggableTagsPlugin, tagName: string, behavior: string): Promise<void> {
	// Activate the explorer view (opens it if not already open)
	const explorerView = await activateTagExplorerView(plugin);
	if (!explorerView) {
		return;
	}

	// Apply the filter based on the behavior setting
	if (behavior === 'replace') {
		explorerView.setFilterTag(tagName);
	} else if (behavior === 'add') {
		explorerView.addFilterTagPublic(tagName);
	}
}

/**
 * Get tag info from a property tag element, or null if not a property tag
 */
function getPropertyTagInfo(target: HTMLElement): { tagName: string } | null {
	// Check if it's within a tags property
	// The structure is: .metadata-property[data-property-key="tags"] > ... > .multi-select-pill > .multi-select-pill-content
	const pillContent = target.closest('.multi-select-pill-content');
	const pill = target.closest('.multi-select-pill');
	
	// Check if we're clicking on the pill content or the pill itself (but not the remove button)
	const isOnPillContent = pillContent !== null;
	const isOnPill = pill !== null && !target.closest('.multi-select-pill-remove-button');
	
	if (!isOnPillContent && !isOnPill) {
		return null;
	}
	
	const propertyEl = target.closest('.metadata-property[data-property-key="tags"]');
	if (!propertyEl) {
		return null;
	}
	
	// Get the tag name from the pill content
	const contentEl = pillContent || pill?.querySelector('.multi-select-pill-content');
	const tagName = contentEl?.textContent?.trim() ?? '';
	
	if (!tagName) {
		return null;
	}
	
	return { tagName };
}

/**
 * Extract the tag name from various tag element types
 */
function extractTagName(target: HTMLElement): string | null {
	let tagName = target.textContent?.trim() ?? '';
	
	// Handle the case where the tag might include #
	if (tagName.startsWith('#')) {
		tagName = tagName.slice(1);
	}

	// For a.tag elements, the href might have the tag
	if (target.matches('a.tag')) {
		const href = target.getAttribute('href');
		if (href) {
			tagName = href.replace(/^#/, '');
		}
	}

	return tagName || null;
}

/**
 * Finds a tag at or near the given position in a line
 */
function findTagAtPosition(line: string, position: number): string | null {
	// Regular expression to find tags
	const tagRegex = /#([a-zA-Z0-9_\-/]+)/g;
	let match;

	while ((match = tagRegex.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		
		// Check if the cursor is within this tag
		if (position >= start && position <= end) {
			return match[1]; // Return tag without #
		}
	}

	return null;
}
