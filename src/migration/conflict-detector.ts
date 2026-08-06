import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { findMatchingFileInFolder } from '../utils/name-matching';
import { toComparisonKey } from '../utils/tag-naming';
import { findMisplacedMatchingNotes, uniqueNameForSource } from '../utils/cycle-prevention';

/**
 * The type of source that would create a tag during migration.
 */
export type TagSourceType = 'existing-tag' | 'folder' | 'nested-tag' | 'matching-note';

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
	/** For 'matching-note' type: a deep note whose basename matches an ancestor tag */
	matchingNote?: TFile;
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
 * - A deep note whose basename matches an ancestor folder (e.g. Sociognosticism/Beliefs.md)
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
			conflicts.push({ name: distinctSources[0]?.name ?? name, sources: distinctSources });
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

	// 4. Misplaced notes that match an ancestor folder name
	collectMisplacedMatchingNotes(plugin, sourcesByName);
	
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
			}, plugin);
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
		const matchingFile = findMatchingFileInFolder(plugin, folder, tagName) ?? undefined;
		
		addSource(sourcesByName, tagName, {
			type: 'folder',
			name: tagName,
			folder,
			matchingFile,
		}, plugin);
		
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
 * Collect notes whose basename matches an ancestor folder (misplaced matching notes).
 */
function collectMisplacedMatchingNotes(
	plugin: TaggableTagsPlugin,
	sourcesByName: Map<string, TagSource[]>
): void {
	for (const hit of findMisplacedMatchingNotes(plugin)) {
		addSource(sourcesByName, hit.tagName, {
			type: 'matching-note',
			name: hit.tagName,
			matchingNote: hit.file,
		}, plugin);
	}
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
		}, plugin);
	}
}

/**
 * Add a source to the map (keyed by comparison key so casing/separators match).
 */
function addSource(
	sourcesByName: Map<string, TagSource[]>,
	name: string,
	source: TagSource,
	plugin?: TaggableTagsPlugin
): void {
	const key = toComparisonKey(name, plugin?.settings);
	if (!sourcesByName.has(key)) {
		sourcesByName.set(key, []);
	}
	sourcesByName.get(key)!.push(source);
}

/**
 * Deduplicate sources - merge sources that represent the same thing.
 * 
 * Rules:
 * - Multiple folders with the same leaf name are ALWAYS kept distinct (they conflict;
 *   the deeper one must be renamed to avoid cycles like Beliefs/.../Beliefs)
 * - A single folder containing an existing tag file for the same name = 1 source (existing tag wins)
 * - A folder with a matching file inside (that will become a tag file) = 1 source (the folder)
 * - Multiple nested tags with the same leaf name = 1 source (any one of them)
 * - If a folder's matching file IS an existing tag file, they're the same source
 */
function deduplicateSources(sources: TagSource[]): TagSource[] {
	const folders = sources.filter(s => s.type === 'folder');
	const existingTags = sources.filter(s => s.type === 'existing-tag');
	const nestedTags = sources.filter(s => s.type === 'nested-tag');
	const matchingNotes = sources.filter(s => s.type === 'matching-note');
	
	// Multiple folders with the same name always conflict — keep all of them.
	// Do not merge any with existing tag files; the folder rename is what matters.
	if (folders.length >= 2) {
		// Still include misplaced matching notes — they also need renaming
		return [...folders, ...matchingNotes];
	}

	const result: TagSource[] = [];
	const mergedFolderPaths = new Set<string>();
	
	// Single folder (or none) — merge with existing tag when they represent the same thing
	for (const folder of folders) {
		if (!folder.folder) continue;
		
		// Check if this folder's matching file is already an existing tag file
		if (folder.matchingFile) {
			const matchingTagSource = existingTags.find(t => 
				t.existingTagFile && t.existingTagFile.path === folder.matchingFile!.path
			);
			
			if (matchingTagSource) {
				mergedFolderPaths.add(folder.folder.path);
				continue;
			}
		}
		
		// Check if there's an existing tag file inside this folder
		const tagFileInFolder = existingTags.find(t => {
			if (!t.existingTagFile) return false;
			const parentFolder = t.existingTagFile.parent;
			return parentFolder && parentFolder.path === folder.folder!.path;
		});
		
		if (tagFileInFolder) {
			mergedFolderPaths.add(folder.folder.path);
			continue;
		}
	}
	
	// Add existing tags
	for (const tag of existingTags) {
		result.push(tag);
	}
	
	// Add folders that weren't merged with existing tags
	for (const folder of folders) {
		if (!mergedFolderPaths.has(folder.folder!.path)) {
			result.push(folder);
		}
	}

	// Misplaced matching notes always remain as distinct sources (must be renamed)
	for (const note of matchingNotes) {
		result.push(note);
	}
	
	// For nested tags, only add one representative if nothing else covers this name
	if (nestedTags.length > 0 && result.length === 0) {
		result.push(nestedTags[0]);
	}
	
	return result;
}

/**
 * Vault depth of a source — shallower sources keep the original name so that
 * nested same-named folders (Beliefs/.../Beliefs) are the ones renamed.
 */
function getSourceDepth(source: TagSource): number {
	if (source.type === 'folder' && source.folder) {
		return source.folder.path.split('/').filter(Boolean).length;
	}
	if (source.type === 'existing-tag' && source.existingTagFile) {
		const parent = source.existingTagFile.parent;
		if (!parent || parent.isRoot()) return 1;
		return parent.path.split('/').filter(Boolean).length;
	}
	if (source.type === 'matching-note' && source.matchingNote) {
		const parent = source.matchingNote.parent;
		if (!parent || parent.isRoot()) return 1;
		return parent.path.split('/').filter(Boolean).length;
	}
	if (source.type === 'nested-tag' && source.nestedTagPath) {
		return source.nestedTagPath.split('/').filter(Boolean).length;
	}
	return 999;
}

