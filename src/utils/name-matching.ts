import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { namesMatch as namesMatchCore, toComparisonKey } from './tag-naming';

export { toComparisonKey };

/**
 * Check if two names match when normalized for comparison
 * (case-insensitive; spaces / - / _ / configured separator equivalent).
 */
export function namesMatch(name1: string, name2: string, plugin?: TaggableTagsPlugin): boolean {
	return namesMatchCore(name1, name2, plugin?.settings);
}

/**
 * Normalize a name for comparison.
 */
export function normalizeForComparison(name: string, plugin?: TaggableTagsPlugin): string {
	return toComparisonKey(name, plugin?.settings);
}

/**
 * Whether a file is under a folder (including as a direct child).
 */
export function isFileUnderFolder(file: TFile, folder: TFolder): boolean {
	if (folder.isRoot()) {
		return true;
	}
	return file.path === folder.path || file.path.startsWith(folder.path + '/');
}

/**
 * Find an existing folder with a name that matches the tag name (when normalized).
 * Searches only direct children of the specified parent folder (or vault root).
 */
export function findMatchingFolder(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentFolder?: TFolder
): TFolder | null {
	const searchRoot = parentFolder || plugin.app.vault.getRoot();

	for (const child of searchRoot.children) {
		if (child instanceof TFolder) {
			if (namesMatch(child.name, tagName, plugin)) {
				return child;
			}
		}
	}
	return null;
}

export interface FindMatchingNonTagFileOptions {
	/** Only consider files under this folder */
	onlyUnder?: TFolder;
	/** Only consider direct children of onlyUnder (requires onlyUnder) */
	directChildOnly?: boolean;
}

/**
 * Find an existing file with a name that matches the tag name (when normalized),
 * but doesn't have the tag property (i.e., it's not already a tag file).
 *
 * By default searches the whole vault (legacy). Prefer scoping with options
 * so deep notes like Sociognosticism/Beliefs.md are not promoted to #Beliefs.
 */
export function findMatchingNonTagFile(
	plugin: TaggableTagsPlugin,
	tagName: string,
	opts?: FindMatchingNonTagFileOptions
): TFile | null {
	const propName = plugin.settings.tagPropertyName;
	const files = plugin.app.vault.getMarkdownFiles();

	for (const file of files) {
		if (!namesMatch(file.basename, tagName, plugin)) {
			continue;
		}

		if (opts?.onlyUnder) {
			if (opts.directChildOnly) {
				if (file.parent?.path !== opts.onlyUnder.path) {
					continue;
				}
			} else if (!isFileUnderFolder(file, opts.onlyUnder)) {
				continue;
			}
		}

		const cache = plugin.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;

		if (frontmatter && propName in frontmatter) {
			continue;
		}

		return file;
	}

	return null;
}

/**
 * Find a markdown file in a folder whose basename matches the tag name,
 * skipping files that are already tag files.
 */
export function findMatchingFileInFolder(
	plugin: TaggableTagsPlugin,
	folder: TFolder,
	tagName: string
): TFile | null {
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		if (plugin.tagIndex.isTagFile(child)) continue;
		if (namesMatch(child.basename, tagName, plugin)) {
			return child;
		}
	}
	return null;
}
