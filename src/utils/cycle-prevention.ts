import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import {
	findMatchingFileInFolder,
	isFileUnderFolder,
	namesMatch,
	toComparisonKey,
} from './name-matching';
import { joinTagNameSegments } from './tag-naming';
import { markPluginInitiatedChange } from '../sync/file-rename-sync';

export interface DisambiguateResult {
	/** Folder after possible rename (same reference if Obsidian updated it in place) */
	folder: TFolder;
	/** Tag name derived from the (possibly renamed) folder */
	tagName: string;
	/** Whether the folder was renamed */
	renamed: boolean;
	/** True if a rename was needed but could not be completed */
	failed: boolean;
	/**
	 * Extra parent tags for the new tag note when we left the original leaf
	 * to a collision (e.g. ["Quotes"] when renaming nested Quotes → Quotes_Sociognosticism).
	 */
	collisionParents: string[];
}

/**
 * A note whose basename matches an ancestor folder's tag name but is not
 * a direct child of that folder (e.g. Beliefs/Ideologies/Sociognosticism/Beliefs.md).
 */
export interface MisplacedMatchingNote {
	file: TFile;
	matchedFolder: TFolder;
	tagName: string;
}

/**
 * Find notes whose basename matches a folder's tag name but that are not
 * direct children of that folder — they live deeper under it.
 * Promoting such notes to the folder's tag creates cycles (e.g. Sociognosticism/Beliefs.md → #Beliefs).
 */
export function findMisplacedMatchingNotes(
	plugin: TaggableTagsPlugin
): MisplacedMatchingNote[] {
	const results: MisplacedMatchingNote[] = [];
	const seenFilePaths = new Set<string>();
	const root = plugin.app.vault.getRoot();

	function collectFolders(folder: TFolder): TFolder[] {
		const folders: TFolder[] = [];
		if (!folder.isRoot()) {
			folders.push(folder);
		}
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				folders.push(...collectFolders(child));
			}
		}
		return folders;
	}

	const allFolders = collectFolders(root);
	const files = plugin.app.vault.getMarkdownFiles();

	for (const folder of allFolders) {
		const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
		if (!tagName) continue;

		for (const file of files) {
			if (seenFilePaths.has(file.path)) continue;
			if (!namesMatch(file.basename, tagName, plugin)) continue;
			// Must be under the folder but not a direct child
			if (!isFileUnderFolder(file, folder)) continue;
			if (file.parent?.path === folder.path) continue;

			// Skip if this file is already the tag file for a *different* tag
			const fileTag = plugin.tagIndex.getTagForFilePath(file.path)
				?? (plugin.tagIndex.isTagFile(file) ? plugin.tagIndex.fileToTagName(file) : null);
			if (fileTag && !plugin.tagIndex.tagsMatch(fileTag, tagName)) {
				continue;
			}

			seenFilePaths.add(file.path);
			results.push({ file, matchedFolder: folder, tagName });
		}
	}

	return results;
}

/**
 * Check whether walking up the folder tree finds an ancestor whose
 * derived tag name matches `tagName`.
 */
export function isTagAncestorOfFolder(
	plugin: TaggableTagsPlugin,
	tagName: string,
	folder: TFolder
): boolean {
	let current = folder.parent;
	while (current && !current.isRoot()) {
		const ancestorTag = plugin.tagIndex.getTagFromFolderPath(current.path);
		if (ancestorTag && plugin.tagIndex.tagsMatch(ancestorTag, tagName)) {
			return true;
		}
		current = current.parent;
	}
	return false;
}

/**
 * Check whether setting `parentTag` as a parent of `tagName` would create a cycle
 * in the tag index (i.e. `tagName` is already an ancestor of `parentTag`, or they match).
 */
