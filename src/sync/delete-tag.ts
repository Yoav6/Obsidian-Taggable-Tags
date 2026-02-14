import { TFile, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { markPluginInitiatedChange } from './file-rename-sync';

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes all instances of a tag from a file's content.
 * Handles both inline tags (#tag) and frontmatter tags.
 * Returns true if the file was modified.
 */
export async function removeTagFromFile(plugin: TaggableTagsPlugin, file: TFile, tag: string): Promise<boolean> {
	const content = await plugin.app.vault.read(file);
	let newContent = content;
	let changed = false;

	// Remove inline tags: #tag (with word boundary to avoid partial matches)
	const inlineRegex = new RegExp(`#${escapeRegex(tag)}(?![\\w-])`, 'g');
	if (inlineRegex.test(content)) {
		newContent = content.replace(inlineRegex, '');
		changed = true;
	}

	// Handle frontmatter tags
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const frontmatterMatch = newContent.match(frontmatterRegex);
	
	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		let newFrontmatter = frontmatter;
		
		// Handle YAML array format: tags: [tag1, tag2]
		// Need to handle various cases: only item, first item, middle item, last item
		const yamlArrayRegex = new RegExp(
			`(tags:\\s*\\[)([^\\]]*)(\\])`,
			'g'
		);
		
		newFrontmatter = newFrontmatter.replace(yamlArrayRegex, (match, prefix, items, suffix) => {
			// Split items, filter out the tag, rejoin
			const itemList = items.split(',').map((item: string) => item.trim()).filter((item: string) => item !== '');
			const filteredItems = itemList.filter((item: string) => {
				const normalizedItem = plugin.tagIndex.normalizeTag(item);
				const normalizedTag = plugin.tagIndex.normalizeTag(tag);
				return normalizedItem !== normalizedTag;
			});
			if (filteredItems.length !== itemList.length) {
				changed = true;
			}
			return `${prefix}${filteredItems.join(', ')}${suffix}`;
		});
		
		// Handle YAML list format: 
		// tags:
		//   - tag1
		//   - tag2
		const yamlListRegex = new RegExp(
			`^(\\s*-\\s*)${escapeRegex(tag)}(\\s*)$`,
			'gm'
		);
		if (yamlListRegex.test(newFrontmatter)) {
			newFrontmatter = newFrontmatter.replace(yamlListRegex, '');
			changed = true;
		}

		// Clean up empty lines in frontmatter that might result from removal
		newFrontmatter = newFrontmatter.replace(/\n\n+/g, '\n');

		if (newFrontmatter !== frontmatter) {
			newContent = newContent.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		}
	}

	// Clean up any double spaces or trailing spaces from inline tag removal
	newContent = newContent.replace(/  +/g, ' ');

	if (changed && newContent !== content) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
		return true;
	}

	return false;
}

/**
 * Removes all instances of multiple tags from all files in the vault.
 * Excludes files that are in the excludeFiles set.
 */
async function removeTagsFromAllFiles(
	plugin: TaggableTagsPlugin, 
	tags: string[], 
	excludeFiles: Set<string>
): Promise<number> {
	const files = plugin.app.vault.getMarkdownFiles();
	let filesUpdated = 0;

	for (const file of files) {
		// Skip files that will be deleted
		if (excludeFiles.has(file.path)) {
			continue;
		}

		let fileModified = false;
		for (const tag of tags) {
			const modified = await removeTagFromFile(plugin, file, tag);
			if (modified) {
				fileModified = true;
			}
		}
		if (fileModified) {
			filesUpdated++;
		}
	}

	return filesUpdated;
}

/**
 * Get all descendant tags of a tag (recursive, with cycle detection).
 */
function getAllDescendantTags(plugin: TaggableTagsPlugin, tag: string, visited: Set<string> = new Set()): Set<string> {
	const descendants = new Set<string>();
	
	// Prevent infinite recursion on cycles
	if (visited.has(tag)) {
		return descendants;
	}
	visited.add(tag);
	
	const children = plugin.tagIndex.getChildTags(tag);
	
	for (const child of children) {
		descendants.add(child);
		const childDescendants = getAllDescendantTags(plugin, child, new Set(visited));
		for (const d of childDescendants) {
			descendants.add(d);
		}
	}
	
	return descendants;
}

/**
 * Get exclusive descendants - tags whose ALL parents are in the deletion set.
 * A descendant is "exclusive" if removing the root tag would orphan it.
 */
