import { TFile, Notice, normalizePath } from 'obsidian';
import type TaggableTagsPlugin from '../main';

// Track changes initiated by the plugin to avoid loops
const pluginInitiatedChanges = new Set<string>();
// Track previous tag property values for change detection
const previousTagValues: Map<string, string | null> = new Map();

/**
 * Sets up watching for tag file changes and syncing them to tags in the vault.
 */
export function setupFileRenameSync(plugin: TaggableTagsPlugin): void {
	// Handle file renames
	plugin.registerEvent(
		plugin.app.vault.on('rename', async (file, oldPath) => {
			// Only handle markdown files
			if (!(file instanceof TFile) || file.extension !== 'md') {
				return;
			}

			// Check if this change was initiated by the plugin
			// Note: Don't delete the flag here - other handlers (like folder-sync) also need to check it.
			if (pluginInitiatedChanges.has(oldPath)) {
				// Update the index with new path
				plugin.tagIndex.onTagFileRenamed(file, oldPath);
				// Update our tracking map
				const oldValue = previousTagValues.get(oldPath);
				if (oldValue !== undefined) {
					previousTagValues.delete(oldPath);
					previousTagValues.set(file.path, oldValue);
				}
				return;
			}

			// Check if this is a tag file
			const isTagFile = plugin.tagIndex.isTagFile(file);
			const wasTagFile = plugin.tagIndex.getTagForFilePath(oldPath) !== null;

			if (!isTagFile && !wasTagFile) {
				return;
			}

			// Update the index for the path change
			plugin.tagIndex.onTagFileRenamed(file, oldPath);
			
			// Update our tracking map
			const oldValue = previousTagValues.get(oldPath);
			if (oldValue !== undefined) {
				previousTagValues.delete(oldPath);
				previousTagValues.set(file.path, oldValue);
			}

			// If syncFileNamesWithTags is enabled, update the tag property to match the new filename
			if (plugin.settings.syncFileNamesWithTags && isTagFile) {
				const currentTag = plugin.tagIndex.getTagPropertyValue(file);
				const newTagFromFilename = plugin.tagIndex.unsanitizeTagName(file.basename);
				const normalizedNewTag = plugin.tagIndex.normalizeTag(newTagFromFilename);
				
				if (currentTag && !plugin.tagIndex.tagsMatch(normalizedNewTag, currentTag)) {
					// Mark as plugin-initiated to avoid loops
					markPluginInitiatedChange(file.path);
					
					try {
						// Update the tag property to match the new filename
						await updateTagProperty(plugin, file, normalizedNewTag);
						
						// Replace all occurrences of the old tag with the new tag
						await replaceTagEverywhere(plugin, currentTag, normalizedNewTag, file);
						
					// Update the index
					plugin.tagIndex.onTagPropertyChanged(file, currentTag);
					previousTagValues.set(file.path, normalizedNewTag);
					
					// Update the tag registry
					await plugin.updateTagRegistry();
					
					new Notice(`Renamed tag #${currentTag} to #${normalizedNewTag}`);
					} catch (error) {
						console.error('Failed to sync tag rename:', error);
						new Notice(`Failed to sync tag rename: ${String(error)}`);
					}
				}
			}
		})
	);

	// Handle file deletion
	plugin.registerEvent(
		plugin.app.vault.on('delete', (file) => {
			if (file instanceof TFile) {
				const tag = plugin.tagIndex.getTagForFilePath(file.path);
				if (tag) {
					plugin.tagIndex.onTagFileDeleted(file.path);
					previousTagValues.delete(file.path);
				}
			}
		})
	);

	// Handle file creation
	plugin.registerEvent(
		plugin.app.vault.on('create', (file) => {
			if (file instanceof TFile && file.extension === 'md') {
				// Will be handled by metadata cache change when frontmatter is parsed
			}
		})
	);

	// Handle metadata cache changes (for property value changes)
	plugin.registerEvent(
		plugin.app.metadataCache.on('changed', async (file: TFile) => {
			// Only handle markdown files
			if (file.extension !== 'md') {
				return;
			}

			// Check if this change was initiated by the plugin
			// Note: Don't delete the flag here - other handlers (like folder-sync) also need to check it.
			// The flag will be cleaned up by the timeout in markPluginInitiatedChange.
			if (pluginInitiatedChanges.has(file.path)) {
				return;
			}

			const currentTagValue = plugin.tagIndex.getTagPropertyValue(file);
			const previousTagValue = previousTagValues.get(file.path) ?? null;
			const normalizedCurrent = currentTagValue ? plugin.tagIndex.normalizeTag(currentTagValue) : null;
			const normalizedPrevious = previousTagValue ? plugin.tagIndex.normalizeTag(previousTagValue) : null;

			// Check if this file just became a tag file (property added)
			if (normalizedCurrent && !normalizedPrevious) {
				previousTagValues.set(file.path, normalizedCurrent);
				plugin.tagIndex.onTagFileCreated(file);
				// Update the tag registry
				await plugin.updateTagRegistry();
				return;
			}

			// Check if this file stopped being a tag file (property removed)
			if (!normalizedCurrent && normalizedPrevious) {
				previousTagValues.delete(file.path);
				plugin.tagIndex.onTagFileDeleted(file.path);
				// Update the tag registry
				await plugin.updateTagRegistry();
				return;
			}

			// Check if the tag property value changed
			if (normalizedCurrent && normalizedPrevious && !plugin.tagIndex.tagsMatch(normalizedCurrent, normalizedPrevious)) {
				
				// Mark as plugin-initiated to avoid loops
				markPluginInitiatedChange(file.path);

				try {
					// Replace all occurrences of the old tag with the new tag
					await replaceTagEverywhere(plugin, normalizedPrevious, normalizedCurrent, file);
					
					// Update the index
					plugin.tagIndex.onTagPropertyChanged(file, normalizedPrevious);
					previousTagValues.set(file.path, normalizedCurrent);

					// If syncFileNamesWithTags is enabled, rename the file to match the new tag
					if (plugin.settings.syncFileNamesWithTags) {
						const displayName = plugin.tagIndex.toDisplayName(normalizedCurrent);
						const newFileName = `${displayName}.md`;
						const currentDir = file.parent?.path || '';
						const newPath = normalizePath(currentDir ? `${currentDir}/${newFileName}` : newFileName);
						
						if (newPath !== file.path) {
							markPluginInitiatedChange(file.path);
							await plugin.app.fileManager.renameFile(file, newPath);
						}
					}
					
					// Update the tag registry
					await plugin.updateTagRegistry();
					
					new Notice(`Renamed tag #${normalizedPrevious} to #${normalizedCurrent}`);
				} catch (error) {
					console.error('Failed to sync tag rename:', error);
					new Notice(`Failed to sync tag rename: ${String(error)}`);
				}
			}
		})
	);

	// Initialize previous tag values for existing tag files
	initializePreviousTagValues(plugin);
}

