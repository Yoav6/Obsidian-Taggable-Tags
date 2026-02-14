import { TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { markPluginInitiatedChange } from '../sync/file-rename-sync';

/**
 * Set a tag as the first tag in a file's frontmatter tags array.
 * If the tag already exists, it will be moved to the first position.
 * If it doesn't exist, it will be added at the beginning.
 * 
 * @param plugin The plugin instance
 * @param file The file to modify
 * @param tag The tag to set as first (without #)
 */
export async function setFirstTag(plugin: TaggableTagsPlugin, file: TFile, tag: string): Promise<void> {
	const normalizedTag = plugin.tagIndex.normalizeTag(tag);
	const content = await plugin.app.vault.read(file);
	
	// Check if file has frontmatter
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	
	let newContent: string;
	
	if (match) {
		const frontmatter = match[1];
		const newFrontmatter = updateTagsInFrontmatter(frontmatter, normalizedTag, 'setFirst');
		newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
	} else {
		// File has no frontmatter - add it with the tag
		newContent = `---\ntags:\n  - ${normalizedTag}\n---\n${content}`;
	}
	
	if (newContent !== content) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
	}
}

/**
 * Reorder tags so that a specific tag becomes the first one.
 * Unlike setFirstTag, this only reorders existing tags without adding new ones.
 * 
 * @param plugin The plugin instance
 * @param file The file to modify
 * @param newFirstTag The tag to move to first position (without #)
 * @returns true if the tag was found and reordered, false if the tag wasn't in the file
 */
export async function reorderTags(plugin: TaggableTagsPlugin, file: TFile, newFirstTag: string): Promise<boolean> {
	const normalizedTag = plugin.tagIndex.normalizeTag(newFirstTag);
	const existingTags = plugin.tagIndex.getAllTagsFromFile(file);
	
	// Check if the tag exists in the file
	if (!existingTags.includes(normalizedTag)) {
		return false;
	}
	
	const content = await plugin.app.vault.read(file);
	
	// Check if file has frontmatter
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	
	if (!match) {
		return false;
	}
	
	const frontmatter = match[1];
	const newFrontmatter = updateTagsInFrontmatter(frontmatter, normalizedTag, 'reorder');
	
	if (newFrontmatter !== frontmatter) {
		const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
		return true;
	}
	
	return false;
}

/**
 * Remove a specific tag from a file's frontmatter.
 * 
 * @param plugin The plugin instance
 * @param file The file to modify
 * @param tagToRemove The tag to remove (without #)
 */
export async function removeTag(plugin: TaggableTagsPlugin, file: TFile, tagToRemove: string): Promise<void> {
	const normalizedTag = plugin.tagIndex.normalizeTag(tagToRemove);
	const content = await plugin.app.vault.read(file);
	
	// Check if file has frontmatter
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	
	if (!match) {
		return;
	}
	
	const frontmatter = match[1];
	const newFrontmatter = updateTagsInFrontmatter(frontmatter, normalizedTag, 'remove');
	
	if (newFrontmatter !== frontmatter) {
		const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
	}
}

/**
 * Update the tags property in frontmatter YAML.
 * Handles both array format (tags: [a, b]) and list format (tags:\n  - a\n  - b).
 * 
 * @param frontmatter The frontmatter content (without --- delimiters)
 * @param tag The tag to operate on
 * @param operation The operation: 'setFirst' adds/moves to first, 'reorder' only moves existing, 'remove' removes the tag
 * @returns The updated frontmatter
 */
function updateTagsInFrontmatter(
	frontmatter: string,
	tag: string,
	operation: 'setFirst' | 'reorder' | 'remove'
): string {
	// Try to detect the format used
	const arrayFormatRegex = /^(tags:\s*)\[([^\]]*)\]/m;
	const listFormatRegex = /^tags:\s*\n((?:\s+-\s+[^\n]+\n?)*)/m;
	
	const arrayMatch = frontmatter.match(arrayFormatRegex);
	const listMatch = frontmatter.match(listFormatRegex);
	
	if (arrayMatch) {
		// Handle array format: tags: [tag1, tag2]
		const prefix = arrayMatch[1];
		const tagsContent = arrayMatch[2];
		const tags = tagsContent
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);
		
		const newTags = applyTagOperation(tags, tag, operation);
		const newTagsStr = newTags.join(', ');
		
		return frontmatter.replace(arrayFormatRegex, `${prefix}[${newTagsStr}]`);
	} else if (listMatch) {
		// Handle list format: tags:\n  - tag1\n  - tag2
		const listContent = listMatch[1];
		const tagLineRegex = /^\s+-\s+(.+)$/gm;
		const tags: string[] = [];
		let tagLineMatch;
		
		while ((tagLineMatch = tagLineRegex.exec(listContent)) !== null) {
			tags.push(tagLineMatch[1].trim());
		}
		
		const newTags = applyTagOperation(tags, tag, operation);
		
		// Reconstruct the list format
		const newListContent = newTags.map(t => `  - ${t}`).join('\n');
		const newTagsSection = newTags.length > 0 ? `tags:\n${newListContent}` : 'tags: []';
		
		return frontmatter.replace(listFormatRegex, newTagsSection + '\n');
	} else {
		// No tags property exists - add it if operation is setFirst
		if (operation === 'setFirst') {
			return `tags:\n  - ${tag}\n${frontmatter}`;
		}
		return frontmatter;
	}
}

/**
 * Apply a tag operation to a tags array.
 */
function applyTagOperation(
	tags: string[],
	tag: string,
	operation: 'setFirst' | 'reorder' | 'remove'
): string[] {
	// Normalize for comparison
	const normalizedTag = tag.toLowerCase();
	const tagIndex = tags.findIndex(t => t.toLowerCase() === normalizedTag);
	
	switch (operation) {
		case 'setFirst':
			if (tagIndex === -1) {
				// Tag doesn't exist - add it at the beginning
				return [tag, ...tags];
			} else if (tagIndex === 0) {
				// Already first - no change needed
				return tags;
			} else {
				// Move to first position
				const newTags = [...tags];
				newTags.splice(tagIndex, 1);
				return [tag, ...newTags];
			}
		
		case 'reorder':
			if (tagIndex === -1 || tagIndex === 0) {
				// Tag doesn't exist or already first - no change
				return tags;
			} else {
				// Move to first position
				const newTags = [...tags];
				newTags.splice(tagIndex, 1);
				return [tag, ...newTags];
			}
		
		case 'remove':
			if (tagIndex === -1) {
				// Tag doesn't exist - no change
				return tags;
			} else {
				// Remove the tag
				const newTags = [...tags];
				newTags.splice(tagIndex, 1);
				return newTags;
			}
	}
}
