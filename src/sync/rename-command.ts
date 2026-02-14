import { TFile, normalizePath } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { updateTagProperty, replaceTagEverywhere, markPluginInitiatedChange } from './file-rename-sync';

/**
 * Renames a tag throughout the entire vault by updating the tag property in the tag file.
 */
export async function renameTag(plugin: TaggableTagsPlugin, oldTag: string, newTag: string): Promise<void> {
	const app = plugin.app;
	
	// Normalize the new tag
	const normalizedNewTag = plugin.tagIndex.normalizeTag(newTag);
	
	// Get the tag file if it exists
	const tagFile = plugin.tagIndex.getTagFile(oldTag);
	
	// Replace all occurrences of the old tag throughout the vault
	await replaceTagEverywhere(plugin, oldTag, normalizedNewTag, tagFile ?? undefined);
	
	// Update the tag property in the tag file if it exists
	if (tagFile) {
		markPluginInitiatedChange(tagFile.path);
		await updateTagProperty(plugin, tagFile, normalizedNewTag);
		
		// Update the index
		plugin.tagIndex.onTagPropertyChanged(tagFile, oldTag);
		
		// If syncFileNamesWithTags is enabled, also rename the file
		if (plugin.settings.syncFileNamesWithTags) {
			const sanitizedTagName = plugin.tagIndex.sanitizeTagName(normalizedNewTag);
			const newFileName = `${sanitizedTagName}.md`;
			const currentDir = tagFile.parent?.path || '';
			const newPath = normalizePath(currentDir ? `${currentDir}/${newFileName}` : newFileName);
			
			if (newPath !== tagFile.path) {
				markPluginInitiatedChange(tagFile.path);
				await app.fileManager.renameFile(tagFile, newPath);
			}
		}
	}

	// Rebuild the index
	await plugin.tagIndex.rebuild();

	console.log(`Renamed tag #${oldTag} to #${normalizedNewTag}`);
}