/**
 * Initialize the previous tag values map with current tag files.
 */
function initializePreviousTagValues(plugin: TaggableTagsPlugin): void {
	const files = plugin.app.vault.getMarkdownFiles();
	for (const file of files) {
		const tagValue = plugin.tagIndex.getTagPropertyValue(file);
		if (tagValue) {
			previousTagValues.set(file.path, plugin.tagIndex.normalizeTag(tagValue));
		}
	}
}

/**
 * Mark a file path as being changed by the plugin.
 * This prevents the event handlers from processing it as a user-initiated change.
 */
export function markPluginInitiatedChange(path: string): void {
	pluginInitiatedChanges.add(path);
	// Clean up after a short delay - metadata cache events fire within ~100ms,
	// so 500ms is plenty of buffer while not blocking subsequent user changes.
	window.setTimeout(() => {
		pluginInitiatedChanges.delete(path);
	}, 500);
}

/**
 * Check if a change was initiated by the plugin.
 */
export function isPluginInitiatedChange(path: string): boolean {
	return pluginInitiatedChanges.has(path);
}

/**
 * Clear a plugin-initiated change marker immediately.
 * Call this after all relevant event handlers have processed the change.
 */
export function clearPluginInitiatedChange(path: string): void {
	pluginInitiatedChanges.delete(path);
}