function getExclusiveDescendants(plugin: TaggableTagsPlugin, rootTag: string): Set<string> {
	const deletionSet = new Set<string>([rootTag]);
	const toProcess = [rootTag];
	
	while (toProcess.length > 0) {
		const currentTag = toProcess.pop()!;
		const children = plugin.tagIndex.getChildTags(currentTag);
		
		for (const child of children) {
			// Skip if already in deletion set
			if (deletionSet.has(child)) {
				continue;
			}
			
			// Check if ALL parents of this child are in the deletion set
			const parents = plugin.tagIndex.getParentTags(child);
			const allParentsInDeletionSet = parents.every(p => deletionSet.has(p));
			
			if (allParentsInDeletionSet) {
				deletionSet.add(child);
				toProcess.push(child);
			}
		}
	}
	
	// Remove the root tag from the result (we only want descendants)
	deletionSet.delete(rootTag);
	return deletionSet;
}

/**
 * Collects note files that are "exclusive" to the given tags.
 * A file is exclusive if ALL of its tags are in the deletion set.
 * These are files that have the tag but are NOT tag files themselves.
 */
function getExclusiveChildFiles(plugin: TaggableTagsPlugin, tagsToDelete: Set<string>): Set<TFile> {
	const files = new Set<TFile>();
	const checkedFiles = new Set<string>();
	
	for (const tag of tagsToDelete) {
		const tagFiles = plugin.tagIndex.getFilesWithTag(tag);
		for (const file of tagFiles) {
			// Skip if already checked or if it's a tag file
			if (checkedFiles.has(file.path) || plugin.tagIndex.isTagFile(file)) {
				continue;
			}
			checkedFiles.add(file.path);
			
			// Get all tags this file has
			const fileTags = getFileNonNestedTags(plugin, file);
			
			// Check if ALL of the file's tags are in the deletion set
			const allTagsBeingDeleted = fileTags.every(t => tagsToDelete.has(t));
			
			if (allTagsBeingDeleted) {
				files.add(file);
			}
		}
	}
	
	return files;
}

/**
 * Gets all non-nested tags from a file (both frontmatter and inline).
 */
function getFileNonNestedTags(plugin: TaggableTagsPlugin, file: TFile): string[] {
	const tags: string[] = [];
	const cache = plugin.app.metadataCache.getFileCache(file);
	
	if (!cache) return tags;
	
	// Get tags from frontmatter
	if (cache.frontmatter?.tags) {
		const fmTags = cache.frontmatter.tags;
		if (Array.isArray(fmTags)) {
			for (const tag of fmTags) {
				if (typeof tag === 'string' && !tag.includes('/')) {
					tags.push(plugin.tagIndex.normalizeTag(tag));
				}
			}
		}
	}
	
	// Get inline tags
	if (cache.tags) {
		for (const tagCache of cache.tags) {
			const tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
			if (!tagName.includes('/')) {
				tags.push(plugin.tagIndex.normalizeTag(tagName));
			}
		}
	}
	
	return [...new Set(tags)]; // Remove duplicates
}

export interface DeleteTagResult {
	tagsDeleted: number;
	filesDeleted: number;
	instancesRemoved: number;
}

/**
 * Mode 1: Delete tag file and remove all instances of the tag from the vault.
 * Does NOT delete child tags or files tagged with this tag.
 */
export async function deleteTagAndInstances(
	plugin: TaggableTagsPlugin, 
	tagName: string
): Promise<DeleteTagResult> {
	const normalizedTag = plugin.tagIndex.normalizeTag(tagName);
	const tagFile = plugin.tagIndex.getTagFile(normalizedTag);
	
	// Collect files that will NOT be deleted (all files except the tag file)
	const excludeFiles = new Set<string>();
	if (tagFile) {
		excludeFiles.add(tagFile.path);
	}
	
	// Remove tag instances from all files
	const instancesRemoved = await removeTagsFromAllFiles(plugin, [normalizedTag], excludeFiles);
	
	// Delete the tag file
	let tagsDeleted = 0;
	if (tagFile) {
		markPluginInitiatedChange(tagFile.path);
		await plugin.app.vault.delete(tagFile);
		tagsDeleted = 1;
	}
	
	// Rebuild the index
	await plugin.tagIndex.rebuild();
	
	return {
		tagsDeleted,
		filesDeleted: 0,
		instancesRemoved
	};
}

/**
 * Mode 2: Delete tag, its instances, and exclusive children (children with no other parents).
 * Also removes instances of deleted child tags from remaining files.
 */
