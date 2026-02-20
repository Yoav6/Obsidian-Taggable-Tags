import { TFile, TFolder, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { generateTagFileContent, addTagPropertiesToFile } from '../utils/tag-template';
import { namesMatch, findMatchingFolder } from '../utils/name-matching';

/**
 * Information about a nested tag found in the vault.
 */
interface NestedTagInfo {
	/** The full nested tag (without #), e.g., "media/music/songs" */
	fullTag: string;
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

	// Step 1: Find all nested tags in the vault
	const nestedTags = findAllNestedTags(plugin);

	if (nestedTags.size === 0) {
		new Notice('No nested tags found in the vault.');
		return;
	}

	// Step 2: Collect all unique tag levels that need to be created
	const allLevels = collectAllTagLevels(nestedTags);

	// Step 3: Create tag files for each level with parent relationships
	let createdCount = 0;
	for (const { tagName, parentTag } of allLevels) {
		const created = await createTagFileIfNeeded(plugin, tagName, parentTag);
		if (created) {
			createdCount++;
		}
	}

	// Step 4: Replace all nested tags in the vault with their leaf tags
	let filesUpdated = 0;
	for (const tagInfo of nestedTags.values()) {
		const updatedFiles = await replaceNestedTagInFiles(plugin, tagInfo);
		filesUpdated += updatedFiles;
	}

	// Step 5: Rebuild the tag index
	await plugin.tagIndex.rebuild();
	await plugin.updateTagRegistry();

	// Show summary
	new Notice(
		`Flattened ${nestedTags.size} nested tag${nestedTags.size === 1 ? '' : 's'}, ` +
		`created ${createdCount} tag file${createdCount === 1 ? '' : 's'}, ` +
		`updated ${filesUpdated} file${filesUpdated === 1 ? '' : 's'}.`
	);
}

/**
 * Finds all nested tags (tags containing '/') in the vault.
 * Returns a map of full nested tag -> NestedTagInfo.
 */
function findAllNestedTags(plugin: TaggableTagsPlugin): Map<string, NestedTagInfo> {
	const nestedTags = new Map<string, NestedTagInfo>();
	const files = plugin.app.vault.getMarkdownFiles();

	for (const file of files) {
		// Skip the tag registry note
		if (plugin.tagIndex.isTagRegistryNote(file)) {
			continue;
		}

		const cache = plugin.app.metadataCache.getFileCache(file);
		if (!cache) continue;

		// Check frontmatter tags
		if (cache.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				for (const tag of fmTags) {
					if (typeof tag === 'string' && tag.includes('/')) {
						addNestedTag(plugin, nestedTags, tag, file);
					}
				}
			}
		}

		// Check inline tags
		if (cache.tags) {
			for (const tagCache of cache.tags) {
				// tagCache.tag includes the # prefix
				let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
				if (tagName.includes('/')) {
					addNestedTag(plugin, nestedTags, tagName, file);
				}
			}
		}
	}

	return nestedTags;
}

/**
 * Adds a nested tag to the map, creating or updating the NestedTagInfo.
 */
function addNestedTag(
	plugin: TaggableTagsPlugin,
	nestedTags: Map<string, NestedTagInfo>,
	fullTag: string,
	file: TFile
): void {
	// Normalize the tag
	const normalizedTag = plugin.settings.forceLowercase ? fullTag.toLowerCase() : fullTag;

	if (!nestedTags.has(normalizedTag)) {
		const levels = normalizedTag.split('/');
		nestedTags.set(normalizedTag, {
			fullTag: normalizedTag,
			levels,
			leafTag: levels[levels.length - 1],
			files: new Set(),
		});
	}

	nestedTags.get(normalizedTag)!.files.add(file);
}

/**
 * Collects all unique tag levels from nested tags with their parent relationships.
 * Returns them in order from root to leaf (so parents are created first).
 */
