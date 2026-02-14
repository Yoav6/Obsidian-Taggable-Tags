import { TFile, TFolder, normalizePath, debounce } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { TagIndex } from './tag-index';
import { markPluginInitiatedChange, isPluginInitiatedChange } from './file-rename-sync';
import { setFirstTag, removeTag } from '../utils/tag-ordering';
import { askKeepFolderTag } from '../ui/keep-folder-tag-modal';
import { generateTagFileContent } from '../utils/tag-template';

// Folder names that should not trigger auto-creation of a tag file (e.g. Obsidian's default "untitled")
const PLACEHOLDER_FOLDER_NAMES = ['Untitled'];

// Track plugin-initiated folder/file moves to prevent loops
const pluginInitiatedMoves = new Set<string>();

// Track previous file paths for detecting moves
const previousFilePaths = new Map<string, string>();

// Debounced sync functions to prevent rapid cascading updates
let debouncedSyncFileToFolder: ((plugin: TaggableTagsPlugin, file: TFile) => void) | null = null;

/**
 * Mark a file path as being moved by the plugin.
 * This prevents the event handlers from processing it as a user-initiated move.
 */
export function markPluginInitiatedMove(path: string): void {
	pluginInitiatedMoves.add(path);
	// Clean up after a short delay in case the move fails
	setTimeout(() => {
		pluginInitiatedMoves.delete(path);
	}, 5000);
}

/**
 * Check if a move was initiated by the plugin.
 */
export function isPluginInitiatedMove(path: string): boolean {
	return pluginInitiatedMoves.has(path);
}

/**
 * Clear a plugin-initiated move marker.
 */
export function clearPluginInitiatedMove(path: string): void {
	pluginInitiatedMoves.delete(path);
}

/**
 * Sets up folder synchronization between tags and the folder structure.
 * Event handlers are always registered but check the setting before acting.
 */
