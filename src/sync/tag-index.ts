import { App, TFile, normalizePath } from 'obsidian';
import type { TaggableTagsSettings } from '../settings';

/**
 * Maintains a mapping between tags used in the vault and their corresponding tag definition files.
 */
export class TagIndex {
	private app: App;
	private settings: TaggableTagsSettings;
	
	// tag name (without #) -> tag definition file
	private tagToFile: Map<string, TFile | null> = new Map();
	// file path -> tag name
	private fileToTag: Map<string, string> = new Map();
	// tag name -> parent tag names (from tag file frontmatter)
	private tagParents: Map<string, Set<string>> = new Map();
	// tag name -> child tag names (inferred from parents)
	private tagChildren: Map<string, Set<string>> = new Map();
	// tag name -> files that have this tag
	private tagToFiles: Map<string, Set<TFile>> = new Map();
	// tag name -> tags it is an exception to (from "exception to" property)
	private tagExceptions: Map<string, Set<string>> = new Map();
	// tags that are exclusive (have "all" in their exception to property)
	private exclusiveTags: Set<string> = new Set();

	constructor(app: App, settings: TaggableTagsSettings) {
		this.app = app;
		this.settings = settings;
	}

	/**
	 * Normalize a tag name (lowercase if setting is enabled)
	 */
	normalizeTag(tag: string): string {
		const tagName = tag.startsWith('#') ? tag.slice(1) : tag;
		return this.settings.forceLowercase ? tagName.toLowerCase() : tagName;
	}