function collectAllTagLevels(
	nestedTags: Map<string, NestedTagInfo>
): Array<{ tagName: string; parentTag: string | null }> {
	// Use a map to track unique tags and their parents
	// Key is tag name, value is parent tag (or null for root)
	const tagParentMap = new Map<string, string | null>();

	for (const tagInfo of nestedTags.values()) {
		const levels = tagInfo.levels;

		for (let i = 0; i < levels.length; i++) {
			const tagName = levels[i];
			const parentTag = i > 0 ? levels[i - 1] : null;

			// Only set parent if not already set (first occurrence wins)
			// This handles cases where same tag appears at different levels in different nested tags
			if (!tagParentMap.has(tagName)) {
				tagParentMap.set(tagName, parentTag);
			}
		}
	}

	// Convert to array, sorted so parents come before children
	// We do this by processing levels in order
	const result: Array<{ tagName: string; parentTag: string | null }> = [];
	const processed = new Set<string>();

	// Process tags level by level
	// First, add all root tags (no parent)
	for (const [tagName, parentTag] of tagParentMap) {
		if (parentTag === null && !processed.has(tagName)) {
			result.push({ tagName, parentTag });
			processed.add(tagName);
		}
	}

	// Then iteratively add tags whose parents have been processed
	let changed = true;
	while (changed) {
		changed = false;
		for (const [tagName, parentTag] of tagParentMap) {
			if (!processed.has(tagName) && parentTag !== null && processed.has(parentTag)) {
				result.push({ tagName, parentTag });
				processed.add(tagName);
				changed = true;
			}
		}
	}

	// Add any remaining tags (shouldn't happen in well-formed data, but just in case)
	for (const [tagName, parentTag] of tagParentMap) {
		if (!processed.has(tagName)) {
			result.push({ tagName, parentTag });
			processed.add(tagName);
		}
	}

	return result;
}

/**
 * Creates a tag file for the given tag if it doesn't already exist.
 * If a file with matching name exists, converts it to a tag file instead.
 * Returns true if a new file was created or an existing file was converted.
 * 
 * Note: Folder and file names keep the original tag name (with spaces etc).
 * Only the tag property value is normalized.
 */
async function createTagFileIfNeeded(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag: string | null
): Promise<boolean> {
	// Check if tag file already exists in the index
	const existingTagFile = plugin.tagIndex.getTagFile(tagName);
	if (existingTagFile) {
		// Tag file exists - check if we need to add the parent relationship
		if (parentTag) {
			await ensureParentRelationship(plugin, existingTagFile, parentTag);
		}
		return false;
	}

	// Check if a file with matching name exists that can be converted
	const matchingFile = findMatchingFileForTag(plugin, tagName);
	if (matchingFile) {
		// Convert existing file to tag note by adding tag properties
		await addTagPropertiesToFile(plugin, matchingFile, tagName, parentTag);
		plugin.tagIndex.onTagFileCreated(matchingFile, tagName);
		return true;
	}

	// Find the parent folder to search in
	let parentFolder: TFolder | undefined;
	if (parentTag) {
		const parentTagFile = plugin.tagIndex.getTagFile(parentTag);
		if (parentTagFile?.parent && !parentTagFile.parent.isRoot()) {
			parentFolder = parentTagFile.parent;
		}
	}

	// Look for existing folder with matching name (normalized comparison)
	// This ensures "Cultural Library" folder matches "cultural-library" tag
	const searchRoot = parentFolder || plugin.app.vault.getRoot();
	const existingFolder = findMatchingFolder(plugin, tagName, searchRoot);

	let filePath: string;
	if (existingFolder) {
		// Use existing folder's actual path and name
		filePath = `${existingFolder.path}/${existingFolder.name}.md`;
	} else {
		// Create new folder with exact tag name
		const basePath = parentFolder ? parentFolder.path : '';
		filePath = basePath 
			? `${basePath}/${tagName}/${tagName}.md`
			: `${tagName}/${tagName}.md`;
	}

	// Check if file already exists at the path
	const existingFileAtPath = plugin.app.vault.getAbstractFileByPath(filePath);
	if (existingFileAtPath) {
		// File exists - try to convert it if it's not already a tag file
		if (existingFileAtPath instanceof TFile && !plugin.tagIndex.isTagFile(existingFileAtPath)) {
			await addTagPropertiesToFile(plugin, existingFileAtPath, tagName, parentTag);
			plugin.tagIndex.onTagFileCreated(existingFileAtPath, tagName);
			return true;
		}
		return false;
	}

	// Ensure the folder exists (only needed when creating a new folder)
	if (!existingFolder) {
		const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
		if (folderPath) {
			const folderAtPath = plugin.app.vault.getAbstractFileByPath(folderPath);
			if (!folderAtPath) {
				try {
					await plugin.app.vault.createFolder(folderPath);
				} catch (error) {
					// Folder might already exist (race condition or case-insensitive match)
					// This is not an error - continue with file creation
				}
			}
		}
	}

	// Generate content with parent tag
	const content = await generateTagFileContent(plugin, tagName, parentTag);
	
	try {
		const file = await plugin.app.vault.create(filePath, content);
		// Update the index
		plugin.tagIndex.onTagFileCreated(file, tagName);
		return true;
	} catch (error) {
		// File might already exist - try to convert it
		const existingFile = plugin.app.vault.getAbstractFileByPath(filePath);
		if (existingFile instanceof TFile && !plugin.tagIndex.isTagFile(existingFile)) {
			await addTagPropertiesToFile(plugin, existingFile, tagName, parentTag);
			plugin.tagIndex.onTagFileCreated(existingFile, tagName);
			return true;
		}
		// File exists and is already a tag file, or some other error - not a problem
		return false;
	}
}

