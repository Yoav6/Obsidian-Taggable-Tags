import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { namesMatch } from '../utils/name-matching';

/**
 * The type of source that would create a tag during migration.
 */
export type TagSourceType = 'existing-tag' | 'folder' | 'nested-tag';

/**
 * A source that would create a tag during migration.
 */
export interface TagSource {
	/** The type of source */
	type: TagSourceType;
	/** The tag name this would create */
	name: string;
	/** For 'folder' type: the folder */
	folder?: TFolder;
	/** For 'folder' type: file inside folder with same name (will become tag note) */
	matchingFile?: TFile;
	/** For 'existing-tag' type: the tag file */
	existingTagFile?: TFile;
	/** For 'nested-tag' type: the full nested tag path (e.g., "media/games") */
	nestedTagPath?: string;
}

/**
 * A naming conflict between multiple tag sources.
 */
export interface NamingConflict {
	/** The conflicting tag name */
	name: string;
	/** All sources that would create this tag */
	sources: TagSource[];
}

/**
 * Represents how a conflict will be resolved.
 */
export interface ConflictResolution {
	/** The source being resolved */
	source: TagSource;
	/** The new name for this source */
	newName: string;
	/** Whether this source keeps its original name */
	keepsOriginalName: boolean;
}

/**
 * Result of conflict detection.
 */
export interface ConflictDetectionResult {
	/** All detected naming conflicts */
	conflicts: NamingConflict[];
	/** Proposed resolutions for each conflict */
	resolutions: Map<NamingConflict, ConflictResolution[]>;
}

/**
 * Detect naming conflicts that could cause issues during migration.
 * 
 * Conflicts occur when multiple sources would create the same tag:
 * - Multiple folders with the same leaf name
 * - A folder with the same name as an existing tag file (in a different location)
 * - Nested tags that flatten to the same leaf name as a folder
 * 
 * @param plugin The plugin instance
 * @param flattenNestedTags Whether nested tags will be flattened during migration
 */
export function detectNamingConflicts(
	plugin: TaggableTagsPlugin,
	flattenNestedTags: boolean = true
): ConflictDetectionResult {
	// Collect all tag sources
	const sourcesByName = collectTagSources(plugin, flattenNestedTags);
	
	// Find conflicts (2+ distinct sources for the same tag name)
	const conflicts: NamingConflict[] = [];
	for (const [name, sources] of sourcesByName) {
		const distinctSources = deduplicateSources(sources);
		if (distinctSources.length >= 2) {
			conflicts.push({ name, sources: distinctSources });
		}
	}
	
	// Generate proposed resolutions
	const resolutions = new Map<NamingConflict, ConflictResolution[]>();
	for (const conflict of conflicts) {
		resolutions.set(conflict, generateResolutions(plugin, conflict));
	}
	
	return { conflicts, resolutions };
}

/**
 * Collect all sources that would create tags during migration.
 */
function collectTagSources(
	plugin: TaggableTagsPlugin,
	flattenNestedTags: boolean
): Map<string, TagSource[]> {
	const sourcesByName = new Map<string, TagSource[]>();
	
	// 1. Collect existing tag files
	collectExistingTagFiles(plugin, sourcesByName);
	
	// 2. Collect folders (with their matching files)
	collectFolders(plugin, sourcesByName);
	
	// 3. Collect nested tags (if flattening)
	if (flattenNestedTags) {
		collectNestedTags(plugin, sourcesByName);
	}
	
	return sourcesByName;
}

/**
 * Collect existing tag files as sources.
 */
function collectExistingTagFiles(
	plugin: TaggableTagsPlugin,
	sourcesByName: Map<string, TagSource[]>
): void {
	const allTags = plugin.tagIndex.getAllTags();
	
	for (const tagName of allTags) {
		const tagFile = plugin.tagIndex.getTagFile(tagName);
		if (tagFile) {
			addSource(sourcesByName, tagName, {
				type: 'existing-tag',
				name: tagName,
				existingTagFile: tagFile,
			});
		}
	}
}

/**
 * Collect folders as sources.
 */