/**
 * Generate resolution proposals for a conflict.
 * 
 * Priority for keeping original name:
 * 1. Shallowest in the vault hierarchy (avoids cycles from Beliefs/.../Beliefs)
 * 2. Existing tag file over folder over nested-tag (at equal depth)
 * 3. First alphabetically by path
 */
function generateResolutions(
	plugin: TaggableTagsPlugin,
	conflict: NamingConflict
): ConflictResolution[] {
	const resolutions: ConflictResolution[] = [];
	
	const typePriority = (t: TagSourceType): number => {
		if (t === 'existing-tag') return 0;
		if (t === 'folder') return 1;
		if (t === 'matching-note') return 3; // Always rename deep matching notes before nested-tag
		return 2;
	};

	const sortedSources = [...conflict.sources].sort((a, b) => {
		const depthA = getSourceDepth(a);
		const depthB = getSourceDepth(b);
		if (depthA !== depthB) return depthA - depthB;

		const typeDiff = typePriority(a.type) - typePriority(b.type);
		if (typeDiff !== 0) return typeDiff;
		
		return getSourcePath(a).localeCompare(getSourcePath(b));
	});
	
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
	if (source.type === 'matching-note') return source.matchingNote!.path;
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
	return uniqueNameForSource(plugin, source, originalName);
}

/**
 * Result of applying conflict resolutions.
 */
export interface ApplyConflictResolutionsResult {
	renamedCount: number;
	/**
	 * After renaming a folder away from conflict leaf L, map new folder path → [L]
	 * so tag creation can dual-parent the new tag under L and the folder parent.
	 */
	collisionParentsByFolderPath: Map<string, string[]>;
}

/**
 * Apply the conflict resolutions by renaming folders and files.
 */
export async function applyConflictResolutions(
	plugin: TaggableTagsPlugin,
	resolutions: Map<NamingConflict, ConflictResolution[]>
): Promise<ApplyConflictResolutionsResult> {
	let renamedCount = 0;
	const collisionParentsByFolderPath = new Map<string, string[]>();
	
	for (const [conflict, conflictResolutions] of resolutions) {
		const collisionLeaf = plugin.tagIndex.normalizeTag(conflict.name);

		for (const resolution of conflictResolutions) {
			if (resolution.keepsOriginalName) continue;
			
			const source = resolution.source;
			const newName = resolution.newName;
			const displayName = plugin.tagIndex.toDisplayName(newName);
			const canonicalName = plugin.tagIndex.normalizeTag(newName);
			
			if (source.type === 'folder' && source.folder) {
				const oldFolderName = source.folder.name;
				const renamed = await renameFolder(plugin, source.folder, displayName);
				if (renamed) {
					renamedCount++;
					// Folder path updated in place after rename
					const newPath = source.folder.path;
					const existing = collisionParentsByFolderPath.get(newPath) ?? [];
					if (!existing.some(p => plugin.tagIndex.tagsMatch(p, collisionLeaf))) {
						existing.push(collisionLeaf);
					}
					collisionParentsByFolderPath.set(newPath, existing);
				}
				
				let matchingFile = source.matchingFile;
				if (!matchingFile && source.folder) {
					for (const child of source.folder.children) {
						if (child instanceof TFile && child.extension === 'md') {
							const base = child.basename;
							if (
								base === oldFolderName ||
								plugin.tagIndex.tagsMatch(base, conflict.name) ||
								plugin.tagIndex.tagsMatch(base, source.name)
							) {
								matchingFile = child;
								break;
							}
						}
					}
				}
				if (matchingFile) {
					if (plugin.tagIndex.isTagFile(matchingFile)) {
						const fileRenamed = await renameTagFile(plugin, matchingFile, canonicalName);
						if (fileRenamed) renamedCount++;
					} else {
						const fileRenamed = await renameFile(plugin, matchingFile, displayName);
						if (fileRenamed) renamedCount++;
					}
				}
			} else if (source.type === 'existing-tag' && source.existingTagFile) {
				const renamed = await renameTagFile(plugin, source.existingTagFile, canonicalName);
				if (renamed) renamedCount++;

				const parent = source.existingTagFile.parent;
				if (parent && !parent.isRoot() && plugin.tagIndex.tagsMatch(parent.name, conflict.name)) {
					const folderRenamed = await renameFolder(plugin, parent, displayName);
					if (folderRenamed) {
						renamedCount++;
						const newPath = parent.path;
						const existing = collisionParentsByFolderPath.get(newPath) ?? [];
						if (!existing.some(p => plugin.tagIndex.tagsMatch(p, collisionLeaf))) {
							existing.push(collisionLeaf);
						}
						collisionParentsByFolderPath.set(newPath, existing);
					}
				}
			} else if (source.type === 'matching-note' && source.matchingNote) {
				if (plugin.tagIndex.isTagFile(source.matchingNote)) {
					const renamed = await renameTagFile(plugin, source.matchingNote, canonicalName);
					if (renamed) renamedCount++;
				} else {
					const renamed = await renameFile(plugin, source.matchingNote, displayName);
					if (renamed) renamedCount++;
				}
			}
		}
	}
	
	return { renamedCount, collisionParentsByFolderPath };
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
	
	// Then rename the file using display naming rules
	return await renameFile(plugin, file, plugin.tagIndex.toDisplayName(newTagName));
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
		case 'matching-note':
			return `Matching note: ${source.matchingNote?.path || 'unknown'}`;
		case 'nested-tag':
			return `Nested tag: #${source.nestedTagPath || 'unknown'}`;
		default:
			return 'Unknown source';
	}
}
