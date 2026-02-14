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

			// Rebuild the index to get current state
			await plugin.tagIndex.rebuild();

			// Find tags without files
			const tagsWithoutFiles = plugin.tagIndex.getTagsWithoutFiles();
			
			let createdAny = false;
			for (const tag of tagsWithoutFiles) {
				const file = await createTagFile(plugin, tag);
				if (file) {
					createdAny = true;
				}
			}
			
			// Update the tag registry if any new tag files were created
			if (createdAny) {
				await plugin.updateTagRegistry();
			}
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
 * Creates a tag definition file for the given tag.
 */
export async function createTagFile(plugin: TaggableTagsPlugin, tag: string): Promise<TFile | null> {
	try {
		// Normalize tag to lowercase if setting is enabled
		const normalizedTag = plugin.settings.forceLowercase ? tag.toLowerCase() : tag;
		
		// Sanitize the tag name for use as filename
		const sanitizedTagName = plugin.tagIndex.sanitizeTagName(normalizedTag);
		
		// Create file in vault root with tag name as filename
		const filePath = normalizePath(`${sanitizedTagName}.md`);
		
		// Check if file already exists at the exact path
		const existingFile = plugin.app.vault.getAbstractFileByPath(filePath);
		if (existingFile) {
			return existingFile instanceof TFile ? existingFile : null;
		}

		// Check for existing files with matching names (if setting is not 'off')
		const existingFileBehavior = plugin.settings.existingFileBehavior;
		if (existingFileBehavior !== 'off') {
			const matchingFile = findMatchingNonTagFile(plugin, normalizedTag);
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
	} catch (error) {
		return null;
	}
}

