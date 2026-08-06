import { Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { getTagExplorerView } from '../ui/tag-explorer-view';

/**
 * Rebuild the tag index and refresh the tag explorer if it's open.
 */
export async function refreshTagIndex(plugin: TaggableTagsPlugin): Promise<void> {
	new Notice('Refreshing tag index...');

	const explorerView = getTagExplorerView(plugin);
	if (explorerView) {
		await explorerView.refresh();
	} else {
		await plugin.tagIndex.rebuild();
	}

	new Notice('Tag index refreshed');
}