function collectFolders(
	plugin: TaggableTagsPlugin,
	sourcesByName: Map<string, TagSource[]>
): void {
	const root = plugin.app.vault.getRoot();
	
	function processFolder(folder: TFolder): void {
		if (folder.isRoot()) {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					processFolder(child);
				}
			}
			return;
		}
		
		const tagName = plugin.tagIndex.normalizeTag(folder.name);
		const matchingFile = findMatchingFileInFolder(plugin, folder, tagName);
		
		addSource(sourcesByName, tagName, {
			type: 'folder',
			name: tagName,
			folder,
			matchingFile,
		});
		
		// Process children
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				processFolder(child);
			}
		}
	}
	
	processFolder(root);
}

/**
 * Find a file inside a folder with a matching name (will become the tag note).
 */
function findMatchingFileInFolder(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	tagName: string
): TFile | undefined {
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		
		if (namesMatch(child.basename, tagName)) {
			return child;
		}
	}
	return undefined;
}

/**
 * Collect nested tags that will be flattened as sources.
 */
function collectNestedTags(
	plugin: TaggableTagsPlugin,
	sourcesByName: Map<string, TagSource[]>
): void {
	const files = plugin.app.vault.getMarkdownFiles();
	const seenNestedTags = new Set<string>();
	
	for (const file of files) {
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		
		const cache = plugin.app.metadataCache.getFileCache(file);
		if (!cache) continue;
		
		// Check frontmatter tags
		if (cache.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				for (const tag of fmTags) {
					if (typeof tag === 'string' && tag.includes('/') && !seenNestedTags.has(tag)) {
						seenNestedTags.add(tag);
						addNestedTagSource(plugin, sourcesByName, tag);
					}
				}
			}
		}
		
		// Check inline tags
		if (cache.tags) {
			for (const tagCache of cache.tags) {
				let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
				if (tagName.includes('/') && !seenNestedTags.has(tagName)) {
					seenNestedTags.add(tagName);
					addNestedTagSource(plugin, sourcesByName, tagName);
				}
			}
		}
	}
}

/**
 * Add a nested tag as a source for each of its levels.
 */
function addNestedTagSource(
	plugin: TaggableTagsPlugin,
	sourcesByName: Map<string, TagSource[]>,
	nestedTagPath: string
): void {
	const levels = nestedTagPath.split('/');
	
	// Each level of the nested tag becomes a potential tag
	for (const level of levels) {
		const normalizedLevel = plugin.tagIndex.normalizeTag(level);
		addSource(sourcesByName, normalizedLevel, {
			type: 'nested-tag',
			name: normalizedLevel,
			nestedTagPath,
		});
	}
}

/**
 * Add a source to the map.
 */
function addSource(
	sourcesByName: Map<string, TagSource[]>,
	name: string,
	source: TagSource
): void {
	if (!sourcesByName.has(name)) {
		sourcesByName.set(name, []);
	}
	sourcesByName.get(name)!.push(source);
}

/**
 * Deduplicate sources - merge sources that represent the same thing.
 * 
 * Rules:
 * - A folder containing an existing tag file for the same name = 1 source (existing tag wins)
 * - A folder with a matching file inside (that will become a tag file) = 1 source (the folder)
 * - Multiple nested tags with the same leaf name = 1 source (any one of them)
 * - If a folder's matching file IS an existing tag file, they're the same source
 */