export async function deleteTagAndExclusiveChildren(
	plugin: TaggableTagsPlugin, 
	tagName: string
): Promise<DeleteTagResult> {
	const normalizedTag = plugin.tagIndex.normalizeTag(tagName);
	
	// Get exclusive descendants
	const exclusiveDescendants = getExclusiveDescendants(plugin, normalizedTag);
	const allTagsToDelete = new Set([normalizedTag, ...exclusiveDescendants]);
	
	// Collect all tag files to delete
	const tagFilesToDelete: TFile[] = [];
	for (const tag of allTagsToDelete) {
		const tagFile = plugin.tagIndex.getTagFile(tag);
		if (tagFile) {
			tagFilesToDelete.push(tagFile);
		}
	}
	
	// Collect note files that are exclusive to deleted tags (all their tags are being deleted)
	const noteFilesToDelete = getExclusiveChildFiles(plugin, allTagsToDelete);
	
	// Build set of files to exclude from tag removal (files being deleted)
	const excludeFiles = new Set<string>();
	for (const file of tagFilesToDelete) {
		excludeFiles.add(file.path);
	}
	for (const file of noteFilesToDelete) {
		excludeFiles.add(file.path);
	}
	
	// Remove all tag instances from files that won't be deleted
	const instancesRemoved = await removeTagsFromAllFiles(
		plugin, 
		Array.from(allTagsToDelete), 
		excludeFiles
	);
	
	// Delete note files
	for (const file of noteFilesToDelete) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.delete(file);
	}
	
	// Delete tag files
	for (const file of tagFilesToDelete) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.delete(file);
	}
	
	// Rebuild the index
	await plugin.tagIndex.rebuild();
	
	return {
		tagsDeleted: tagFilesToDelete.length,
		filesDeleted: noteFilesToDelete.size,
		instancesRemoved
	};
}

/**
 * Mode 3: Delete tag, its instances, and ALL children (regardless of other parents).
 * Also removes instances of all deleted tags from remaining files.
 */
export async function deleteTagAndAllChildren(
	plugin: TaggableTagsPlugin, 
	tagName: string
): Promise<DeleteTagResult> {
	const normalizedTag = plugin.tagIndex.normalizeTag(tagName);
	
	// Get all descendants
	const allDescendants = getAllDescendantTags(plugin, normalizedTag);
	const allTagsToDelete = new Set([normalizedTag, ...allDescendants]);
	
	// Collect all tag files to delete
	const tagFilesToDelete: TFile[] = [];
	for (const tag of allTagsToDelete) {
		const tagFile = plugin.tagIndex.getTagFile(tag);
		if (tagFile) {
			tagFilesToDelete.push(tagFile);
		}
	}
	
	// Collect note files that are exclusive to deleted tags (all their tags are being deleted)
	const noteFilesToDelete = getExclusiveChildFiles(plugin, allTagsToDelete);
	
	// Build set of files to exclude from tag removal (files being deleted)
	const excludeFiles = new Set<string>();
	for (const file of tagFilesToDelete) {
		excludeFiles.add(file.path);
	}
	for (const file of noteFilesToDelete) {
		excludeFiles.add(file.path);
	}
	
	// Remove all tag instances from files that won't be deleted
	const instancesRemoved = await removeTagsFromAllFiles(
		plugin, 
		Array.from(allTagsToDelete), 
		excludeFiles
	);
	
	// Delete note files
	for (const file of noteFilesToDelete) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.delete(file);
	}
	
	// Delete tag files
	for (const file of tagFilesToDelete) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.delete(file);
	}
	
	// Rebuild the index
	await plugin.tagIndex.rebuild();
	
	return {
		tagsDeleted: tagFilesToDelete.length,
		filesDeleted: noteFilesToDelete.size,
		instancesRemoved
	};
}

/**
 * Get statistics about what will be deleted for each mode.
 * Used to display information in the confirmation modal.
 */
export interface DeleteTagStats {
	tagName: string;
	hasTagFile: boolean;
	instanceCount: number;
	childTagCount: number;
	exclusiveChildTagCount: number;
	directChildFileCount: number;
	allDescendantFileCount: number;
}

export function getDeleteTagStats(plugin: TaggableTagsPlugin, tagName: string): DeleteTagStats {
	const normalizedTag = plugin.tagIndex.normalizeTag(tagName);
	const tagFile = plugin.tagIndex.getTagFile(normalizedTag);
	
	// Count instances (files using this tag)
	const instanceCount = plugin.tagIndex.getTagCount(normalizedTag);
	
	// Get all descendants
	const allDescendants = getAllDescendantTags(plugin, normalizedTag);
	const exclusiveDescendants = getExclusiveDescendants(plugin, normalizedTag);
	
	// Count exclusive child files for "exclusive children" mode
	// These are files whose ALL tags are in the deletion set (root + exclusive descendants)
	const exclusiveTagSet = new Set([normalizedTag, ...exclusiveDescendants]);
	const exclusiveChildFiles = getExclusiveChildFiles(plugin, exclusiveTagSet);
	
	// Count exclusive child files for "all children" mode
	// These are files whose ALL tags are in the deletion set (root + all descendants)
	const allTagsIncludingDescendants = new Set([normalizedTag, ...allDescendants]);
	const allDescendantFiles = getExclusiveChildFiles(plugin, allTagsIncludingDescendants);
	
	return {
		tagName: normalizedTag,
		hasTagFile: tagFile !== null,
		instanceCount,
		childTagCount: allDescendants.size,
		exclusiveChildTagCount: exclusiveDescendants.size,
		directChildFileCount: exclusiveChildFiles.size,
		allDescendantFileCount: allDescendantFiles.size
	};
}