/**
 * Updates the tag property value in a file's frontmatter.
 */
export async function updateTagProperty(plugin: TaggableTagsPlugin, file: TFile, newTagValue: string): Promise<void> {
	const content = await plugin.app.vault.read(file);
	const propName = plugin.settings.tagPropertyName;
	
	// Check if file has frontmatter
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	
	let newContent: string;
	
	if (match) {
		const frontmatter = match[1];
		// Check if property already exists
		const propRegex = new RegExp(`^(${escapeRegex(propName)}:\\s*)(.*)$`, 'm');
		const propMatch = frontmatter.match(propRegex);
		
		if (propMatch) {
			// Update existing property
			const newFrontmatter = frontmatter.replace(propRegex, `$1${newTagValue}`);
			newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		} else {
			// Add property to existing frontmatter
			const newFrontmatter = `${propName}: ${newTagValue}\n${frontmatter}`;
			newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		}
	} else {
		// File has no frontmatter - add it
		newContent = `---\n${propName}: ${newTagValue}\n---\n${content}`;
	}
	
	if (newContent !== content) {
		await plugin.app.vault.modify(file, newContent);
	}
}

/**
 * Replaces all occurrences of a tag throughout the vault (excluding the source tag file).
 */
export async function replaceTagEverywhere(
	plugin: TaggableTagsPlugin, 
	oldTag: string, 
	newTag: string,
	excludeFile?: TFile
): Promise<void> {
	const app = plugin.app;
	const files = app.vault.getMarkdownFiles();
	
	for (const file of files) {
		// Skip the file that triggered the change (its property was already updated)
		if (excludeFile && file.path === excludeFile.path) {
			continue;
		}
		
		// Replace in all files (including other tag files for parent/child references)
		await replaceTagInFile(plugin, file, oldTag, newTag);
	}

}

/**
 * Replaces all occurrences of a tag in a file.
 * Handles both inline tags (#tag) and frontmatter tags.
 */
async function replaceTagInFile(plugin: TaggableTagsPlugin, file: TFile, oldTag: string, newTag: string): Promise<boolean> {
	const content = await plugin.app.vault.read(file);
	let newContent = content;
	let changed = false;

	// Replace inline tags: #oldTag -> #newTag (case-insensitive)
	// Make sure to handle word boundaries to avoid partial matches
	const inlineRegex = new RegExp(`#${escapeRegex(oldTag)}(?![\\w-])`, 'gi');
	if (inlineRegex.test(content)) {
		newContent = content.replace(inlineRegex, `#${newTag}`);
		changed = true;
	}

	// Replace frontmatter tags
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const frontmatterMatch = newContent.match(frontmatterRegex);
	
	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		let newFrontmatter = frontmatter;
		
		// Handle YAML array format: tags: [tag1, tag2]
		const yamlArrayRegex = new RegExp(
			`(tags:\\s*\\[[^\\]]*)\\b${escapeRegex(oldTag)}\\b([^\\]]*\\])`,
			'gi'
		);
		if (yamlArrayRegex.test(frontmatter)) {
			newFrontmatter = frontmatter.replace(yamlArrayRegex, `$1${newTag}$2`);
			changed = true;
		}
		
		// Handle YAML list format
		const yamlListRegex = new RegExp(
			`(^\\s*-\\s*)${escapeRegex(oldTag)}(\\s*$)`,
			'gim'
		);
		if (yamlListRegex.test(newFrontmatter)) {
			newFrontmatter = newFrontmatter.replace(yamlListRegex, `$1${newTag}$2`);
			changed = true;
		}

		if (newFrontmatter !== frontmatter) {
			newContent = newContent.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		}
	}

	if (changed && newContent !== content) {
		// Mark as plugin-initiated to avoid triggering loops
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
		return true;
	}

	return false;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