export function setupFolderSync(plugin: TaggableTagsPlugin): void {
	// Initialize debounced function
	debouncedSyncFileToFolder = debounce(
		(p: TaggableTagsPlugin, f: TFile) => syncFileToFolder(p, f),
		300,
		true
	);

	// Initialize previous file paths for move detection
	initializePreviousFilePaths(plugin);

	// Set up periodic vault sync if enabled
	setupPeriodicVaultSync(plugin);

	// Handle file and folder renames (moves count as renames)
	plugin.registerEvent(
		plugin.app.vault.on('rename', async (file, oldPath) => {
			if (!plugin.settings.syncFoldersWithTags) return;

			// Folder renamed (e.g. "Untitled" → "my-tag"): create tag file if the new name is not a placeholder.
			// Defer and re-fetch so we use the folder's new path (Obsidian may not update the object before the callback).
			if (file instanceof TFolder) {
				if (isPluginInitiatedMove(oldPath) || isPluginInitiatedMove(file.path)) {
					clearPluginInitiatedMove(oldPath);
					clearPluginInitiatedMove(file.path);
					return;
				}
				const oldPathForRename = oldPath;
				setTimeout(() => {
					// Re-fetch by current path in case the vault has updated it
					const folderByPath = plugin.app.vault.getAbstractFileByPath(file.path);
					let folder = (folderByPath instanceof TFolder ? folderByPath : file) as TFolder;
					if (folder.path !== oldPathForRename) {
						handleFolderCreation(plugin, folder);
						return;
					}
					// Fallback: object may never get updated (path still old). If old path was a placeholder
					// and nothing exists there now, find the folder that was renamed (same parent, one folder without tag file).
					const oldLeaf = oldPathForRename.split('/').filter(Boolean).pop() ?? '';
					const wasPlaceholder = PLACEHOLDER_FOLDER_NAMES.some((p) => p.toLowerCase() === oldLeaf.toLowerCase());
					if (!wasPlaceholder) return;
					if (plugin.app.vault.getAbstractFileByPath(oldPathForRename) != null) return; // still exists
					const parentPath = getParentFolder(oldPathForRename);
					const parentFolder = parentPath
						? plugin.app.vault.getAbstractFileByPath(parentPath)
						: plugin.app.vault.getRoot();
					if (!(parentFolder instanceof TFolder)) return;
					const foldersWithoutTagFile = parentFolder.children.filter((c): c is TFolder => {
						if (!(c instanceof TFolder)) return false;
						const tag = plugin.tagIndex.getTagFromFolderPath(c.path);
						return tag != null && plugin.tagIndex.getTagFile(tag) == null;
					});
					if (foldersWithoutTagFile.length === 1) {
						handleFolderCreation(plugin, foldersWithoutTagFile[0]);
					}
				}, 100);
				return;
			}

			if (!(file instanceof TFile) || file.extension !== 'md') return;

			// Check if this move was initiated by the plugin
			if (isPluginInitiatedMove(oldPath) || isPluginInitiatedMove(file.path)) {
				clearPluginInitiatedMove(oldPath);
				clearPluginInitiatedMove(file.path);
				previousFilePaths.set(file.path, file.path);
				previousFilePaths.delete(oldPath);
				return;
			}

			// Check if the file actually moved folders (not just renamed)
			const oldFolder = getParentFolder(oldPath);
			const newFolder = file.parent?.path || '';

			if (oldFolder !== newFolder) {
				// File was moved to a different folder - sync folder to tags
				await syncFolderToTags(plugin, file, oldPath);
			}

			// Update tracking
			previousFilePaths.delete(oldPath);
			previousFilePaths.set(file.path, file.path);
		})
	);

	// Handle metadata cache changes (for tag changes)
	plugin.registerEvent(
		plugin.app.metadataCache.on('changed', async (file: TFile) => {
			if (!plugin.settings.syncFoldersWithTags) {
				return;
			}
			if (file.extension !== 'md') return;

			// Check if this change was initiated by the plugin (e.g., rearranging tags in a tag file)
			if (isPluginInitiatedChange(file.path)) {
				return;
			}

			// Skip tag files - they have special placement rules
			if (plugin.tagIndex.isTagFile(file)) {
				// Tag files in excluded folders stay in place (same as regular files)
				if (isInExcludedFolder(plugin, file)) {
					return;
				}
				await syncTagFileToFolder(plugin, file);
				return;
			}

			// Check if file is in an excluded folder
			if (isInExcludedFolder(plugin, file)) {
				return;
			}

			// Sync regular file to folder based on first tag
			if (debouncedSyncFileToFolder) {
				debouncedSyncFileToFolder(plugin, file);
			}
		})
	);

	// Handle folder creation - auto-create tag files
	plugin.registerEvent(
		plugin.app.vault.on('create', async (file) => {
			if (!plugin.settings.syncFoldersWithTags) return;
			
			if (file instanceof TFolder) {
				await handleFolderCreation(plugin, file);
			} else if (file instanceof TFile && file.extension === 'md') {
				// Track new files
				previousFilePaths.set(file.path, file.path);
			}
		})
	);

	// Handle file deletion - clean up tracking
	plugin.registerEvent(
		plugin.app.vault.on('delete', (file) => {
			if (file instanceof TFile) {
				previousFilePaths.delete(file.path);
			}
		})
	);
}

/**
 * Initialize the previous file paths map with current files.
 */
function initializePreviousFilePaths(plugin: TaggableTagsPlugin): void {
	const files = plugin.app.vault.getMarkdownFiles();
	for (const file of files) {
		previousFilePaths.set(file.path, file.path);
	}
}

/**
 * Get the parent folder path from a file path.
 */
function getParentFolder(filePath: string): string {
	const lastSlash = filePath.lastIndexOf('/');
	return lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
}

/**
 * Get all markdown file paths under a folder (recursively).
 */
function getAllFilePathsUnderFolder(folder: TFolder): string[] {
	const paths: string[] = [];
	function collect(f: TFolder): void {
		for (const child of f.children) {
			if (child instanceof TFile && child.extension === 'md') {
				paths.push(child.path);
			} else if (child instanceof TFolder) {
				collect(child);
			}
		}
	}
	collect(folder);
	return paths;
}

// ============================================================================
// Exclusion Logic
// ============================================================================

/**
 * Check if a file is in an excluded folder.
 */
