import type TaggableTagsPlugin from '../main';

/**
 * Sets up hover previews for tags using Obsidian's native page preview.
 * When hovering over a tag, shows a preview of the tag definition file.
 */
export function setupHoverPreview(plugin: TaggableTagsPlugin): void {
	// Handle hover on tag elements in the DOM
	// We use mouseover to trigger Obsidian's native hover-link event
	plugin.registerDomEvent(document, 'mouseover', (event: MouseEvent) => {
		const target = event.target as HTMLElement;
		
		// Get tag info from the element (handles body tags and property tags)
		const tagInfo = getTagInfo(target);
		
		if (!tagInfo) {
			return;
		}

		const tagFile = plugin.tagIndex.getTagFile(tagInfo.tagName);
		if (!tagFile) {
			return;
		}

		// Find the parent element for the hover popover
		// This should be a view container or the workspace
		const hoverParent = target.closest('.workspace-leaf-content') 
			|| target.closest('.view-content')
			|| target.closest('.markdown-reading-view')
			|| target.closest('.markdown-source-view')
			|| target.closest('.metadata-container')
			|| document.body;

		// Trigger Obsidian's native hover-link event
		// This will show the same preview as hovering over a regular link
		plugin.app.workspace.trigger('hover-link', {
			event: event,
			source: 'taggable-tags',
			hoverParent: hoverParent,
			targetEl: target,
			linktext: tagFile.path,
			sourcePath: tagFile.path,
		});
	});
}

/**
 * Get tag info from various tag element types
 * Returns the tag name if the element is a tag, null otherwise
 */
function getTagInfo(target: HTMLElement): { tagName: string } | null {
	// Check for body tags (reading view and editor)
	// In reading view: a.tag
	// In editor: .cm-hashtag elements
	const isBodyTag = target.matches('a.tag') || 
		target.classList.contains('cm-hashtag-end') ||
		(target.classList.contains('cm-hashtag') && !target.classList.contains('cm-hashtag-begin'));

	if (isBodyTag) {
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

		if (tagName) {
			return { tagName };
		}
	}

	// Check for property tags
	// The structure is: .metadata-property[data-property-key="tags"] > ... > .multi-select-pill > .multi-select-pill-content
	const pillContent = target.closest('.multi-select-pill-content') as HTMLElement | null;
	const pill = target.closest('.multi-select-pill') as HTMLElement | null;
	
	// Check if we're hovering on the pill content or the pill itself (but not the remove button)
	const isOnPillContent = pillContent !== null;
	const isOnPill = pill !== null && !target.closest('.multi-select-pill-remove-button');
	
	if (isOnPillContent || isOnPill) {
		const propertyEl = target.closest('.metadata-property[data-property-key="tags"]');
		if (propertyEl) {
			// Get the tag name from the pill content
			const contentEl = pillContent || pill?.querySelector('.multi-select-pill-content');
			const tagName = contentEl?.textContent?.trim() ?? '';
			
			if (tagName) {
				return { tagName };
			}
		}
	}

	return null;
}