export function wouldParentCreateCycle(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string | null | undefined
): boolean {
	if (!parentTag) return false;
	if (plugin.tagIndex.tagsMatch(tagName, parentTag)) return true;

	const visited = new Set<string>();
	const queue: string[] = [parentTag];

	while (queue.length > 0) {
		const current = queue.pop()!;
		const key = toComparisonKey(current, plugin.settings);
		if (visited.has(key)) continue;
		visited.add(key);

		if (plugin.tagIndex.tagsMatch(current, tagName)) {
			return true;
		}

		for (const parent of plugin.tagIndex.getParentTags(current)) {
			queue.push(parent);
		}
	}

	return false;
}

/**
 * Normalize, dedupe, and drop parents that would self-match or create a cycle.
 */
export function filterSafeParentTags(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parents: string[]
): string[] {
	const result: string[] = [];
	for (const candidate of parents) {
		const normalized = plugin.tagIndex.normalizeTag(candidate);
		if (!normalized) continue;
		if (result.some(r => plugin.tagIndex.tagsMatch(r, normalized))) continue;
		if (wouldParentCreateCycle(plugin, tagName, normalized)) continue;
		result.push(normalized);
	}
	return result;
}

/**
 * Collect parent tags for a tag note: folder parent plus collision parents,
 * deduped and skipping any that would create a cycle.
 *
 * Dual-parent direction: `collisionParents` are for **compounds → shared leaf**
 * (e.g. Courts_Law parents include Courts). Never pass a compound as a collision
 * parent onto the shared leaf — the reverse edge creates a cycle and is rejected
 * by wouldParentCreateCycle once the compound already parents to the leaf.
 */
export function collectSafeParentTags(
	plugin: TaggableTagsPlugin,
	tagName: string,
	folderParent: string | null | undefined,
	collisionParents: string[] = []
): string[] {
	const candidates = [
		...(folderParent ? [folderParent] : []),
		...collisionParents,
	];
	return filterSafeParentTags(plugin, tagName, candidates);
}

function folderDepth(folder: TFolder): number {
	return folder.path.split('/').filter(Boolean).length;
}

/**
 * All vault folders whose leaf tag name matches `tagName`.
 */
export function findFoldersWithLeafTag(
	plugin: TaggableTagsPlugin,
	tagName: string
): TFolder[] {
	const result: TFolder[] = [];
	const root = plugin.app.vault.getRoot();

	function walk(folder: TFolder): void {
		if (!folder.isRoot()) {
			const leaf = plugin.tagIndex.getTagFromFolderPath(folder.path);
			if (leaf && plugin.tagIndex.tagsMatch(leaf, tagName)) {
				result.push(folder);
			}
		}
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				walk(child);
			}
		}
	}

	walk(root);
	return result;
}

/**
 * Whether this folder should keep the shared leaf tag name.
 * The folder holding the tag note wins; otherwise shallowest folder, ties by path.
 */
export function isLeafTagKeeper(
	plugin: TaggableTagsPlugin,
	folder: TFolder
): boolean {
	const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
	if (!tagName) return true;

	// An existing tag note settles ownership. Renaming its folder re-points the note
	// to the new name, orphaning the original tag that notes still reference — and
	// leaf folders, being deepest, would otherwise always lose the depth tiebreak.
	const tagFile = plugin.tagIndex.getTagFile(tagName);
	if (tagFile) {
		return tagFile.parent?.path === folder.path;
	}

	const claimants: TFolder[] = findFoldersWithLeafTag(plugin, tagName);
	if (claimants.length <= 1) {
		return claimants.length === 0 || claimants[0].path === folder.path;
	}

	claimants.sort((a, b) => {
		const depthDiff = folderDepth(a) - folderDepth(b);
		if (depthDiff !== 0) return depthDiff;
		return a.path.localeCompare(b.path);
	});

	return claimants[0].path === folder.path;
}

/**
 * Whether creating/using this folder's tag would collide with an ancestor,
 * a cousin folder / foreign tag file, or create a cycle.
 */