/**
 * Find a file in the vault with a name matching the tag name.
 * Used to convert existing files to tag notes instead of creating new ones.
 */
function findMatchingFileForTag(plugin: TaggableTagsPlugin, tagName: string): TFile | null {
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		// Skip files that are already tag files
		if (plugin.tagIndex.isTagFile(file)) continue;
		
		// Skip the tag registry note
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		
		// Check if basename matches tag name (using normalized comparison)
		if (namesMatch(file.basename, tagName)) {
			return file;
		}
	}
	return null;
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
	const cache = plugin.app.metadataCache.getFileCache(file);
	if (!cache?.frontmatter) return;

	const existingTags = cache.frontmatter.tags;
	const normalizedParent = plugin.settings.forceLowercase ? parentTag.toLowerCase() : parentTag;

	// Check if parent is already in tags
	if (Array.isArray(existingTags)) {
		const hasParent = existingTags.some(
			(t: unknown) => typeof t === 'string' && 
				(plugin.settings.forceLowercase ? t.toLowerCase() : t) === normalizedParent
		);
		if (hasParent) return;
	}

	// Add parent tag to the file's frontmatter
	const content = await plugin.app.vault.read(file);
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);

	if (!match) return;

	const frontmatter = match[1];
	let newFrontmatter: string;

	// Check if tags property exists
	const tagsMatch = frontmatter.match(/^tags:\s*(\[.*\])?$/m);
	if (tagsMatch) {
		// Tags property exists
		if (tagsMatch[1] === '[]') {
			// Empty array - replace with array containing parent
			newFrontmatter = frontmatter.replace(/^tags:\s*\[\]$/m, `tags:\n  - ${normalizedParent}`);
		} else if (tagsMatch[1]) {
			// Inline array - convert to multiline and add parent
			const existingTagsStr = tagsMatch[1].slice(1, -1); // Remove [ ]
			const existingTagsList = existingTagsStr.split(',').map(t => t.trim()).filter(t => t);
			existingTagsList.push(normalizedParent);
			const newTagsStr = existingTagsList.map(t => `  - ${t}`).join('\n');
			newFrontmatter = frontmatter.replace(/^tags:\s*\[.*\]$/m, `tags:\n${newTagsStr}`);
		} else {
			// Multiline array - add parent at the end of the tags section
			const tagsEndMatch = frontmatter.match(/^tags:\n((?:\s+-\s+.*\n?)*)/m);
			if (tagsEndMatch) {
				const tagsSection = tagsEndMatch[0];
				const newTagsSection = tagsSection.trimEnd() + `\n  - ${normalizedParent}`;
				newFrontmatter = frontmatter.replace(tagsEndMatch[0], newTagsSection);
			} else {
				return; // Can't parse tags section
			}
		}
	} else {
		// No tags property - add it
		newFrontmatter = frontmatter + `\ntags:\n  - ${normalizedParent}`;
	}

	const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
	await plugin.app.vault.modify(file, newContent);
}

/**
 * Replaces all instances of a nested tag with its leaf tag in all files where it appears.
 * Returns the number of files that were updated.
 */
async function replaceNestedTagInFiles(
	plugin: TaggableTagsPlugin,
	tagInfo: NestedTagInfo
): Promise<number> {
	let filesUpdated = 0;

	for (const file of tagInfo.files) {
		const updated = await replaceNestedTagInFile(plugin, file, tagInfo);
		if (updated) {
			filesUpdated++;
		}
	}

	return filesUpdated;
}

