import { TFile, debounce, normalizePath } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { generateTagFileContent, addTagPropertiesToFile } from '../utils/tag-template';
import { findMatchingNonTagFile } from '../utils/name-matching';
import { askUseExistingFile } from '../ui/use-existing-file-modal';

/**
 * Sets up automatic creation of tag files when new tags are used in the vault.
 */
export function setupAutoCreate(plugin: TaggableTagsPlugin): void {
	// Debounce to avoid excessive processing during rapid edits
	const processNewTags = debounce(
		async () => {
			if (!plugin.settings.autoCreateFiles) {
				return;
			}
			await createMissingTagFiles(plugin);
		},
		1000, // 1 second debounce
		true  // Run on leading edge as well
	);

	// Listen for metadata cache changes - trigger for ALL files
	// Tags can be added to any file (including tag files for parent relationships)
	plugin.registerEvent(
		plugin.app.metadataCache.on('changed', () => {
			processNewTags();
		})
	);

	// Also listen for file creation
	plugin.registerEvent(
		plugin.app.vault.on('create', (file) => {
			if (file instanceof TFile) {
				processNewTags();
			}
		})
	);
}

/**
 * Give every tag that lacks a tag file one. Returns how many were created.
 *
 * This is the only tag-driven creation path — the folder sync and nested-tag flatten
 * passes are keyed on folders and on `/` in a tag, so a plain tag used only inside
 * notes is never reached by them.
 */
export async function createMissingTagFiles(plugin: TaggableTagsPlugin): Promise<number> {
	// Rebuild the index to get current state
	await plugin.tagIndex.rebuild();

	let created = 0;
	for (const tag of plugin.tagIndex.getTagsWithoutFiles()) {
		const file = await createTagFile(plugin, tag);
		if (file) {
			created++;
		}
	}

	if (created > 0) {
		await plugin.updateTagRegistry();
	}

	return created;
}

/**
 * Creates a tag definition file for the given tag.
 */
export async function createTagFile(plugin: TaggableTagsPlugin, tag: string): Promise<TFile | null> {
	try {
		const normalizedTag = plugin.tagIndex.normalizeTag(tag);
		const displayName = plugin.tagIndex.toDisplayName(normalizedTag);
		
		// Create file in vault root with display name as filename
		const filePath = normalizePath(`${displayName}.md`);
		
		// Check if file already exists at the exact path
		const existingFile = plugin.app.vault.getAbstractFileByPath(filePath);
		if (existingFile) {
			return existingFile instanceof TFile ? existingFile : null;
		}

		// Check for existing files with matching names (if setting is not 'off')
		const existingFileBehavior = plugin.settings.existingFileBehavior;
		if (existingFileBehavior !== 'off') {
			const matchingFile = findMatchingNonTagFile(plugin, normalizedTag, {
				onlyUnder: plugin.app.vault.getRoot(),
				directChildOnly: true,
			});
			if (matchingFile) {
				let useExisting = false;
				
				if (existingFileBehavior === 'auto') {
					useExisting = true;
				} else {
					// 'ask' - show modal
					useExisting = await askUseExistingFile(plugin, matchingFile, normalizedTag);
				}
				
				if (useExisting) {
					// Add tag properties to the existing file
					await addTagPropertiesToFile(plugin, matchingFile, normalizedTag);
					
					// Update the index
					plugin.tagIndex.onTagFileCreated(matchingFile, normalizedTag);
					
					return matchingFile;
				}
			}
		}

		// Create the file with appropriate frontmatter (using template if configured)
		const content = await generateTagFileContent(plugin, normalizedTag);
		const file = await plugin.app.vault.create(filePath, content);
		
		// Update the index (pass tag name since metadata cache hasn't updated yet)
		plugin.tagIndex.onTagFileCreated(file, normalizedTag);
		
		return file;
	} catch {
		return null;
	}
}