function deduplicateSources(sources: TagSource[]): TagSource[] {
	const folders = sources.filter(s => s.type === 'folder');
	const existingTags = sources.filter(s => s.type === 'existing-tag');
	const nestedTags = sources.filter(s => s.type === 'nested-tag');
	
	const result: TagSource[] = [];
	const mergedFolderPaths = new Set<string>();
	const mergedTagFilePaths = new Set<string>();
	
	// Check each folder - does it have a matching file that's already a tag file?
	for (const folder of folders) {
		if (!folder.folder) continue;
		
		// Check if this folder's matching file is already an existing tag file
		if (folder.matchingFile) {
			const matchingTagSource = existingTags.find(t => 
				t.existingTagFile && t.existingTagFile.path === folder.matchingFile!.path
			);
			
			if (matchingTagSource) {
				// The folder's matching file IS an existing tag file
				// This is one unified source - the existing tag wins representation
				mergedFolderPaths.add(folder.folder.path);
				// Don't mark the tag as merged - we'll add it later
				continue;
			}
		}
		
		// Check if there's an existing tag file inside this folder (but not the matching file)
		const tagFileInFolder = existingTags.find(t => {
			if (!t.existingTagFile) return false;
			const parentFolder = t.existingTagFile.parent;
			return parentFolder && parentFolder.path === folder.folder!.path;
		});
		
		if (tagFileInFolder) {
			// Merge: existing tag file in folder = one source (existing tag wins)
			mergedFolderPaths.add(folder.folder.path);
			continue;
		}
	}
	
	// Add existing tags (they weren't filtered out)
	for (const tag of existingTags) {
		result.push(tag);
	}
	
	// Add folders that weren't merged with existing tags
	for (const folder of folders) {
		if (!mergedFolderPaths.has(folder.folder!.path)) {
			result.push(folder);
		}
	}
	
	// For nested tags, only add one representative (they all create the same tag)
	if (nestedTags.length > 0) {
		// Check if any existing tag or folder already covers this
		const hasExistingSource = result.length > 0;
		if (!hasExistingSource) {
			// Only add nested tag source if no folder/existing tag covers it
			result.push(nestedTags[0]);
		}
		// If there are folders/existing tags, nested tags don't add a new conflict
		// because the flatten step will just use the existing tag
	}
	
	return result;
}

/**
 * Generate resolution proposals for a conflict.
 * 
 * Priority for keeping original name:
 * 1. Existing tag file (it's already established)
 * 2. Shallowest folder (most general/top-level)
 * 3. First alphabetically
 */
function generateResolutions(
	plugin: TaggableTagsPlugin,
	conflict: NamingConflict
): ConflictResolution[] {
	const resolutions: ConflictResolution[] = [];
	
	// Sort sources by priority
	const sortedSources = [...conflict.sources].sort((a, b) => {
		// Existing tags have highest priority
		if (a.type === 'existing-tag' && b.type !== 'existing-tag') return -1;
		if (b.type === 'existing-tag' && a.type !== 'existing-tag') return 1;
		
		// Then folders by depth (shallowest first)
		if (a.type === 'folder' && b.type === 'folder') {
			const depthA = a.folder!.path.split('/').length;
			const depthB = b.folder!.path.split('/').length;
			if (depthA !== depthB) return depthA - depthB;
		}
		
		// Then alphabetically by path
		const pathA = getSourcePath(a);
		const pathB = getSourcePath(b);
		return pathA.localeCompare(pathB);
	});
	
	// First source keeps its name, others get renamed
	const keeper = sortedSources[0];
	
	for (const source of sortedSources) {
		if (source === keeper) {
			resolutions.push({
				source,
				newName: conflict.name,
				keepsOriginalName: true,
			});
		} else {
			resolutions.push({
				source,
				newName: generateUniqueName(plugin, source, conflict.name),
				keepsOriginalName: false,
			});
		}
	}
	
	return resolutions;
}

/**
 * Get a path string for a source (for sorting).
 */
function getSourcePath(source: TagSource): string {
	if (source.type === 'folder') return source.folder!.path;
	if (source.type === 'existing-tag') return source.existingTagFile!.path;
	if (source.type === 'nested-tag') return source.nestedTagPath || '';
	return '';
}

/**
 * Generate a unique name for a source by incorporating path context.
 */
function generateUniqueName(
	plugin: TaggableTagsPlugin,
	source: TagSource,
	originalName: string
): string {
	if (source.type === 'folder' && source.folder) {
		const parent = source.folder.parent;
		if (parent && !parent.isRoot()) {
			const parentName = plugin.tagIndex.normalizeTag(parent.name);
			return `${originalName}-${parentName}`;
		}
	}
	
	if (source.type === 'existing-tag' && source.existingTagFile) {
		const parent = source.existingTagFile.parent;
		if (parent && !parent.isRoot()) {
			const parentName = plugin.tagIndex.normalizeTag(parent.name);
			return `${originalName}-${parentName}`;
		}
	}
	
	if (source.type === 'nested-tag' && source.nestedTagPath) {
		const parts = source.nestedTagPath.split('/');
		if (parts.length >= 2) {
			// Use the parent level as context
			const parentLevel = parts[parts.length - 2];
			return `${originalName}-${parentLevel}`;
		}
	}
	
	// Fallback: numeric suffix
	return `${originalName}_2`;
}