export function folderNeedsDisambiguation(
	plugin: TaggableTagsPlugin,
	folder: TFolder
): boolean {
	const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
	if (!tagName) return false;

	if (isTagAncestorOfFolder(plugin, tagName, folder)) {
		return true;
	}

	if (!isLeafTagKeeper(plugin, folder)) {
		return true;
	}

	const parentFolder = folder.parent;
	const parentTag =
		parentFolder && !parentFolder.isRoot()
			? plugin.tagIndex.getTagFromFolderPath(parentFolder.path)
			: null;

	const existingTagFile = plugin.tagIndex.getTagFile(tagName);
	if (existingTagFile && wouldParentCreateCycle(plugin, tagName, parentTag)) {
		return true;
	}

	return false;
}

/**
 * Generate a unique tag name for a folder by incorporating the parent folder name,
 * then numeric suffixes if still taken. Uses settings-aware segment joining.
 */
export function uniqueNameForFolder(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	baseName: string
): string {
	const settings = plugin.settings;
	const parent = folder.parent;
	let candidate: string;

	if (parent && !parent.isRoot()) {
		candidate = joinTagNameSegments([baseName, parent.name], settings);
	} else {
		candidate = joinTagNameSegments([baseName, '2'], settings);
	}

	if (!isNameTaken(plugin, folder, candidate)) {
		return candidate;
	}

	for (let i = 2; i <= 100; i++) {
		const withSuffix = joinTagNameSegments([candidate, String(i)], settings);
		if (!isNameTaken(plugin, folder, withSuffix)) {
			return withSuffix;
		}
	}

	return joinTagNameSegments([candidate, String(Date.now())], settings);
}

/**
 * Generate a unique name for a conflict source (folder, existing tag, or nested tag).
 * Used by conflict resolution; folder case delegates to uniqueNameForFolder.
 */
export function uniqueNameForSource(
	plugin: TaggableTagsPlugin,
	source: {
		type: string;
		folder?: TFolder;
		existingTagFile?: TFile;
		nestedTagPath?: string;
		matchingNote?: TFile;
	},
	originalName: string
): string {
	const settings = plugin.settings;

	if (source.type === 'folder' && source.folder) {
		return uniqueNameForFolder(plugin, source.folder, originalName);
	}

	if (
		(source.type === 'existing-tag' && source.existingTagFile) ||
		(source.type === 'matching-note' && source.matchingNote)
	) {
		const file = source.existingTagFile ?? source.matchingNote!;
		const parent = file.parent;
		if (parent && !parent.isRoot()) {
			const candidate = joinTagNameSegments([originalName, parent.name], settings);
			if (!plugin.tagIndex.getTagFile(candidate) && !fileNameTaken(plugin, file, candidate)) {
				return candidate;
			}
			for (let i = 2; i <= 100; i++) {
				const withSuffix = joinTagNameSegments([candidate, String(i)], settings);
				if (!plugin.tagIndex.getTagFile(withSuffix) && !fileNameTaken(plugin, file, withSuffix)) {
					return withSuffix;
				}
			}
			return joinTagNameSegments([candidate, String(Date.now())], settings);
		}
	}

	if (source.type === 'nested-tag' && source.nestedTagPath) {
		const parts = source.nestedTagPath.split('/');
		if (parts.length >= 2) {
			const parentLevel = parts[parts.length - 2];
			return joinTagNameSegments([originalName, parentLevel], settings);
		}
	}

	return joinTagNameSegments([originalName, '2'], settings);
}

function fileNameTaken(
	plugin: TaggableTagsPlugin,
	file: TFile,
	candidate: string
): boolean {
	const parentPath = file.parent?.path || '';
	const displayName = plugin.tagIndex.toDisplayName(candidate);
	const targetPath = parentPath
		? `${parentPath}/${displayName}.${file.extension}`
		: `${displayName}.${file.extension}`;
	const existing = plugin.app.vault.getAbstractFileByPath(targetPath);
	return !!(existing && existing !== file);
}

/**
 * If using this folder's derived tag would collide with an ancestor, cousin,
 * or create a cycle, rename the folder (and matching same-name note) to a unique name.
 */
