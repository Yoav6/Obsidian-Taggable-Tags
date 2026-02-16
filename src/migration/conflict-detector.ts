import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Represents a naming conflict where multiple folders/files share the same name.
 */
export interface NamingConflict {
	/** The conflicting name (normalized) */
	name: string;
	/** All folders with this leaf name */
	folders: TFolder[];
	/** All files with this basename (excluding tag files) */
	files: TFile[];
	/** Existing tag file for this name, if any */
	existingTag: TFile | null;
}

/**
 * Represents how a conflict will be resolved.
 */
export interface ConflictResolution {
	/** The original folder or file */
	original: TFolder | TFile;
	/** The new name (without extension for files) */
	newName: string;
	/** Whether this item keeps its original name */
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
 * Detect naming conflicts that could cause circular relationships during migration.
 * 
 * Conflicts occur when:
 * - Multiple folders have the same leaf name (e.g., beliefs/group/beliefs/)
 * - A folder and a file have the same name
 * - Multiple files have the same basename
 * 
 * These would all become the same tag, potentially creating circular parent relationships.
 */
export function detectNamingConflicts(plugin: TaggableTagsPlugin): ConflictDetectionResult {
	const nameMap = new Map<string, { folders: TFolder[]; files: TFile[]; existingTag: TFile | null }>();
	
	// Collect all folder names
	collectFolderNames(plugin, nameMap);
	
	// Collect all file names (excluding tag files)
	collectFileNames(plugin, nameMap);
	
	// Find conflicts (groups with 2+ items)
	const conflicts: NamingConflict[] = [];
	for (const [name, group] of nameMap) {
		const totalItems = group.folders.length + group.files.length;
		// A conflict exists if there are 2+ folders, or any folder + file with same name
		// (files alone don't conflict with each other for tag purposes since only folders create tags)
		if (group.folders.length >= 2 || (group.folders.length >= 1 && group.files.length >= 1)) {
			conflicts.push({
				name,
				folders: group.folders,
				files: group.files,
				existingTag: group.existingTag,
			});
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
 * Collect all folder names into the name map.
 */
function collectFolderNames(
	plugin: TaggableTagsPlugin,
	nameMap: Map<string, { folders: TFolder[]; files: TFile[]; existingTag: TFile | null }>
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
		
		// Normalize the folder name
		const normalizedName = plugin.tagIndex.normalizeTag(folder.name);
		
		if (!nameMap.has(normalizedName)) {
			nameMap.set(normalizedName, { folders: [], files: [], existingTag: null });
		}
		nameMap.get(normalizedName)!.folders.push(folder);
		
		// Check if there's an existing tag file for this name
		const existingTag = plugin.tagIndex.getTagFile(normalizedName);
		if (existingTag) {
			nameMap.get(normalizedName)!.existingTag = existingTag;
		}
		
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
 * Collect all file names into the name map.
 */
function collectFileNames(
	plugin: TaggableTagsPlugin,
	nameMap: Map<string, { folders: TFolder[]; files: TFile[]; existingTag: TFile | null }>
): void {
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		// Skip tag files - they're already accounted for
		if (plugin.tagIndex.isTagFile(file)) continue;
		
		// Skip the tag registry note
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		
		// Normalize the file basename
		const normalizedName = plugin.tagIndex.normalizeTag(file.basename);
		
		if (!nameMap.has(normalizedName)) {
			nameMap.set(normalizedName, { folders: [], files: [], existingTag: null });
		}
		nameMap.get(normalizedName)!.files.push(file);
	}
}

/**
 * Generate resolution proposals for a conflict.
 * 
 * Strategy:
 * 1. If there's an existing tag file, its associated folder (if any) keeps the name
 * 2. Otherwise, the shallowest folder keeps the name
 * 3. Other items get renamed with context from their path
 */
function generateResolutions(
	plugin: TaggableTagsPlugin,
	conflict: NamingConflict
): ConflictResolution[] {
	const resolutions: ConflictResolution[] = [];
	
	// Sort folders by depth (shallowest first)
	const sortedFolders = [...conflict.folders].sort((a, b) => {
		const depthA = a.path.split('/').length;
		const depthB = b.path.split('/').length;
		return depthA - depthB;
	});
	
	// Determine which folder keeps its name
	let keeperFolder: TFolder | null = null;
	
	if (conflict.existingTag) {
		// Find the folder that matches the existing tag file's location
		const tagFolder = conflict.existingTag.parent;
		if (tagFolder) {
			keeperFolder = sortedFolders.find(f => f.path === tagFolder.path) || null;
		}
	}
	
	// If no existing tag or tag's folder not in conflict, use shallowest folder
	if (!keeperFolder && sortedFolders.length > 0) {
		keeperFolder = sortedFolders[0];
	}
	
	// Generate resolutions for folders
	for (const folder of sortedFolders) {
		if (folder === keeperFolder) {
			resolutions.push({
				original: folder,
				newName: folder.name,
				keepsOriginalName: true,
			});
		} else {
			resolutions.push({
				original: folder,
				newName: generateUniqueName(plugin, folder, conflict.name),
				keepsOriginalName: false,
			});
		}
	}
	
	// Generate resolutions for files (they get renamed if there are conflicting folders)
	// Files only need renaming if there's a folder with the same name
	if (sortedFolders.length > 0) {
		for (const file of conflict.files) {
			resolutions.push({
				original: file,
				newName: generateUniqueName(plugin, file, conflict.name),
				keepsOriginalName: false,
			});
		}
	}
	
	return resolutions;
}

/**
 * Generate a unique name for a folder or file by incorporating path context.
 */
function generateUniqueName(
	plugin: TaggableTagsPlugin,
	item: TFolder | TFile,
	originalName: string
): string {
	// Get parent folder name for context
	const parent = item.parent;
	if (parent && !parent.isRoot()) {
		// Use parent folder name as suffix
		const parentName = plugin.tagIndex.normalizeTag(parent.name);
		return `${originalName}-${parentName}`;
	}
	
	// If at root or no good context, use a numeric suffix
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
			
			const item = resolution.original;
			const newName = resolution.newName;
			
			if (item instanceof TFolder) {
				// Rename folder
				const parentPath = item.parent?.path || '';
				const newPath = parentPath ? `${parentPath}/${newName}` : newName;
				
				// Check if target path already exists
				const existing = plugin.app.vault.getAbstractFileByPath(newPath);
				if (existing) {
					console.warn(`Cannot rename folder ${item.path} to ${newPath}: target already exists`);
					continue;
				}
				
				try {
					await plugin.app.vault.rename(item, newPath);
					renamedCount++;
				} catch (error) {
					console.error(`Failed to rename folder ${item.path}:`, error);
				}
			} else if (item instanceof TFile) {
				// Rename file
				const parentPath = item.parent?.path || '';
				const newPath = parentPath 
					? `${parentPath}/${newName}.${item.extension}`
					: `${newName}.${item.extension}`;
				
				// Check if target path already exists
				const existing = plugin.app.vault.getAbstractFileByPath(newPath);
				if (existing) {
					console.warn(`Cannot rename file ${item.path} to ${newPath}: target already exists`);
					continue;
				}
				
				try {
					await plugin.app.fileManager.renameFile(item, newPath);
					renamedCount++;
				} catch (error) {
					console.error(`Failed to rename file ${item.path}:`, error);
				}
			}
		}
	}
	
	return renamedCount;
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
