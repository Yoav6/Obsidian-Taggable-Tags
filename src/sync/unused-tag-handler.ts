import { TFile, debounce, Notice, normalizePath, CachedMetadata } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { readFrontmatterTags } from '../utils/frontmatter';
import { UnusedTagModal } from '../ui/unused-tag-modal';
import { updateTagProperty, markPluginInitiatedChange, isPluginInitiatedChange } from './file-rename-sync';
import { deleteTagAndInstances } from './delete-tag';

// Track tags we've already prompted about to avoid duplicate modals
const promptedUnusedTags = new Set<string>();

/**
 * Extract all tags from a file's metadata cache
 */
function getTagsFromCache(cache: CachedMetadata | null, plugin: TaggableTagsPlugin): Set<string> {
	const tags = new Set<string>();
	if (!cache) return tags;
	
	// Get tags from frontmatter
	for (const tag of readFrontmatterTags(cache)) {
		if (!tag.includes('/')) {
			tags.add(plugin.tagIndex.normalizeTag(tag));
		}
	}
	
	// Get inline tags
	if (cache.tags) {
		for (const tagCache of cache.tags) {
			let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
			if (!tagName.includes('/')) {
				tags.add(plugin.tagIndex.normalizeTag(tagName));
			}
		}
	}
	
	return tags;
}

/**
 * Sets up detection and handling of unused tag files.
 * A tag is "unused" when it has zero usages in any file.
 */
export function setupUnusedTagHandler(plugin: TaggableTagsPlugin): void {
	// Debounced handler to check specific tags
	const checkTagsForUnused = debounce(
		async (tagsToCheck: string[]) => {
			if (!plugin.settings.confirmUnusedTagDeletion) {
				return;
			}

			for (const tag of tagsToCheck) {
				// Skip if we've already prompted about this tag
				if (promptedUnusedTags.has(tag)) {
					continue;
				}

				// Check if this tag has a tag file
				const tagFile = plugin.tagIndex.getTagFile(tag);
				if (!tagFile) {
					continue;
				}

				// Check if the tag is still used (count should be 0 after index rebuild)
				if (plugin.tagIndex.getTagCount(tag) > 0) {
					continue;
				}

				// Tag is unused and has a tag file - prompt user
				promptedUnusedTags.add(tag);
				await handleUnusedTag(plugin, tagFile, tag);
				promptedUnusedTags.delete(tag);
			}
		},
		500,
		true
	);

	// Listen for metadata cache changes
	plugin.registerEvent(
		plugin.app.metadataCache.on('changed', async (file: TFile) => {
			if (isPluginInitiatedChange(file.path)) {
				return;
			}
			// Ignore changes in the tag registry note only
			if (plugin.tagIndex.isTagRegistryNote(file)) {
				return;
			}

			// Get the tags this file had BEFORE (from the current index state)
			const previousTags = new Set(plugin.tagIndex.getTagsForFile(file));
			
			// Get the tags this file has NOW (from the updated metadata cache)
			const cache = plugin.app.metadataCache.getFileCache(file);
			const currentTags = getTagsFromCache(cache, plugin);
			
			// Find tags that were removed
			const removedTags: string[] = [];
			for (const tag of previousTags) {
				if (!currentTags.has(tag)) {
					removedTags.push(tag);
				}
			}
			
			// If tags were removed, rebuild index and check if any are now unused
			if (removedTags.length > 0) {
				await plugin.tagIndex.rebuild();
				checkTagsForUnused(removedTags);
			}
		})
	);

	// Listen for file deletion
	plugin.registerEvent(
		plugin.app.vault.on('delete', async (file) => {
			if (file instanceof TFile && isPluginInitiatedChange(file.path)) {
				return;
			}
			if (file instanceof TFile && !plugin.tagIndex.isTagFile(file) && !plugin.tagIndex.isTagRegistryNote(file)) {
				// Get the tags this file had before deletion
				const previousTags = plugin.tagIndex.getTagsForFile(file);
				
				if (previousTags.length > 0) {
					await plugin.tagIndex.rebuild();
					checkTagsForUnused(previousTags);
				}
			}
		})
	);
}

/**
 * Handles an unused tag by showing a modal and performing the chosen action.
 */
async function handleUnusedTag(plugin: TaggableTagsPlugin, tagFile: TFile, tagName: string): Promise<void> {
	const modal = new UnusedTagModal(plugin, tagFile, tagName);
	const result = await modal.prompt();

	if (!result) {
		// Modal was closed without choosing
		return;
	}

	switch (result.action) {
		case 'keep':
			// Nothing to do
			break;

		case 'delete':
			try {
				const result = await deleteTagAndInstances(plugin, tagName);
				new Notice(`Deleted tag #${tagName}${result.instancesRemoved > 0 ? ` (removed from ${result.instancesRemoved} file(s))` : ''}`);
				// Update the tag registry
				await plugin.updateTagRegistry();
			} catch (error) {
				new Notice(`Failed to delete tag: ${String(error)}`);
			}
			break;

		case 'rename':
			if (result.newName) {
				try {
					const normalizedNewTag = plugin.tagIndex.normalizeTag(result.newName);
					
					// Update the tag property in the file
					markPluginInitiatedChange(tagFile.path);
					await updateTagProperty(plugin, tagFile, normalizedNewTag);
					
					// Update the index
					plugin.tagIndex.onTagPropertyChanged(tagFile, tagName);
					
					// If syncFileNamesWithTags is enabled, also rename the file
					if (plugin.settings.syncFileNamesWithTags) {
						const displayName = plugin.tagIndex.toDisplayName(normalizedNewTag);
						const newFileName = `${displayName}.md`;
						const currentDir = tagFile.parent?.path || '';
						const newPath = normalizePath(currentDir ? `${currentDir}/${newFileName}` : newFileName);
						
						if (newPath !== tagFile.path) {
							markPluginInitiatedChange(tagFile.path);
							await plugin.app.fileManager.renameFile(tagFile, newPath);
						}
					}
					
					new Notice(`Renamed tag to #${normalizedNewTag}`);
					new Notice(`Renamed unused tag: #${tagName} → #${normalizedNewTag}`);
					
					// Rebuild index
					await plugin.tagIndex.rebuild();
				} catch (error) {
					new Notice(`Failed to rename tag: ${String(error)}`);
				}
			}
			break;
	}
}
