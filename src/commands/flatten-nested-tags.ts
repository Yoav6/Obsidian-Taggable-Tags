import { TFile, TFolder, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { processFrontmatterRecord, readFrontmatterTags } from '../utils/frontmatter';
import { generateTagFileContent, addTagPropertiesToFile } from '../utils/tag-template';
import { findMatchingFolder, findMatchingFileInFolder } from '../utils/name-matching';
import {
	wouldParentCreateCycle,
	collectSafeParentTags,
	filterSafeParentTags,
	findFoldersWithLeafTag,
} from '../utils/cycle-prevention';
import { joinTagNameSegments, toComparisonKey } from '../utils/tag-naming';

/**
 * Information about a nested tag found in the vault.
 */
interface NestedTagInfo {
	/** The full nested tag (without #), normalized */
	fullTag: string;
	/** Raw spelling as found in files (first seen) */
	rawFullTag: string;
	/** All raw spellings seen for this nested tag */
	rawSpellings: Set<string>;
	/** The hierarchy levels, e.g., ["media", "music", "songs"] */
	levels: string[];
	/** The leaf (lowest level) tag, e.g., "songs" */
	leafTag: string;
	/** Files where this nested tag appears (for replacement) */
	files: Set<TFile>;
}

/**
 * Main entry point for the flatten nested tags command.
 * Finds all nested tags, creates tag files for each level, and replaces nested tags with leaf tags.
 */
export async function flattenNestedTags(plugin: TaggableTagsPlugin): Promise<void> {
	new Notice('Scanning vault for nested tags...');

	const nestedTags = findAllNestedTags(plugin);

	if (nestedTags.size === 0) {
		new Notice('No nested tags found in the vault.');
		return;
	}

	const allLevels = collectAllTagLevels(plugin, nestedTags);

	// (tagName, parentTag) → canonical name created for that path pair
	const resolvedByPair = new Map<string, string>();
	// full nested tag → resolved leaf tag name used in file replacements
	const resolvedLeaves = new Map<string, string>();

	const pairKey = (tagName: string, parentTag: string | null) =>
		toComparisonKey(tagName, plugin.settings) +
		'::' +
		(parentTag ? toComparisonKey(parentTag, plugin.settings) : '');

	let createdCount = 0;
	for (const { tagName, parentTag, grandparentTag } of allLevels) {
		const effectiveParent = resolveEffectiveParent(
			plugin,
			tagName,
			parentTag,
			grandparentTag,
			resolvedByPair,
			pairKey
		);

		const result = await createTagFileIfNeeded(plugin, tagName, effectiveParent);
		if (result.created) {
			createdCount++;
		}

		resolvedByPair.set(pairKey(tagName, parentTag), result.tagName);

		// Record resolved leaf for nested tags that end with this (tagName, parentTag) pair
		for (const [fullTag, info] of nestedTags) {
			if (!plugin.tagIndex.tagsMatch(info.leafTag, tagName)) continue;
			const leafParent =
				info.levels.length >= 2
					? plugin.tagIndex.normalizeTag(info.levels[info.levels.length - 2])
					: null;
			const parentsMatch =
				(parentTag === null && leafParent === null) ||
				(parentTag !== null &&
					leafParent !== null &&
					plugin.tagIndex.tagsMatch(parentTag, leafParent));
			if (parentsMatch) {
				resolvedLeaves.set(fullTag, result.tagName);
			}
		}
	}

	let filesUpdated = 0;
	for (const tagInfo of nestedTags.values()) {
		const replacementLeaf =
			resolvedLeaves.get(tagInfo.fullTag) ??
			(await ensureResolvedLeaf(plugin, tagInfo, resolvedByPair, pairKey)).tagName;
		const updatedFiles = await replaceNestedTagInFiles(plugin, tagInfo, replacementLeaf);
		filesUpdated += updatedFiles;
	}

	await plugin.tagIndex.rebuild();
	await plugin.updateTagRegistry();

	new Notice(
		`Flattened ${nestedTags.size} nested tag${nestedTags.size === 1 ? '' : 's'}, ` +
		`created ${createdCount} tag file${createdCount === 1 ? '' : 's'}, ` +
		`updated ${filesUpdated} file${filesUpdated === 1 ? '' : 's'}.`
	);
}

/**
 * Resolve the canonical parent for this path segment from prior pair resolutions.
 * Never falls back to a compound created for a different parent pair.
 */
function resolveEffectiveParent(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string | null,
	grandparentTag: string | null,
	resolvedByPair: Map<string, string>,
	pairKey: (tagName: string, parentTag: string | null) => string
): string | null {
	if (parentTag === null) {
		return null;
	}

	const parentPairKey = pairKey(parentTag, grandparentTag);
	const resolvedParent = resolvedByPair.get(parentPairKey);
	const effectiveParent = resolvedParent ?? parentTag;

	// Guard: effective parent must be this path's resolved parent pair, not a
	// compound belonging only to a different (parent, grandparent) pair.
	if (resolvedParent) {
		for (const [key, canonical] of resolvedByPair) {
			if (key === parentPairKey) continue;
			if (!plugin.tagIndex.tagsMatch(canonical, effectiveParent)) continue;
			// Plain shared leaf name claimed by multiple pairs is fine
			if (plugin.tagIndex.tagsMatch(canonical, parentTag)) continue;
			console.warn(
				`Flatten: cross-wired parent blocked for ${tagName}: ` +
					`${effectiveParent} belongs to ${key}, expected ${parentPairKey}`
			);
			return parentTag;
		}
	} else if (grandparentTag !== null || parentTag !== null) {
		// Parent pair should already be processed by topo order; log if missing
		console.warn(
			`Flatten: parent pair ${parentPairKey} not resolved yet for child ${tagName}; ` +
				`using raw parent ${parentTag}`
		);
	}

	return effectiveParent;
}

/**
 * Ensure a nested tag's leaf exists (with disambiguation) and return the resolved name.
 * Walks the path so each level uses the resolved parent for that chain.
 */
async function ensureResolvedLeaf(
	plugin: TaggableTagsPlugin,
	tagInfo: NestedTagInfo,
	resolvedByPair: Map<string, string>,
	pairKey: (tagName: string, parentTag: string | null) => string
): Promise<{ tagName: string; created: boolean }> {
	let lastResult: { tagName: string; created: boolean } = {
		tagName: tagInfo.leafTag,
		created: false,
	};

	for (let i = 0; i < tagInfo.levels.length; i++) {
		const tagName = tagInfo.levels[i];
		const parentTag = i > 0 ? tagInfo.levels[i - 1] : null;
		const grandparentTag = i > 1 ? tagInfo.levels[i - 2] : null;
		const mapKey = pairKey(tagName, parentTag);

		const existing = resolvedByPair.get(mapKey);
		if (existing) {
			lastResult = { tagName: existing, created: false };
			continue;
		}

		const effectiveParent = resolveEffectiveParent(
			plugin,
			tagName,
			parentTag,
			grandparentTag,
			resolvedByPair,
			pairKey
		);
		lastResult = await createTagFileIfNeeded(plugin, tagName, effectiveParent);
		resolvedByPair.set(mapKey, lastResult.tagName);
	}

	return lastResult;
}

/**
 * Finds all nested tags (tags containing '/') in the vault.
 * Returns a map of full nested tag -> NestedTagInfo.
 */
function findAllNestedTags(plugin: TaggableTagsPlugin): Map<string, NestedTagInfo> {
	const nestedTags = new Map<string, NestedTagInfo>();
	const files = plugin.app.vault.getMarkdownFiles();

	for (const file of files) {
		if (plugin.tagIndex.isTagRegistryNote(file)) {
			continue;
		}

		const cache = plugin.app.metadataCache.getFileCache(file);
		if (!cache) continue;

		for (const tag of readFrontmatterTags(cache)) {
			if (tag.includes('/')) {
				addNestedTag(plugin, nestedTags, tag, file);
			}
		}

		if (cache.tags) {
			for (const tagCache of cache.tags) {
				const tagName = tagCache.tag.startsWith('#')
					? tagCache.tag.slice(1)
					: tagCache.tag;
				if (tagName.includes('/')) {
					addNestedTag(plugin, nestedTags, tagName, file);
				}
			}
		}
	}

	return nestedTags;
}

function addNestedTag(
	plugin: TaggableTagsPlugin,
	nestedTags: Map<string, NestedTagInfo>,
	tag: string,
	file: TFile
): void {
	const withoutHash = tag.startsWith('#') ? tag.slice(1) : tag;
	const normalizedTag = withoutHash
		.split('/')
		.map(level => plugin.tagIndex.normalizeTag(level))
		.join('/');

	if (!nestedTags.has(normalizedTag)) {
		const levels = normalizedTag.split('/');
		nestedTags.set(normalizedTag, {
			fullTag: normalizedTag,
			rawFullTag: withoutHash,
			rawSpellings: new Set([withoutHash]),
			levels,
			leafTag: levels[levels.length - 1],
			files: new Set(),
		});
	} else {
		nestedTags.get(normalizedTag)!.rawSpellings.add(withoutHash);
	}

	nestedTags.get(normalizedTag)!.files.add(file);
}

interface TagLevelEntry {
	tagName: string;
	parentTag: string | null;
	/** Parent's parent from the nested path that introduced this pair (null for roots / top-level parents). */
	grandparentTag: string | null;
}

/**
 * Collects all unique (tagName, parentTag) pairs from nested tags.
 * Same leaf under different parents are kept as separate entries (for disambiguation).
 * Topo order waits on the specific parent *pair* (parentTag, grandparentTag), not merely the parent name.
 */
function collectAllTagLevels(
	plugin: TaggableTagsPlugin,
	nestedTags: Map<string, NestedTagInfo>
): TagLevelEntry[] {
	const entries: TagLevelEntry[] = [];
	const seen = new Set<string>();

	const entryKey = (tagName: string, parentTag: string | null) =>
		toComparisonKey(tagName, plugin.settings) +
		'::' +
		(parentTag ? toComparisonKey(parentTag, plugin.settings) : '');

	for (const tagInfo of nestedTags.values()) {
		const levels = tagInfo.levels;
		for (let i = 0; i < levels.length; i++) {
			const tagName = levels[i];
			const parentTag = i > 0 ? levels[i - 1] : null;
			const grandparentTag = i > 1 ? levels[i - 2] : null;
			const key = entryKey(tagName, parentTag);
			if (!seen.has(key)) {
				seen.add(key);
				entries.push({ tagName, parentTag, grandparentTag });
			}
		}
	}

	const result: TagLevelEntry[] = [];
	const processedKeys = new Set<string>();

	for (const entry of entries) {
		if (entry.parentTag === null) {
			result.push(entry);
			processedKeys.add(entryKey(entry.tagName, entry.parentTag));
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of entries) {
			const key = entryKey(entry.tagName, entry.parentTag);
			if (processedKeys.has(key)) continue;
			if (entry.parentTag === null) continue;

			// Ready only when this path's parent pair is processed — not any tag with the same name
			const parentPairKey = entryKey(entry.parentTag, entry.grandparentTag);
			if (processedKeys.has(parentPairKey)) {
				result.push(entry);
				processedKeys.add(key);
				changed = true;
			}
		}
	}

	for (const entry of entries) {
		const key = entryKey(entry.tagName, entry.parentTag);
		if (!processedKeys.has(key)) {
			result.push(entry);
			processedKeys.add(key);
		}
	}

	return result;
}

/**
 * Whether creating/parenting `tagName` under `parentTag` would wrongly merge into
 * an existing root/cousin tag (e.g. #Quotes + parent #Sociognosticism).
 */
function needsFlattenDisambiguation(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string
): boolean {
	const existing = plugin.tagIndex.getTagFile(tagName);
	if (existing) {
		return !tagFileBelongsUnderParent(plugin, existing, parentTag);
	}

	const parentFolder = folderForTag(plugin, parentTag);
	const peers = findFoldersWithLeafTag(plugin, tagName);
	for (const folder of peers) {
		if (parentFolder && isFolderUnder(folder, parentFolder)) {
			continue;
		}
		// Foreign folder with the same leaf name
		return true;
	}

	return false;
}

function folderForTag(plugin: TaggableTagsPlugin, tagName: string): TFolder | null {
	// Prefer the canonical tag file's folder so disambiguated compounds
	// (e.g. Education_Law) never steal placement meant for plain #Education.
	const tagFile = plugin.tagIndex.getTagFile(tagName);
	if (tagFile?.parent && !tagFile.parent.isRoot()) {
		return tagFile.parent;
	}

	const folders = findFoldersWithLeafTag(plugin, tagName);
	if (folders.length === 0) return null;
	folders.sort((a, b) => {
		const depthDiff =
			a.path.split('/').filter(Boolean).length - b.path.split('/').filter(Boolean).length;
		if (depthDiff !== 0) return depthDiff;
		return a.path.localeCompare(b.path);
	});
	return folders[0];
}

function isFolderUnder(folder: TFolder, ancestor: TFolder): boolean {
	return folder.path === ancestor.path || folder.path.startsWith(ancestor.path + '/');
}

function tagFileBelongsUnderParent(
	plugin: TaggableTagsPlugin,
	tagFile: TFile,
	parentTag: string
): boolean {
	const parentFolder = folderForTag(plugin, parentTag);
	if (!parentFolder || !tagFile.parent || tagFile.parent.isRoot()) {
		return false;
	}
	return isFolderUnder(tagFile.parent, parentFolder);
}

/**
 * Resolve the canonical tag name to use for this (tagName, parentTag) pair.
 */
function resolveFlattenTagName(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string | null
): { canonicalName: string; parents: string[]; disambiguated: boolean } {
	const normalized = plugin.tagIndex.normalizeTag(tagName);
	const safeParent =
		parentTag && !wouldParentCreateCycle(plugin, normalized, parentTag)
			? plugin.tagIndex.normalizeTag(parentTag)
			: null;

	if (!safeParent) {
		return { canonicalName: normalized, parents: [], disambiguated: false };
	}

	if (needsFlattenDisambiguation(plugin, normalized, safeParent)) {
		let compound = joinTagNameSegments([normalized, safeParent], plugin.settings);
		// Avoid colliding with an existing unrelated tag
		if (
			plugin.tagIndex.getTagFile(compound) &&
			!tagFileBelongsUnderParent(plugin, plugin.tagIndex.getTagFile(compound)!, safeParent)
		) {
			for (let i = 2; i <= 100; i++) {
				const candidate = joinTagNameSegments([compound, String(i)], plugin.settings);
				if (!plugin.tagIndex.getTagFile(candidate)) {
					compound = candidate;
					break;
				}
			}
		}
		const parents = collectSafeParentTags(plugin, compound, safeParent, [normalized]);
		return { canonicalName: compound, parents, disambiguated: true };
	}

	return {
		canonicalName: normalized,
		parents: collectSafeParentTags(plugin, normalized, safeParent, []),
		disambiguated: false,
	};
}

/**
 * Creates a tag file for the given tag if it doesn't already exist.
 * When the leaf would wrongly merge into a cousin/root tag, uses a settings-joined
 * compound name and dual-parents instead of attaching the parent to the shared leaf.
 */
async function createTagFileIfNeeded(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string | null
): Promise<{ created: boolean; tagName: string }> {
	const { canonicalName, parents, disambiguated } = resolveFlattenTagName(
		plugin,
		tagName,
		parentTag
	);
	const safeParents = filterSafeParentTags(plugin, canonicalName, parents);

	const existingTagFile = plugin.tagIndex.getTagFile(canonicalName);
	if (existingTagFile) {
		if (disambiguated) {
			for (const parent of safeParents) {
				await ensureParentRelationship(plugin, existingTagFile, parent);
			}
		} else if (safeParents.length > 0) {
			// Only attach parents when the tag note lives under that parent's folder
			for (const parent of safeParents) {
				if (tagFileBelongsUnderParent(plugin, existingTagFile, parent)) {
					await ensureParentRelationship(plugin, existingTagFile, parent);
				}
			}
		}
		return { created: false, tagName: canonicalName };
	}

	return createDisambiguatedTagFile(plugin, canonicalName, safeParents);
}

async function createDisambiguatedTagFile(
	plugin: TaggableTagsPlugin,
	canonicalName: string,
	parents: string[]
): Promise<{ created: boolean; tagName: string }> {
	const safeParents = filterSafeParentTags(plugin, canonicalName, parents);
	const existingTagFile = plugin.tagIndex.getTagFile(canonicalName);
	if (existingTagFile) {
		for (const parent of safeParents) {
			await ensureParentRelationship(plugin, existingTagFile, parent);
		}
		return { created: false, tagName: canonicalName };
	}

	const primaryParent = safeParents[0] ?? null;
	let parentFolder: TFolder | undefined;
	if (primaryParent) {
		const parentTagFile = plugin.tagIndex.getTagFile(primaryParent);
		if (parentTagFile?.parent && !parentTagFile.parent.isRoot()) {
			parentFolder = parentTagFile.parent;
		}
	}

	const searchRoot = parentFolder || plugin.app.vault.getRoot();
	const existingFolder = findMatchingFolder(plugin, canonicalName, searchRoot);
	const matchingFile = existingFolder
		? findMatchingFileInFolder(plugin, existingFolder, canonicalName)
		: null;
	if (matchingFile) {
		await addTagPropertiesToFile(plugin, matchingFile, canonicalName, safeParents);
		plugin.tagIndex.onTagFileCreated(matchingFile, canonicalName);
		return { created: true, tagName: canonicalName };
	}

	let filePath: string;
	if (existingFolder) {
		filePath = `${existingFolder.path}/${existingFolder.name}.md`;
	} else {
		// No matching folder — place tag note at vault root (never create folders during migration)
		const displayName = plugin.tagIndex.toDisplayName(canonicalName);
		filePath = `${displayName}.md`;
	}

	const existingFileAtPath = plugin.app.vault.getAbstractFileByPath(filePath);
	if (existingFileAtPath) {
		if (existingFileAtPath instanceof TFile && !plugin.tagIndex.isTagFile(existingFileAtPath)) {
			await addTagPropertiesToFile(plugin, existingFileAtPath, canonicalName, safeParents);
			plugin.tagIndex.onTagFileCreated(existingFileAtPath, canonicalName);
			return { created: true, tagName: canonicalName };
		}
		return { created: false, tagName: canonicalName };
	}

	const content = await generateTagFileContent(plugin, canonicalName, safeParents);

	try {
		const file = await plugin.app.vault.create(filePath, content);
		plugin.tagIndex.onTagFileCreated(file, canonicalName);
		return { created: true, tagName: canonicalName };
	} catch {
		const existingFile = plugin.app.vault.getAbstractFileByPath(filePath);
		if (existingFile instanceof TFile && !plugin.tagIndex.isTagFile(existingFile)) {
			await addTagPropertiesToFile(plugin, existingFile, canonicalName, safeParents);
			plugin.tagIndex.onTagFileCreated(existingFile, canonicalName);
			return { created: true, tagName: canonicalName };
		}
		return { created: false, tagName: canonicalName };
	}
}

/**
 * Ensures a tag file has the correct parent tag in its frontmatter.
 * If the parent is not already present, adds it.
 */
async function ensureParentRelationship(
	plugin: TaggableTagsPlugin,
	file: TFile,
	parentTag: string
): Promise<void> {
	const tagName =
		plugin.tagIndex.getTagForFilePath(file.path) ??
		plugin.tagIndex.fileToTagName(file);
	if (tagName && wouldParentCreateCycle(plugin, tagName, parentTag)) {
		return;
	}

	const cache = plugin.app.metadataCache.getFileCache(file);
	if (!cache?.frontmatter) return;

	const existingTags = readFrontmatterTags(cache);
	const normalizedParent = plugin.tagIndex.normalizeTag(parentTag);

	if (Array.isArray(existingTags)) {
		const hasParent = existingTags.some(
			(t: unknown) => typeof t === 'string' && plugin.tagIndex.tagsMatch(t, normalizedParent)
		);
		if (hasParent) return;
	}

	const content = await plugin.app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return;

	const frontmatter = match[1];
	let newFrontmatter: string;

	const tagsMatch = frontmatter.match(/^tags:\s*(\[.*\])?$/m);
	if (tagsMatch) {
		if (tagsMatch[1] === '[]') {
			newFrontmatter = frontmatter.replace(/^tags:\s*\[\]$/m, `tags:\n  - ${normalizedParent}`);
		} else if (tagsMatch[1]) {
			const existingTagsStr = tagsMatch[1].slice(1, -1);
			const existingTagsList = existingTagsStr.split(',').map(t => t.trim()).filter(t => t);
			existingTagsList.push(normalizedParent);
			const newTagsStr = existingTagsList.map(t => `  - ${t}`).join('\n');
			newFrontmatter = frontmatter.replace(/^tags:\s*\[.*\]$/m, `tags:\n${newTagsStr}`);
		} else {
			const tagsEndMatch = frontmatter.match(/^tags:\n((?:\s+-\s+.*\n?)*)/m);
			if (tagsEndMatch) {
				const tagsSection = tagsEndMatch[0];
				const newTagsSection = tagsSection.trimEnd() + `\n  - ${normalizedParent}`;
				newFrontmatter = frontmatter.replace(tagsEndMatch[0], newTagsSection);
			} else {
				return;
			}
		}
	} else {
		newFrontmatter = frontmatter + `\ntags:\n  - ${normalizedParent}`;
	}

	const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
	await plugin.app.vault.modify(file, newContent);
}

/**
 * Replaces all instances of a nested tag with its resolved leaf tag.
 */
async function replaceNestedTagInFiles(
	plugin: TaggableTagsPlugin,
	tagInfo: NestedTagInfo,
	replacementLeaf: string
): Promise<number> {
	let filesUpdated = 0;

	for (const file of tagInfo.files) {
		const updated = await replaceNestedTagInFile(plugin, file, tagInfo, replacementLeaf);
		if (updated) {
			filesUpdated++;
		}
	}

	return filesUpdated;
}

/**
 * Replaces a nested tag with the resolved leaf tag in a single file.
 * Uses raw spellings from the vault so hyphen/space/case variants are replaced.
 */
async function replaceNestedTagInFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagInfo: NestedTagInfo,
	replacementLeaf: string
): Promise<boolean> {
	const normalizedReplacement = plugin.tagIndex.normalizeTag(replacementLeaf);
	let modified = false;

	// Replace all raw spellings in inline body tags
	const content = await plugin.app.vault.read(file);
	let newContent = content;
	for (const raw of tagInfo.rawSpellings) {
		const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const inlineTagRegex = new RegExp(`#${escaped}(?![\\w/])`, 'g');
		if (inlineTagRegex.test(newContent)) {
			newContent = newContent.replace(inlineTagRegex, `#${normalizedReplacement}`);
			modified = true;
		}
	}
	if (modified) {
		await plugin.app.vault.modify(file, newContent);
	}

	// Frontmatter via processFrontMatter (handles scalar tags, arrays, and spelling variants)
	await processFrontmatterRecord(plugin.app, file, (fm) => {
		const tags = normalizeFmTagsValue(fm['tags']);
		if (tags === null) return;

		let changed = false;
		const updated = tags.map(t => {
			for (const raw of tagInfo.rawSpellings) {
				if (t === raw || plugin.tagIndex.tagsMatch(t, tagInfo.fullTag)) {
					changed = true;
					return normalizedReplacement;
				}
			}
			return t;
		});

		if (changed) {
			const deduped: string[] = [];
			for (const t of updated) {
				if (!deduped.some(d => plugin.tagIndex.tagsMatch(d, t))) {
					deduped.push(t);
				}
			}
			fm['tags'] = deduped;
			modified = true;
		}
	});

	return modified;
}

function normalizeFmTagsValue(tags: unknown): string[] | null {
	if (tags === undefined || tags === null) return null;
	if (typeof tags === 'string') return [tags];
	if (Array.isArray(tags)) return tags.filter((t): t is string => typeof t === 'string');
	return null;
}