/**
 * Replaces a nested tag with its leaf tag in a single file.
 * Handles both frontmatter tags and inline tags.
 * Returns true if the file was modified.
 */
async function replaceNestedTagInFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagInfo: NestedTagInfo
): Promise<boolean> {
	let content = await plugin.app.vault.read(file);
	let modified = false;

	// Replace in frontmatter tags
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const fmMatch = content.match(frontmatterRegex);

	if (fmMatch) {
		const frontmatter = fmMatch[1];
		let newFrontmatter = frontmatter;

		// Handle tags in YAML array format (both inline and multiline)
		// Inline: tags: [media/music/songs, other]
		// Multiline:
		// tags:
		//   - media/music/songs
		//   - other

		// Create regex patterns for the nested tag (case-insensitive if forceLowercase)
		const escapedFullTag = escapeRegex(tagInfo.fullTag);
		const caseFlag = plugin.settings.forceLowercase ? 'i' : '';

		// Replace in inline array format: [tag1, nested/tag, tag2]
		// Match the tag preceded by [ or , or whitespace, followed by , or ] or whitespace
		const inlineArrayRegex = new RegExp(
			`(tags:\\s*\\[[^\\]]*?(?:^|[\\[,\\s]))${escapedFullTag}(?=[\\],\\s]|$)`,
			'gm' + caseFlag
		);
		const replacedInline = newFrontmatter.replace(inlineArrayRegex, `$1${tagInfo.leafTag}`);
		if (replacedInline !== newFrontmatter) {
			newFrontmatter = replacedInline;
			modified = true;
		}

		// Replace in multiline array format: - nested/tag
		// Use global + multiline flags to replace all occurrences
		const multilineRegex = new RegExp(
			`(^\\s*-\\s*)${escapedFullTag}(\\s*$)`,
			'gm' + caseFlag
		);
		const replacedMultiline = newFrontmatter.replace(multilineRegex, `$1${tagInfo.leafTag}$2`);
		if (replacedMultiline !== newFrontmatter) {
			newFrontmatter = replacedMultiline;
			modified = true;
		}

		// Also handle quoted tags in YAML: - "nested/tag" or - 'nested/tag'
		const quotedRegex = new RegExp(
			`(^\\s*-\\s*)["']${escapedFullTag}["'](\\s*$)`,
			'gm' + caseFlag
		);
		const replacedQuoted = newFrontmatter.replace(quotedRegex, `$1${tagInfo.leafTag}$2`);
		if (replacedQuoted !== newFrontmatter) {
			newFrontmatter = replacedQuoted;
			modified = true;
		}

		if (modified) {
			content = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		}
	}

	// Replace inline tags in the body (after frontmatter)
	// Match #nested/tag but not inside code blocks
	const bodyStart = fmMatch ? fmMatch[0].length : 0;
	const body = content.slice(bodyStart);

	// Split by code blocks to avoid replacing tags inside them
	const codeBlockRegex = /```[\s\S]*?```|`[^`]+`/g;
	const parts: { text: string; isCode: boolean }[] = [];
	let lastIndex = 0;
	let codeMatch;

	while ((codeMatch = codeBlockRegex.exec(body)) !== null) {
		if (codeMatch.index > lastIndex) {
			parts.push({ text: body.slice(lastIndex, codeMatch.index), isCode: false });
		}
		parts.push({ text: codeMatch[0], isCode: true });
		lastIndex = codeMatch.index + codeMatch[0].length;
	}
	if (lastIndex < body.length) {
		parts.push({ text: body.slice(lastIndex), isCode: false });
	}

	// Replace inline tags in non-code parts
	const escapedFullTag = escapeRegex(tagInfo.fullTag);
	const inlineTagRegex = new RegExp(
		`#${escapedFullTag}(?=[\\s\\]\\)\\},;:!?'"\`]|$)`,
		plugin.settings.forceLowercase ? 'gi' : 'g'
	);

	let newBody = '';
	for (const part of parts) {
		if (part.isCode) {
			newBody += part.text;
		} else {
			const replaced = part.text.replace(inlineTagRegex, `#${tagInfo.leafTag}`);
			if (replaced !== part.text) {
				modified = true;
			}
			newBody += replaced;
		}
	}

	if (modified) {
		const newContent = content.slice(0, bodyStart) + newBody;
		await plugin.app.vault.modify(file, newContent);
	}

	return modified;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