	/**
	 * Get the tag property value from a file's frontmatter.
	 * Returns null if the property doesn't exist or is empty.
	 */
	getTagPropertyValue(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) {
			return null;
		}
		const propName = this.settings.tagPropertyName;
		const propValue = cache.frontmatter[propName];
		if (typeof propValue === 'string' && propValue.trim()) {
			return propValue.trim();
		}
		return null;
	}

	/**
	 * Check if a file has the tag property (any non-empty value)
	 */
	hasTagProperty(file: TFile): boolean {
		return this.getTagPropertyValue(file) !== null;
	}

	/**
	 * Check if a file is a tag definition file (has the tag property)
	 */
	isTagFile(file: TFile): boolean {
		return this.hasTagProperty(file);
	}

	/**
	 * Check if a file is the tag registry note
	 */
	isTagRegistryNote(file: TFile): boolean {
		if (!this.settings.enableTagRegistry) {
			return false;
		}
		const registryPath = normalizePath(this.settings.tagRegistryPath);
		const filePath = normalizePath(file.path);
		// Check exact path match, or if the filename matches (in case it was moved)
		const registryFilename = registryPath.split('/').pop() || registryPath;
		return filePath === registryPath || file.name === registryFilename;
	}

	/**
	 * Get the tag name from a tag file.
	 * Returns the value of the tag property (normalized).
	 */
	fileToTagName(file: TFile): string | null {
		const propValue = this.getTagPropertyValue(file);
		if (propValue) {
			return this.normalizeTag(propValue);
		}
		return null;
	}

	/**
	 * Sanitize a tag name for use as a filename.
	 * Handles special characters that aren't allowed in filenames.
	 */
	sanitizeTagName(tag: string): string {
		// Replace characters that are problematic for filesystems
		return tag
			.replace(/\//g, '--slash--')
			.replace(/\\/g, '--backslash--')
			.replace(/:/g, '--colon--')
			.replace(/\*/g, '--star--')
			.replace(/\?/g, '--question--')
			.replace(/"/g, '--quote--')
			.replace(/</g, '--lt--')
			.replace(/>/g, '--gt--')
			.replace(/\|/g, '--pipe--');
	}

	/**
	 * Reverse the sanitization to get the original tag name
	 */
	unsanitizeTagName(filename: string): string {
		return filename
			.replace(/--slash--/g, '/')
			.replace(/--backslash--/g, '\\')
			.replace(/--colon--/g, ':')
			.replace(/--star--/g, '*')
			.replace(/--question--/g, '?')
			.replace(/--quote--/g, '"')
			.replace(/--lt--/g, '<')
			.replace(/--gt--/g, '>')
			.replace(/--pipe--/g, '|');
	}

	/**
	 * Get all tags (both used in files and defined as tag files)
	 */
	getAllTags(): string[] {
		const allTags = new Set<string>();
		// Add tags that are used in files
		for (const tag of this.tagToFiles.keys()) {
			allTags.add(tag);
		}
		// Add tags that have tag files (even if not used)
		for (const tag of this.tagToFile.keys()) {
			allTags.add(tag);
		}
		return Array.from(allTags);
	}

	/**
	 * Get the tag file for a given tag
	 */
	getTagFile(tag: string): TFile | null {
		const tagName = this.normalizeTag(tag);
		return this.tagToFile.get(tagName) ?? null;
	}

	/**
	 * Get the tag name for a given file path (from internal map)
	 */
	getTagForFilePath(path: string): string | null {
		return this.fileToTag.get(path) ?? null;
	}

	/**
	 * Get parent tags for a given tag (from tag file frontmatter)
	 */
	getParentTags(tag: string): string[] {
		const tagName = this.normalizeTag(tag);
		const parents = this.tagParents.get(tagName);
		return parents ? Array.from(parents) : [];
	}

	/**
	 * Get child tags for a given tag (tags that have this tag as parent)
	 */
	getChildTags(tag: string): string[] {
		const tagName = this.normalizeTag(tag);
		const children = this.tagChildren.get(tagName);
		return children ? Array.from(children) : [];
	}

	/**
	 * Get root tags (tags that have no parents OR are part of a circular chain OR are exclusive)
	 * Circular tags are included as roots so they appear in the explorer
	 * Exclusive tags are included as roots because their children only show under them
	 */
	getRootTags(): string[] {
		const result: string[] = [];
		const allTags = this.getAllTags();
		const circularTags = this.getCircularTags();
		
		for (const tag of allTags) {
			const parents = this.tagParents.get(tag);
			// A tag is a root if:
			// - it has no parents, OR
			// - it's part of a circular chain, OR
			// - it's an exclusive tag (its children only show under it)
			if (!parents || parents.size === 0 || circularTags.has(tag) || this.exclusiveTags.has(tag)) {
				result.push(tag);
			}
		}
		return result.sort();
	}

	/**
	 * Check if a tag is part of a circular reference chain
	 */
	isCircularTag(tag: string): boolean {
		return this.detectCycleFromTag(tag, new Set());
	}

	/**
	 * Get all tags that are part of circular reference chains
	 */
	getCircularTags(): Set<string> {
		const circularTags = new Set<string>();
		const allTags = this.getAllTags();
		
		for (const tag of allTags) {
			if (this.detectCycleFromTag(tag, new Set())) {
				// Find all tags in this cycle
				this.collectCycleTags(tag, new Set(), circularTags);
			}
		}
		
		return circularTags;
	}

	/**
	 * Detect if following children from a tag leads back to itself (cycle detection)
	 */
	private detectCycleFromTag(tag: string, visited: Set<string>): boolean {
		if (visited.has(tag)) {
			return true; // Found a cycle
		}
		
		visited.add(tag);
		const children = this.tagChildren.get(tag);
		
		if (children) {
			for (const child of children) {
				if (this.detectCycleFromTag(child, new Set(visited))) {
					return true;
				}
			}
		}
		
		return false;
	}

	/**
	 * Collect all tags that are part of a cycle starting from a given tag
	 */
	private collectCycleTags(tag: string, path: Set<string>, result: Set<string>): void {
		if (path.has(tag)) {
			// Found cycle - add all tags in the current path
			for (const t of path) {
				result.add(t);
			}
			result.add(tag);
			return;
		}
		
		path.add(tag);
		const children = this.tagChildren.get(tag);
		
		if (children) {
			for (const child of children) {
				this.collectCycleTags(child, new Set(path), result);
			}
		}
	}

	/**
	 * Parse the "exception to" property value.
	 * Accepts an array or single value containing:
	 * - Wikilinks like [[tagname]] or [[Tag Name]]
	 * - The keyword "all" (case-insensitive) for exclusive tags
	 * 
	 * @returns Object with set of exception tag names and whether it's exclusive
	 */
	private parseExceptionProperty(value: unknown): { tags: Set<string>, isExclusive: boolean } {
		const result = { tags: new Set<string>(), isExclusive: false };
		
		// Normalize to array
		const items = Array.isArray(value) ? value : [value];
		
		for (const item of items) {
			if (typeof item !== 'string') continue;
			
			const trimmed = item.trim();
			
			// Check for "all" keyword (case-insensitive)
			if (trimmed.toLowerCase() === 'all') {
				result.isExclusive = true;
				continue;
			}
			
			// Check for wikilink format: [[tagname]]
			const wikiLinkMatch = trimmed.match(/^\[\[([^\]]+)\]\]$/);
			if (wikiLinkMatch) {
				const tagName = this.normalizeTag(wikiLinkMatch[1]);
				result.tags.add(tagName);
			}
		}
		
		return result;
	}

	/**
	 * Get child tags, optionally excluding tags already in the ancestor path (for cycle handling)
	 */
	getChildTagsExcluding(tag: string, excludeAncestors?: Set<string>): string[] {
		const tagName = this.normalizeTag(tag);
		const children = this.tagChildren.get(tagName);
		if (!children) return [];
		
		if (excludeAncestors) {
			return Array.from(children).filter(child => !excludeAncestors.has(child));
		}
		return Array.from(children);
	}

	/**
	 * Get the tags that a given tag is an exception to.
	 * Exception tags don't show their children under the excepted tags.
	 */
	getExceptionTags(tag: string): string[] {
		const tagName = this.normalizeTag(tag);
		const exceptions = this.tagExceptions.get(tagName);
		return exceptions ? Array.from(exceptions) : [];
	}

	/**
	 * Check if a tag is an exception to a specific other tag.
	 */
	isExceptionTo(tag: string, exceptedTag: string): boolean {
		const tagName = this.normalizeTag(tag);
		const exceptedTagName = this.normalizeTag(exceptedTag);
		const exceptions = this.tagExceptions.get(tagName);
		return exceptions ? exceptions.has(exceptedTagName) : false;
	}

	/**
	 * Check if a tag is exclusive (exception to "all").
	 * Exclusive tags' children only show under the exclusive tag itself.
	 */
	isExclusiveTag(tag: string): boolean {
		const tagName = this.normalizeTag(tag);
		return this.exclusiveTags.has(tagName);
	}

	/**
	 * Get all exclusive tags.
	 */
	getExclusiveTags(): string[] {
		return Array.from(this.exclusiveTags);
	}

	/**
	 * Get all files that have a specific tag (excludes registry note)
	 */
	getFilesWithTag(tag: string): TFile[] {
		const tagName = this.normalizeTag(tag);
		const files = this.tagToFiles.get(tagName);
		if (!files) return [];
		// Filter out the registry note only
		return Array.from(files).filter(file => !this.isTagRegistryNote(file));
	}

	/**
	 * Get all files that have no tags (excluding tag files and registry note)
	 */
	getUntaggedFiles(): TFile[] {
		const allFiles = this.app.vault.getMarkdownFiles();
		const untagged: TFile[] = [];
		
		for (const file of allFiles) {
			// Skip tag files and registry note
			if (this.isTagFile(file) || this.isTagRegistryNote(file)) {
				continue;
			}
			
			// Check if file has any tags
			const cache = this.app.metadataCache.getFileCache(file);
			let hasTags = false;
			
			// Check frontmatter tags
			if (cache?.frontmatter?.tags) {
				const fmTags = cache.frontmatter.tags;
				if (Array.isArray(fmTags) && fmTags.length > 0) {
					// Check if any non-nested tags exist
					for (const tag of fmTags) {
						if (typeof tag === 'string' && !tag.includes('/')) {
							hasTags = true;
							break;
						}
					}
				}
			}
			
			// Check inline tags
			if (!hasTags && cache?.tags) {
				for (const tagCache of cache.tags) {
					let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
					if (!tagName.includes('/')) {
						hasTags = true;
						break;
					}
				}
			}
			
			if (!hasTags) {
				untagged.push(file);
			}
		}
		
		return untagged.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/**
	 * Get all tags that don't have corresponding files
	 * This includes tags used in regular files AND parent tags referenced in tag files
	 */
	getTagsWithoutFiles(): string[] {
		const result: string[] = [];
		
		// Check tags used in regular files
		for (const tag of this.tagToFiles.keys()) {
			if (!this.tagToFile.has(tag) || this.tagToFile.get(tag) === null) {
				result.push(tag);
			}
		}
		
		// Also check parent tags referenced in tag files
		// These are stored in tagChildren (as keys)
		for (const parentTag of this.tagChildren.keys()) {
			if (!this.tagToFile.has(parentTag) || this.tagToFile.get(parentTag) === null) {
				if (!result.includes(parentTag)) {
					result.push(parentTag);
				}
			}
		}
		
		return result;
	}

	/**
	 * Get all tag files that don't have corresponding tags in use
	 */
	getFilesWithoutTags(): TFile[] {
		const result: TFile[] = [];
		for (const [path, tag] of this.fileToTag) {
			const filesWithTag = this.tagToFiles.get(tag);
			if (!filesWithTag || filesWithTag.size === 0) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					result.push(file);
				}
			}
		}
		return result;
	}

	/**
	 * Get the usage count for a tag (number of files using it, excludes registry note)
	 */
	getTagCount(tag: string): number {
		const tagName = this.normalizeTag(tag);
		const files = this.tagToFiles.get(tagName);
		if (!files) return 0;
		// Count all files except the registry note
		let count = 0;
		for (const file of files) {
			if (!this.isTagRegistryNote(file)) {
				count++;
			}
		}
		return count;
	}

	/**
	 * Get all tags that a specific file has (according to the index)
	 */
	getTagsForFile(file: TFile): string[] {
		const tags: string[] = [];
		for (const [tag, files] of this.tagToFiles.entries()) {
			if (files.has(file)) {
				tags.push(tag);
			}
		}
		return tags;
	}

	/**
	 * Rebuild the entire index
	 */
	async rebuild(): Promise<void> {
		// Clear current state
		this.tagToFile.clear();
		this.fileToTag.clear();
		this.tagParents.clear();
		this.tagChildren.clear();
		this.tagToFiles.clear();
		this.tagExceptions.clear();
		this.exclusiveTags.clear();

		// Get all markdown files
		const files = this.app.vault.getMarkdownFiles();
		
		// Track tag files by tag name to handle duplicates (select most recently created)
		const tagFileCandidates: Map<string, TFile[]> = new Map();
		
		// First pass: identify all tag files and collect tags from regular files
		for (const file of files) {
			// Skip the tag registry note entirely - don't index it or count its tags
			if (this.isTagRegistryNote(file)) {
				continue;
			}

			// Check if this is a tag file
			if (this.isTagFile(file)) {
				// Process as tag definition file
				const tagName = this.fileToTagName(file);
				if (tagName) {
					const normalizedTag = this.normalizeTag(tagName);
					
					// Collect candidates for this tag
					if (!tagFileCandidates.has(normalizedTag)) {
						tagFileCandidates.set(normalizedTag, []);
					}
					tagFileCandidates.get(normalizedTag)!.push(file);
				}
				// Also track the tags used IN this tag file (for parent relationships and unused detection)
				// These won't be counted in getTagCount or shown in getFilesWithTag
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter?.tags) {
					const fmTags = cache.frontmatter.tags;
					if (Array.isArray(fmTags)) {
						for (const tag of fmTags) {
							if (typeof tag === 'string' && !tag.includes('/')) {
								const normalizedTag = this.normalizeTag(tag);
								if (!this.tagToFiles.has(normalizedTag)) {
									this.tagToFiles.set(normalizedTag, new Set());
								}
								this.tagToFiles.get(normalizedTag)!.add(file);
							}
						}
					}
				}
				continue;
			}

			// Process as regular file - collect tags
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			const fileTags = new Set<string>();

			// Get tags from frontmatter
			if (cache.frontmatter?.tags) {
				const fmTags = cache.frontmatter.tags;
				if (Array.isArray(fmTags)) {
					for (const tag of fmTags) {
						if (typeof tag === 'string' && !tag.includes('/')) {
							const normalizedTag = this.normalizeTag(tag);
							fileTags.add(normalizedTag);
						}
					}
				}
			}

			// Get inline tags
			if (cache.tags) {
				for (const tagCache of cache.tags) {
					// tagCache.tag includes the # prefix
					let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
					// Skip nested tags for now
					if (tagName.includes('/')) {
						continue;
					}
					const normalizedTag = this.normalizeTag(tagName);
					fileTags.add(normalizedTag);
				}
			}

			// Update file mappings
			for (const tag of fileTags) {
				// Track which files have this tag
				if (!this.tagToFiles.has(tag)) {
					this.tagToFiles.set(tag, new Set());
				}
				this.tagToFiles.get(tag)!.add(file);
			}
		}

		// Select the most recently created file for each tag (handle duplicates)
		for (const [normalizedTag, candidates] of tagFileCandidates) {
			// Sort by creation time (most recent first)
			candidates.sort((a, b) => b.stat.ctime - a.stat.ctime);
			const selectedFile = candidates[0];
			
			this.tagToFile.set(normalizedTag, selectedFile);
			this.fileToTag.set(selectedFile.path, normalizedTag);

			// Get parent tags from this tag file's frontmatter
			const cache = this.app.metadataCache.getFileCache(selectedFile);
			if (cache?.frontmatter?.tags) {
				const parentTags = cache.frontmatter.tags;
				if (Array.isArray(parentTags)) {
					const parents = new Set<string>();
					for (const parent of parentTags) {
						if (typeof parent === 'string') {
							const normalizedParent = this.normalizeTag(parent);
							parents.add(normalizedParent);
							
							// Add this tag as a child of the parent
							if (!this.tagChildren.has(normalizedParent)) {
								this.tagChildren.set(normalizedParent, new Set());
							}
							this.tagChildren.get(normalizedParent)!.add(normalizedTag);
						}
					}
					this.tagParents.set(normalizedTag, parents);
				}
			}

			// Get exception tags from this tag file's frontmatter
			if (cache?.frontmatter) {
				const exceptionPropName = this.settings.exceptionToPropertyName;
				const exceptionValue = cache.frontmatter[exceptionPropName];
				if (exceptionValue) {
					const exceptions = this.parseExceptionProperty(exceptionValue);
					if (exceptions.tags.size > 0) {
						this.tagExceptions.set(normalizedTag, exceptions.tags);
					}
					if (exceptions.isExclusive) {
						this.exclusiveTags.add(normalizedTag);
					}
				}
			}
		}

		// Also add entries for tags that exist but have null files
		for (const tag of this.tagToFiles.keys()) {
			if (!this.tagToFile.has(tag)) {
				this.tagToFile.set(tag, null);
			}
		}

		// Ensure all tags have parent/children sets (even if empty)
		// Include both tags from files and tags from tag files
		const allTagNames = new Set<string>();
		for (const tag of this.tagToFiles.keys()) {
			allTagNames.add(tag);
		}
		for (const tag of this.tagToFile.keys()) {
			allTagNames.add(tag);
		}
		
		for (const tag of allTagNames) {
			if (!this.tagParents.has(tag)) {
				this.tagParents.set(tag, new Set());
			}
			if (!this.tagChildren.has(tag)) {
				this.tagChildren.set(tag, new Set());
			}
		}
	}

	/**
	 * Update the index when a tag file is created.
	 * @param file The created tag file
	 * @param tagName Optional tag name - if provided, uses this instead of reading from metadata cache
	 *                (useful when file was just created and cache hasn't updated yet)
	 */
	onTagFileCreated(file: TFile, tagName?: string): void {
		const resolvedTagName = tagName ?? this.fileToTagName(file);
		if (resolvedTagName) {
			const normalizedTag = this.normalizeTag(resolvedTagName);
			this.tagToFile.set(normalizedTag, file);
			this.fileToTag.set(file.path, normalizedTag);
		}
	}

	/**
	 * Update the index when a tag file is deleted
	 */
	onTagFileDeleted(path: string): void {
		const tagName = this.fileToTag.get(path);
		if (tagName) {
			this.tagToFile.set(tagName, null);
			this.fileToTag.delete(path);
		}
	}

	/**
	 * Update the index when a tag file's tag property changes
	 */
	onTagPropertyChanged(file: TFile, oldTag: string | null): void {
		// Remove old mapping if it existed
		if (oldTag) {
			this.tagToFile.set(oldTag, null);
		}
		this.fileToTag.delete(file.path);

		// Add new mapping
		const newTag = this.fileToTagName(file);
		if (newTag) {
			const normalizedTag = this.normalizeTag(newTag);
			this.tagToFile.set(normalizedTag, file);
			this.fileToTag.set(file.path, normalizedTag);
		}
	}

	/**
	 * Update the index when a tag file is renamed (file path changed)
	 */
	onTagFileRenamed(file: TFile, oldPath: string): void {
		// Get the tag from the old path mapping
		const tag = this.fileToTag.get(oldPath);
		if (tag) {
			// Update the file path mapping
			this.fileToTag.delete(oldPath);
			this.fileToTag.set(file.path, tag);
			// The tag -> file mapping stays the same since the file object is updated
			this.tagToFile.set(tag, file);
		}
	}

	/**
	 * Get the first tag from a file's frontmatter tags array.
	 * Only returns flat tags (not Obsidian nested tags with '/').
	 * Returns null if the file has no tags or only nested tags.
	 */
	getFirstTag(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter?.tags) {
			return null;
		}
		
		const tags = cache.frontmatter.tags;
		if (!Array.isArray(tags)) {
			return null;
		}
		
		// Find the first flat tag (no '/')
		for (const tag of tags) {
			if (typeof tag === 'string' && !tag.includes('/')) {
				return this.normalizeTag(tag);
			}
		}
		
		return null;
	}

	/**
	 * Get all tags from a file's frontmatter tags array in order.
	 * Only returns flat tags (not Obsidian nested tags with '/').
	 */
	getAllTagsFromFile(file: TFile): string[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter?.tags) {
			return [];
		}
		
		const tags = cache.frontmatter.tags;
		if (!Array.isArray(tags)) {
			return [];
		}
		
		const result: string[] = [];
		for (const tag of tags) {
			if (typeof tag === 'string' && !tag.includes('/')) {
				result.push(this.normalizeTag(tag));
			}
		}
		
		return result;
	}

	/**
	 * Get the tag name from a folder path.
	 * The folder path is expected to match the tag hierarchy.
	 * Returns the leaf folder name as the tag (e.g., "programming/python" -> "python").
	 */
	getTagFromFolderPath(folderPath: string): string | null {
		if (!folderPath || folderPath === '/') {
			return null;
		}
		
		// Normalize the path and get the leaf folder name
		const normalizedPath = normalizePath(folderPath);
		const parts = normalizedPath.split('/').filter(p => p.length > 0);
		
		if (parts.length === 0) {
			return null;
		}
		
		// The tag is the last part of the path (leaf folder)
		const tagName = parts[parts.length - 1];
		return this.normalizeTag(tagName);
	}
}
