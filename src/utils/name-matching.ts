import { TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Normalize a name for comparison by:
 * - Converting to lowercase
 * - Replacing hyphens and underscores with spaces
 * - Trimming whitespace
 */
export function normalizeForComparison(name: string): string {
	return name
		.toLowerCase()
		.replace(/[-_]/g, ' ')
		.trim();
}

/**
 * Check if two names match when normalized.
 */
export function namesMatch(name1: string, name2: string): boolean {
	return normalizeForComparison(name1) === normalizeForComparison(name2);
}

/**
 * Find an existing file with a name that matches the tag name (when normalized),
 * but doesn't have the tag property (i.e., it's not already a tag file).
 * 
 * @param plugin The plugin instance
 * @param tagName The tag name to match against
 * @returns The matching file, or null if none found
 */
export function findMatchingNonTagFile(
	plugin: TaggableTagsPlugin,
	tagName: string
): TFile | null {
	const normalizedTagName = normalizeForComparison(tagName);
	const propName = plugin.settings.tagPropertyName;
	
	// Get all markdown files
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		// Check if the basename matches (normalized)
		if (normalizeForComparison(file.basename) !== normalizedTagName) {
			continue;
		}
		
		// Check if this file already has the tag property
		const cache = plugin.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		
		// If the file has the tag property, it's already a tag file - skip it
		if (frontmatter && propName in frontmatter) {
			continue;
		}
		
		// Found a matching file without the tag property
		return file;
	}
	
	return null;
}