export function isInExcludedFolder(plugin: TaggableTagsPlugin, file: TFile): boolean {
	const excludedFolders = plugin.settings.excludedFoldersFromSync;
	if (excludedFolders.length === 0) return false;

	const filePath = file.path;
	for (const excludedFolder of excludedFolders) {
		const normalizedExcluded = normalizePath(excludedFolder);
		if (filePath.startsWith(normalizedExcluded + '/') || 
			file.parent?.path === normalizedExcluded) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a folder path is excluded.
 */
export function isExcludedFolderPath(plugin: TaggableTagsPlugin, folderPath: string): boolean {
	const excludedFolders = plugin.settings.excludedFoldersFromSync;
	if (excludedFolders.length === 0) return false;

	const normalizedPath = normalizePath(folderPath);
	for (const excludedFolder of excludedFolders) {
		const normalizedExcluded = normalizePath(excludedFolder);
		if (normalizedPath === normalizedExcluded ||
			normalizedPath.startsWith(normalizedExcluded + '/')) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a tag is excluded from folder sync.
 */
export function isExcludedTag(plugin: TaggableTagsPlugin, tag: string): boolean {
	const excludedTags = plugin.settings.excludedTagsFromFolderSync;
	if (excludedTags.length === 0) return false;

	const normalizedTag = plugin.tagIndex.normalizeTag(tag);
	return excludedTags.some(t => plugin.tagIndex.normalizeTag(t) === normalizedTag);
}

/**
 * Get the effective first tag for folder placement (skipping excluded tags).
 * Exclusive tags take priority over the first tag - if a file has an exclusive tag,
 * it will be placed in that tag's folder regardless of tag order.
 * If there are multiple exclusive tags, the first one in the list is used.
 */
export function getEffectiveFirstTag(plugin: TaggableTagsPlugin, file: TFile): string | null {
	const allTags = plugin.tagIndex.getAllTagsFromFile(file);
	
	// First pass: find the first exclusive tag (they take priority)
	for (const tag of allTags) {
		if (!isExcludedTag(plugin, tag) && plugin.tagIndex.isExclusiveTag(tag)) {
			return tag;
		}
	}
	
	// Second pass: return the first non-excluded tag
	for (const tag of allTags) {
		if (!isExcludedTag(plugin, tag)) {
			return tag;
		}
	}
	
	return null; // All tags are excluded, or no tags
}

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve the folder path for a tag by traversing its parent hierarchy.
 * Handles circular references by stopping when a cycle is detected.
 * 
 * @param tagIndex The tag index
 * @param tag The tag to resolve the path for
 * @returns The folder path (e.g., "programming/python" for tag "python" with parent "programming")
 */
export function resolveTagPath(tagIndex: TagIndex, tag: string): string {
	const visited = new Set<string>();
	const pathParts: string[] = [];
	let currentTag = tagIndex.normalizeTag(tag);

	while (currentTag) {
		if (visited.has(currentTag)) {
			// Circular reference - stop here
			break;
		}
		visited.add(currentTag);
		pathParts.unshift(currentTag);

		const parents = tagIndex.getParentTags(currentTag);
		if (parents.length === 0) break;

		// Use first parent (deterministic)
		currentTag = parents[0];
	}

	return pathParts.join('/');
}

/**
 * Get the target folder path for a file based on its first effective tag.
 */
export function getTargetFolderForFile(plugin: TaggableTagsPlugin, file: TFile): string {
	const effectiveFirstTag = getEffectiveFirstTag(plugin, file);
	
	if (!effectiveFirstTag) {
		// No tags or only excluded tags - file goes to vault root
		return '';
	}

	return resolveTagPath(plugin.tagIndex, effectiveFirstTag);
}

/**
 * Get the target folder path for a tag file.
 * Reads parent tags directly from the file's metadata cache to ensure fresh data.
 * Excluded tags get no folder (vault root); no folder is created for them.
 */
export function getTargetFolderForTagFile(plugin: TaggableTagsPlugin, file: TFile): string {
	const tagName = plugin.tagIndex.fileToTagName(file);
	if (!tagName) {
		return '';
	}

	// Excluded tags do not get a folder - keep tag file at vault root
	if (isExcludedTag(plugin, tagName)) {
		return '';
	}

	// Check if tag files should go in a dedicated folder
	if (plugin.settings.tagFilesInDedicatedFolder) {
		return normalizePath(plugin.settings.tagFilesFolderPath);
	}

	// For the tag file itself, read parents directly from metadata cache (fresh data)
	// Then use tagIndex for ancestor lookups (which are less likely to be stale)
	return resolveTagPathForFile(plugin, file, tagName);
}

/**
 * Resolve the folder path for a tag file by reading its parents directly from metadata cache.
 * This ensures we use fresh data for the file being synced, while using cached data for ancestors.
 */
function resolveTagPathForFile(plugin: TaggableTagsPlugin, file: TFile, tagName: string): string {
	const visited = new Set<string>();
	const pathParts: string[] = [];
	let currentTag = plugin.tagIndex.normalizeTag(tagName);
	let isFirstIteration = true;

	while (currentTag) {
		if (visited.has(currentTag)) {
			// Circular reference - stop here
			break;
		}
		visited.add(currentTag);
		pathParts.unshift(currentTag);

		let parents: string[];
		
		if (isFirstIteration) {
			// For the first tag (the file being synced), read directly from metadata cache
			const cache = plugin.app.metadataCache.getFileCache(file);
			const fmTags = cache?.frontmatter?.tags;
			if (Array.isArray(fmTags)) {
				parents = fmTags
					.filter((t): t is string => typeof t === 'string' && !t.includes('/'))
					.map(t => plugin.tagIndex.normalizeTag(t));
			} else {
				parents = [];
			}
			isFirstIteration = false;
		} else {
			// For ancestors, use the tag index (acceptable to be slightly stale)
			parents = plugin.tagIndex.getParentTags(currentTag);
		}

		if (parents.length === 0) break;

		// Use first parent (deterministic)
		currentTag = parents[0];
	}

	return pathParts.join('/');
}

// ============================================================================
// Tag → Folder Sync
// ============================================================================

/**
 * Sync a regular file to the correct folder based on its first tag.
 */
export async function syncFileToFolder(plugin: TaggableTagsPlugin, file: TFile): Promise<void> {
	// Skip tag files
	if (plugin.tagIndex.isTagFile(file)) {
		return;
	}

	// Skip the tag registry note
	if (plugin.tagIndex.isTagRegistryNote(file)) {
		return;
	}

	// Skip files in excluded folders
	if (isInExcludedFolder(plugin, file)) {
		return;
	}

	const targetFolder = getTargetFolderForFile(plugin, file);
	const currentFolder = file.parent?.path || '';

	// Normalize paths for comparison (handle empty string for root)
	const normalizedCurrent = currentFolder ? normalizePath(currentFolder) : '';
	const normalizedTarget = targetFolder ? normalizePath(targetFolder) : '';

	// Check if file is already in the correct folder
	if (normalizedCurrent === normalizedTarget) {
		return;
	}

	// Move file to target folder
	await moveFileToFolder(plugin, file, targetFolder);
}

/**
 * Sync a tag file to the correct folder.
 * For tag files, we move the entire containing folder (the tag's folder) rather than just the file.
 */
export async function syncTagFileToFolder(plugin: TaggableTagsPlugin, file: TFile): Promise<void> {
	if (!plugin.tagIndex.isTagFile(file)) {
		return;
	}

	const targetFolder = getTargetFolderForTagFile(plugin, file);
	const currentFolder = file.parent?.path || '';

	// Normalize paths for comparison (handle empty string for root)
	const normalizedCurrent = currentFolder ? normalizePath(currentFolder) : '';
	const normalizedTarget = targetFolder ? normalizePath(targetFolder) : '';

	// Check if file is already in the correct folder
	if (normalizedCurrent === normalizedTarget) {
		return;
	}

	// For tag files, move the entire containing folder if the tag file is in its own folder
	// (i.e., folder name matches tag name)
	const tagName = plugin.tagIndex.fileToTagName(file);
	const folderName = file.parent?.name;
	
	if (tagName && folderName && file.parent && 
		plugin.tagIndex.normalizeTag(folderName) === plugin.tagIndex.normalizeTag(tagName)) {
		// Tag file is in its own folder - move the entire folder
		await moveTagFolder(plugin, file.parent, targetFolder);
	} else {
		// Tag file is not in its own folder - just move the file
		await moveFileToFolder(plugin, file, targetFolder);
	}
}

/**
 * Move a tag's folder to a new parent location.
 */
async function moveTagFolder(plugin: TaggableTagsPlugin, folder: TFolder, targetParentFolder: string): Promise<void> {
	// Calculate the new folder path
	// targetParentFolder already includes the tag name at the end, so we need the parent of that
	const targetParts = targetParentFolder.split('/');
	const tagFolderName = targetParts.pop() || folder.name; // The tag folder name
	const newParentPath = targetParts.join('/');
	
	const newFolderPath = newParentPath 
		? normalizePath(`${newParentPath}/${tagFolderName}`)
		: tagFolderName;

	// Check if already in correct location
	if (folder.path === newFolderPath) {
		return;
	}

	// Ensure parent folder exists
	if (newParentPath) {
		await ensureFolderExists(plugin, newParentPath);
	}

	// Check if a folder already exists at the target path
	const existingFolder = plugin.app.vault.getAbstractFileByPath(newFolderPath);
	if (existingFolder && existingFolder !== folder) {
		return;
	}

	const oldPath = folder.path;
	const filePathsUnderFolder = getAllFilePathsUnderFolder(folder);

	// Mark folder and all file paths under it as plugin-initiated so rename events
	// for files inside don't trigger syncFolderToTags (we already moved based on tags).
	markPluginInitiatedMove(oldPath);
	markPluginInitiatedMove(newFolderPath);
	for (const path of filePathsUnderFolder) {
		markPluginInitiatedMove(path);
		markPluginInitiatedMove(path.replace(oldPath, newFolderPath));
	}

	try {
		await plugin.app.vault.rename(folder, newFolderPath);
	} catch (error) {
		clearPluginInitiatedMove(oldPath);
		clearPluginInitiatedMove(newFolderPath);
		for (const path of filePathsUnderFolder) {
			clearPluginInitiatedMove(path);
			clearPluginInitiatedMove(path.replace(oldPath, newFolderPath));
		}
	}
}

/**
 * Move a file to a target folder, creating the folder if needed.
 */
async function moveFileToFolder(plugin: TaggableTagsPlugin, file: TFile, targetFolder: string): Promise<void> {
	// Ensure target folder exists
	await ensureFolderExists(plugin, targetFolder);

	// Calculate new path
	const newPath = targetFolder 
		? normalizePath(`${targetFolder}/${file.name}`)
		: file.name;

	// Check if a file already exists at the target path
	const existingFile = plugin.app.vault.getAbstractFileByPath(newPath);
	if (existingFile && existingFile !== file) {
		return;
	}

	const oldPath = file.path;

	// Mark as plugin-initiated to prevent loops
	markPluginInitiatedMove(oldPath);
	markPluginInitiatedMove(newPath);
	markPluginInitiatedChange(oldPath);

	try {
		await plugin.app.fileManager.renameFile(file, newPath);
	} catch (error) {
		clearPluginInitiatedMove(file.path);
		clearPluginInitiatedMove(newPath);
	}
}

/**
 * Ensure a folder exists, creating it and any parent folders if needed.
 */
export async function ensureFolderExists(plugin: TaggableTagsPlugin, folderPath: string): Promise<void> {
	if (!folderPath) return;

	const normalizedPath = normalizePath(folderPath);
	const existingFolder = plugin.app.vault.getAbstractFileByPath(normalizedPath);
	
	if (existingFolder instanceof TFolder) {
		return;
	}

	// Create folder and any missing parents
	try {
		await plugin.app.vault.createFolder(normalizedPath);
	} catch (error) {
		// Folder might already exist or parent needs to be created
		// Try creating parent folders first
		const parts = normalizedPath.split('/');
		let currentPath = '';
		
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = plugin.app.vault.getAbstractFileByPath(currentPath);
			
			if (!existing) {
				try {
					await plugin.app.vault.createFolder(currentPath);
				} catch {
					// Ignore - folder might have been created by another process
				}
			}
		}
	}
}

// ============================================================================
// Folder → Tag Sync
// ============================================================================

/**
 * Determine whether to keep the original folder tag based on settings.
 * Returns true if the tag should be kept, false if it should be removed.
 */
async function shouldKeepOriginalTag(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagName: string
): Promise<boolean> {
	const behavior = plugin.settings.keepOriginalFolderTag;
	
	if (behavior === 'always') {
		return true;
	} else if (behavior === 'never') {
		return false;
	} else {
		// 'ask' - show modal
		return await askKeepFolderTag(plugin, file, tagName);
	}
}

/**
 * Sync tags when a file is moved to a different folder.
 */
export async function syncFolderToTags(
	plugin: TaggableTagsPlugin, 
	file: TFile, 
	oldPath: string
): Promise<void> {
	// Handle tag files separately - they need parent tag updates
	if (plugin.tagIndex.isTagFile(file)) {
		await syncTagFileFolderToTags(plugin, file, oldPath);
		return;
	}

	const oldFolder = getParentFolder(oldPath);
	const newFolder = file.parent?.path || '';

	const wasInExcludedFolder = isExcludedFolderPath(plugin, oldFolder);
	const isNowInExcludedFolder = isInExcludedFolder(plugin, file);

	// Get the tags corresponding to old and new folders
	const oldFolderTag = plugin.tagIndex.getTagFromFolderPath(oldFolder);
	const newFolderTag = plugin.tagIndex.getTagFromFolderPath(newFolder);

	// Handle different scenarios based on exclusion status
	if (wasInExcludedFolder && !isNowInExcludedFolder) {
		// Moving OUT of excluded folder - add new folder's tag as first
		if (newFolderTag && !isExcludedTag(plugin, newFolderTag)) {
			await setFirstTag(plugin, file, newFolderTag);
		}
	} else if (!wasInExcludedFolder && isNowInExcludedFolder) {
		// Moving INTO excluded folder - check if we should remove old folder's tag
		if (oldFolderTag) {
			const keepTag = await shouldKeepOriginalTag(plugin, file, oldFolderTag);
			if (!keepTag) {
				await removeTag(plugin, file, oldFolderTag);
			}
		}
	} else if (!wasInExcludedFolder && !isNowInExcludedFolder) {
		// Normal move between non-excluded folders
		if (oldFolderTag) {
			const keepTag = await shouldKeepOriginalTag(plugin, file, oldFolderTag);
			if (!keepTag) {
				// Remove the old folder's tag
				await removeTag(plugin, file, oldFolderTag);
			}
		}
		
		if (newFolderTag && !isExcludedTag(plugin, newFolderTag)) {
			// Add the new folder's tag as first
			await setFirstTag(plugin, file, newFolderTag);
		}
	}
	// If both were/are in excluded folders, do nothing
}

/**
 * Sync a tag file's parent tag when its folder is moved.
 * When a tag folder (e.g., programming/python/) is moved to a new location (e.g., languages/python/),
 * the tag file inside (python.md) needs its parent tag updated from "programming" to "languages".
 */
async function syncTagFileFolderToTags(
	plugin: TaggableTagsPlugin,
	file: TFile,
	oldPath: string
): Promise<void> {
	const oldFolder = getParentFolder(oldPath);
	const newFolder = file.parent?.path || '';

	// Get the parent folder of the tag folder (grandparent of the file)
	// e.g., for "languages/python/python.md", we want "languages"
	const oldGrandparentFolder = getParentFolder(oldFolder);
	const newGrandparentFolder = getParentFolder(newFolder);

	// If the grandparent folder didn't change, no parent tag update needed
	if (oldGrandparentFolder === newGrandparentFolder) {
		return;
	}

	// Get the old and new parent tags based on grandparent folders
	const oldParentTag = plugin.tagIndex.getTagFromFolderPath(oldGrandparentFolder);
	const newParentTag = plugin.tagIndex.getTagFromFolderPath(newGrandparentFolder);

	// Skip if moving to/from excluded folders
	const wasInExcludedFolder = oldGrandparentFolder && isExcludedFolderPath(plugin, oldGrandparentFolder);
	const isNowInExcludedFolder = newGrandparentFolder && isExcludedFolderPath(plugin, newGrandparentFolder);

	if (wasInExcludedFolder || isNowInExcludedFolder) {
		return;
	}

	// Remove old parent tag if it exists (check keepOriginalFolderTag setting)
	if (oldParentTag) {
		const keepTag = await shouldKeepOriginalTag(plugin, file, oldParentTag);
		if (!keepTag) {
			await removeTag(plugin, file, oldParentTag);
		}
	}

	// Add new parent tag if the new location has a parent folder (and it's not excluded)
	// (if newGrandparentFolder is empty, the tag is now a root tag with no parent)
	if (newParentTag && !isExcludedTag(plugin, newParentTag)) {
		await setFirstTag(plugin, file, newParentTag);
	}
}

// ============================================================================
// Manual Folder Creation
// ============================================================================

/**
 * Handle manual folder creation by auto-creating a corresponding tag file.
 */
async function handleFolderCreation(plugin: TaggableTagsPlugin, folder: TFolder): Promise<void> {
	// Check if folder is excluded
	if (isExcludedFolderPath(plugin, folder.path)) {
		return;
	}

	// Skip placeholder/default names (e.g. Obsidian's "untitled" for new folders)
	const folderName = folder.name.toLowerCase();
	if (PLACEHOLDER_FOLDER_NAMES.some((p) => p.toLowerCase() === folderName)) {
		return;
	}

	// Get the tag name from the folder
	const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
	if (!tagName) {
		return;
	}

	// Check if tag already exists
	const existingTagFile = plugin.tagIndex.getTagFile(tagName);
	if (existingTagFile) {
		return;
	}

	// Create tag file for this folder
	await createTagFileForFolder(plugin, folder);
}

/**
 * Create a tag file for a folder.
 * Sets up parent relationship based on folder hierarchy.
 */
async function createTagFileForFolder(plugin: TaggableTagsPlugin, folder: TFolder): Promise<void> {
	const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
	if (!tagName) return;

	// Determine where to create the tag file
	let tagFilePath: string;
	if (plugin.settings.tagFilesInDedicatedFolder) {
		const dedicatedFolder = plugin.settings.tagFilesFolderPath;
		await ensureFolderExists(plugin, dedicatedFolder);
		tagFilePath = normalizePath(`${dedicatedFolder}/${tagName}.md`);
	} else {
		tagFilePath = normalizePath(`${folder.path}/${tagName}.md`);
	}

	// Check if file already exists
	const existingFile = plugin.app.vault.getAbstractFileByPath(tagFilePath);
	if (existingFile) {
		return;
	}

	// Determine parent tag from folder hierarchy
	const parentFolder = folder.parent;
	const parentTag = parentFolder ? plugin.tagIndex.getTagFromFolderPath(parentFolder.path) : null;

	// Create the tag file content using the template utility
	const content = await generateTagFileContent(plugin, tagName, parentTag);

	// Mark as plugin-initiated
	markPluginInitiatedChange(tagFilePath);

	try {
		await plugin.app.vault.create(tagFilePath, content);
	} catch (error) {
		// Ignore errors - file might already exist
	}
}

// ============================================================================
// Vault-wide Sync
// ============================================================================

/**
 * Set up periodic vault sync if the setting is enabled.
 * Checks every 5 seconds and syncs files that are out of place.
 */
function setupPeriodicVaultSync(plugin: TaggableTagsPlugin): void {
	// Register an interval that checks and syncs the vault periodically
	plugin.registerInterval(
		window.setInterval(() => {
			if (plugin.settings.syncFoldersWithTags && plugin.settings.autoSyncEntireVault) {
				syncEntireVault(plugin);
			}
		}, 5000) // Check every 5 seconds
	);
}

/**
 * Sync all files in the vault to their correct folders based on tags.
 * This function is idempotent - it only moves files that are out of place.
 */
export async function syncEntireVault(plugin: TaggableTagsPlugin): Promise<void> {
	if (!plugin.settings.syncFoldersWithTags) {
		return;
	}

	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		// Skip files in excluded folders
		if (isInExcludedFolder(plugin, file)) {
			continue;
		}

		// Skip the tag registry note
		if (plugin.tagIndex.isTagRegistryNote(file)) {
			continue;
		}

		// Handle tag files with same logic as syncTagFileToFolder (move folder when in own folder)
		if (plugin.tagIndex.isTagFile(file)) {
			const targetFolder = getTargetFolderForTagFile(plugin, file);
			const currentFolder = file.parent?.path || '';
			
			const normalizedCurrent = currentFolder ? normalizePath(currentFolder) : '';
			const normalizedTarget = targetFolder ? normalizePath(targetFolder) : '';
			
			if (normalizedCurrent !== normalizedTarget) {
				const tagName = plugin.tagIndex.fileToTagName(file);
				const folderName = file.parent?.name;
				if (tagName && folderName && file.parent &&
					plugin.tagIndex.normalizeTag(folderName) === plugin.tagIndex.normalizeTag(tagName)) {
					await moveTagFolder(plugin, file.parent, targetFolder);
				} else {
					await moveFileToFolder(plugin, file, targetFolder);
				}
				await sleep(50);
			}
		} else {
			// Regular file
			const targetFolder = getTargetFolderForFile(plugin, file);
			const currentFolder = file.parent?.path || '';
			
			const normalizedCurrent = currentFolder ? normalizePath(currentFolder) : '';
			const normalizedTarget = targetFolder ? normalizePath(targetFolder) : '';
			
			if (normalizedCurrent !== normalizedTarget) {
				await moveFileToFolder(plugin, file, targetFolder);
				// Small delay to avoid overwhelming the system
				await sleep(50);
			}
		}
	}
}

/**
 * Helper function to sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