export async function disambiguateFolderIfNeeded(
	plugin: TaggableTagsPlugin,
	folder: TFolder
): Promise<DisambiguateResult> {
	const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
	if (!tagName) {
		return { folder, tagName: '', renamed: false, failed: false, collisionParents: [] };
	}

	if (!folderNeedsDisambiguation(plugin, folder)) {
		return { folder, tagName, renamed: false, failed: false, collisionParents: [] };
	}

	const originalLeaf = plugin.tagIndex.normalizeTag(tagName);
	const uniqueCanonical = uniqueNameForFolder(plugin, folder, tagName);
	const displayName = plugin.tagIndex.toDisplayName(uniqueCanonical);

	const renamedFolder = await renameFolderWithFallback(plugin, folder, displayName);
	if (!renamedFolder) {
		return { folder, tagName, renamed: false, failed: true, collisionParents: [] };
	}

	const matchingFile =
		findMatchingFileInFolder(plugin, renamedFolder, tagName) ??
		findMatchingFileInFolder(plugin, renamedFolder, renamedFolder.name);
	if (matchingFile) {
		await renameFileInPlace(plugin, matchingFile, plugin.tagIndex.toDisplayName(
			plugin.tagIndex.getTagFromFolderPath(renamedFolder.path) || uniqueCanonical
		));
	}

	const newTagName =
		plugin.tagIndex.getTagFromFolderPath(renamedFolder.path) || uniqueCanonical;

	// Keep original leaf as an extra parent when that tag still exists (or a keeper folder will own it)
	const collisionParents: string[] = [];
	const leafStillClaimed =
		!!plugin.tagIndex.getTagFile(originalLeaf) ||
		findFoldersWithLeafTag(plugin, originalLeaf).some(f => f.path !== renamedFolder.path);
	if (leafStillClaimed && !plugin.tagIndex.tagsMatch(originalLeaf, newTagName)) {
		collisionParents.push(originalLeaf);
	}

	return {
		folder: renamedFolder,
		tagName: newTagName,
		renamed: true,
		failed: false,
		collisionParents,
	};
}

function isNameTaken(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	candidate: string
): boolean {
	if (plugin.tagIndex.getTagFile(candidate)) {
		return true;
	}

	const parentPath = folder.parent?.path || '';
	const displayName = plugin.tagIndex.toDisplayName(candidate);
	const targetPath = parentPath ? `${parentPath}/${displayName}` : displayName;
	const existing = plugin.app.vault.getAbstractFileByPath(targetPath);
	return !!(existing && existing !== folder);
}

async function renameFolderWithFallback(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	displayName: string
): Promise<TFolder | null> {
	const candidates = [displayName];
	for (let i = 2; i <= 20; i++) {
		// Path collision fallback only — displayName already respects naming settings
		candidates.push(`${displayName}_${i}`);
	}

	for (const name of candidates) {
		const parentPath = folder.parent?.path || '';
		const newPath = parentPath ? `${parentPath}/${name}` : name;
		const existing = plugin.app.vault.getAbstractFileByPath(newPath);
		if (existing && existing !== folder) continue;

		try {
			await plugin.app.vault.rename(folder, newPath);
			const renamed = plugin.app.vault.getAbstractFileByPath(newPath);
			if (renamed instanceof TFolder) {
				return renamed;
			}
			return folder;
		} catch {
			continue;
		}
	}

	return null;
}

async function renameFileInPlace(
	plugin: TaggableTagsPlugin,
	file: TFile,
	newBasename: string
): Promise<boolean> {
	const parentPath = file.parent?.path || '';
	const newPath = parentPath
		? `${parentPath}/${newBasename}.${file.extension}`
		: `${newBasename}.${file.extension}`;

	if (file.path === newPath) return true;

	const existing = plugin.app.vault.getAbstractFileByPath(newPath);
	if (existing) return false;

	try {
		// Disambiguation is a local rename; without this the file-name sync handler
		// treats it as a manual one and renames the old tag across the whole vault.
		markPluginInitiatedChange(file.path);
		await plugin.app.fileManager.renameFile(file, newPath);
		return true;
	} catch {
		return false;
	}
}