/**
 * Apply the conflict resolutions by renaming folders and files.
 * Returns the number of items renamed.
 */
export async function applyConflictResolutions(
	plugin: TaggableTagsPlugin,
	resolutions: Map<NamingConflict, ConflictResolution[]>
): Promise<number> {
	let renamedCount = 0;
	
	for (const [conflict, conflictResolutions] of resolutions) {
		for (const resolution of conflictResolutions) {
			if (resolution.keepsOriginalName) continue;
			
			const source = resolution.source;
			const newName = resolution.newName;
			
			if (source.type === 'folder' && source.folder) {
				// Rename folder
				const renamed = await renameFolder(plugin, source.folder, newName);
				if (renamed) renamedCount++;
				
				// Also rename matching file inside folder if present
				if (source.matchingFile) {
					const fileRenamed = await renameFile(plugin, source.matchingFile, newName);
					if (fileRenamed) renamedCount++;
				}
			} else if (source.type === 'existing-tag' && source.existingTagFile) {
				// Rename tag file and update its tag property
				const renamed = await renameTagFile(plugin, source.existingTagFile, newName);
				if (renamed) renamedCount++;
			}
			// nested-tag sources don't need renaming - flatten will use whatever exists
		}
	}
	
	return renamedCount;
}

/**
 * Rename a folder.
 */
async function renameFolder(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	newName: string
): Promise<boolean> {
	const parentPath = folder.parent?.path || '';
	const newPath = parentPath ? `${parentPath}/${newName}` : newName;
	
	// Check if target path already exists
	const existing = plugin.app.vault.getAbstractFileByPath(newPath);
	if (existing) {
		console.warn(`Cannot rename folder ${folder.path} to ${newPath}: target already exists`);
		return false;
	}
	
	try {
		await plugin.app.vault.rename(folder, newPath);
		return true;
	} catch (error) {
		console.error(`Failed to rename folder ${folder.path}:`, error);
		return false;
	}
}

/**
 * Rename a file (keeping extension).
 */
async function renameFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	newName: string
): Promise<boolean> {
	const parentPath = file.parent?.path || '';
	const newPath = parentPath 
		? `${parentPath}/${newName}.${file.extension}`
		: `${newName}.${file.extension}`;
	
	// Check if target path already exists
	const existing = plugin.app.vault.getAbstractFileByPath(newPath);
	if (existing) {
		console.warn(`Cannot rename file ${file.path} to ${newPath}: target already exists`);
		return false;
	}
	
	try {
		await plugin.app.fileManager.renameFile(file, newPath);
		return true;
	} catch (error) {
		console.error(`Failed to rename file ${file.path}:`, error);
		return false;
	}
}

/**
 * Rename a tag file and update its tag property.
 */
async function renameTagFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	newTagName: string
): Promise<boolean> {
	// First update the tag property
	try {
		await plugin.app.fileManager.processFrontMatter(file, (fm) => {
			fm[plugin.settings.tagPropertyName] = newTagName;
		});
	} catch (error) {
		console.error(`Failed to update tag property in ${file.path}:`, error);
		return false;
	}
	
	// Then rename the file
	return await renameFile(plugin, file, newTagName);
}

/**
 * Check if there are any conflicts that need resolution.
 */
export function hasConflicts(result: ConflictDetectionResult): boolean {
	return result.conflicts.length > 0;
}

/**
 * Get total number of items that need to be renamed.
 */
export function countRenames(resolutions: Map<NamingConflict, ConflictResolution[]>): number {
	let count = 0;
	for (const conflictResolutions of resolutions.values()) {
		for (const resolution of conflictResolutions) {
			if (!resolution.keepsOriginalName) {
				count++;
			}
		}
	}
	return count;
}

/**
 * Get a human-readable description of a source.
 */
export function describeSource(source: TagSource): string {
	switch (source.type) {
		case 'folder':
			return `Folder: ${source.folder?.path || 'unknown'}`;
		case 'existing-tag':
			return `Tag file: ${source.existingTagFile?.path || 'unknown'}`;
		case 'nested-tag':
			return `Nested tag: #${source.nestedTagPath || 'unknown'}`;
		default:
			return 'Unknown source';
	}
}
