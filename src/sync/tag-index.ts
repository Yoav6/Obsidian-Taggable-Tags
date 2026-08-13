import { App, TFile, normalizePath, type CachedMetadata } from 'obsidian';
import type { TaggableTagsSettings } from '../settings';
import {
	toCanonicalTagName,
	toComparisonKey,
	toDisplayName,
	sanitizeForFilesystem,
	unsanitizeFromFilesystem,
	namesMatch,
} from '../utils/tag-naming';
import {
	frontmatterRecord,
	readFrontmatterString,
	readFrontmatterTags,
} from '../utils/frontmatter';

/**
 * Maintains a mapping between tags used in the vault and their corresponding tag definition files.
 *
 * Internal maps are keyed by comparison key (case/separator-insensitive).
 * Preferred canonical spellings are stored in canonicalByKey and returned by public APIs.
 */
export class TagIndex {
	private app: App;
	private settings: TaggableTagsSettings;
	
	/** comparison key -> preferred canonical tag spelling */
	private canonicalByKey: Map<string, string> = new Map();
	// comparison key -> tag definition file
	private tagToFile: Map<string, TFile | null> = new Map();
	// file path -> canonical tag name
	private fileToTag: Map<string, string> = new Map();
	// comparison key -> parent comparison keys
	private tagParents: Map<string, Set<string>> = new Map();
	// comparison key -> child comparison keys
	private tagChildren: Map<string, Set<string>> = new Map();
	// comparison key -> files that have this tag
	private tagToFiles: Map<string, Set<TFile>> = new Map();
	// comparison key -> exception comparison keys
	private tagExceptions: Map<string, Set<string>> = new Map();
	// exclusive tags (comparison keys)
	private exclusiveTags: Set<string> = new Set();
	// markdown note path -> attachments (non-md files) it references
	private noteToAttachments: Map<string, TFile[]> = new Map();
	// attachment path -> markdown notes that reference it
	private attachmentReferrers: Map<string, Set<TFile>> = new Map();
	// tag comparison key -> attachments whose parent folder maps to that tag
	private tagToFolderAttachments: Map<string, Set<TFile>> = new Map();
	// paths of attachments whose parent folder maps to a known tag
	private folderConnectedAttachmentPaths: Set<string> = new Set();

	constructor(app: App, settings: TaggableTagsSettings) {
		this.app = app;
		this.settings = settings;
	}

	/** Comparison key for map lookups. */
	private key(tag: string): string {
		return toComparisonKey(tag, this.settings);
	}

	/** Remember first-seen settings-canonical spelling for a key. */
	private remember(canonical: string): string {
		const normalized = toCanonicalTagName(canonical, this.settings);
		const k = this.key(normalized);
		if (!this.canonicalByKey.has(k)) {
			this.canonicalByKey.set(k, normalized);
		}
		return this.canonicalByKey.get(k)!;
	}

	/**
	 * Prefer settings-canonical spelling (e.g. from a tag file property).
	 * Always stores the configured-separator form so hyphen/underscore/space variants unify.
	 */
	private rememberPreferred(canonical: string): string {
		const normalized = toCanonicalTagName(canonical, this.settings);
		const k = this.key(normalized);
		this.canonicalByKey.set(k, normalized);
		return normalized;
	}

	/** Resolve any tag form to the preferred canonical spelling. */
	private resolve(tagOrKey: string): string {
		const k = this.key(tagOrKey);
		return this.canonicalByKey.get(k) ?? toCanonicalTagName(tagOrKey, this.settings);
	}

	/**
	 * Canonical tag name for storage/application: spaces → separator, case preserved.
	 */
	normalizeTag(tag: string): string {
		return toCanonicalTagName(tag, this.settings);
	}

	/**
	 * Case/separator-insensitive equality.
	 */
	tagsMatch(a: string, b: string): boolean {
		return namesMatch(a, b, this.settings);
	}

	/**
	 * Display name for a tag note basename or folder segment.
	 */
	toDisplayName(tag: string): string {
		return toDisplayName(tag, this.settings);
	}

	/**
	 * Get the tag property value from a file's frontmatter.
	 * Returns null if the property doesn't exist or is empty.
	 */
	getTagPropertyValue(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		return readFrontmatterString(cache, this.settings.tagPropertyName);
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
	 * Sanitize a tag name for use as a filename (filesystem-illegal chars only).
	 * Prefer toDisplayName() when creating note/folder names so separator settings apply.
	 */
	sanitizeTagName(tag: string): string {
		return sanitizeForFilesystem(tag);
	}

	/**
	 * Reverse filesystem sanitization.
	 */
	unsanitizeTagName(filename: string): string {
		return unsanitizeFromFilesystem(filename);
	}

	/**
	 * Get all tags (both used in files and defined as tag files)
	 */
	getAllTags(): string[] {
		const allTags = new Set<string>();
		for (const k of this.tagToFiles.keys()) {
			allTags.add(this.resolve(k));
		}
		for (const k of this.tagToFile.keys()) {
			allTags.add(this.resolve(k));
		}
		return Array.from(allTags);
	}

	/**
	 * Get the tag file for a given tag
	 */
	getTagFile(tag: string): TFile | null {
		return this.tagToFile.get(this.key(tag)) ?? null;
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
		const parents = this.tagParents.get(this.key(tag));
		return parents ? Array.from(parents).map(k => this.resolve(k)) : [];
	}

	/**
	 * Get child tags for a given tag (tags that have this tag as parent)
	 */
	getChildTags(tag: string): string[] {
		const children = this.tagChildren.get(this.key(tag));
		return children ? Array.from(children).map(k => this.resolve(k)) : [];
	}

	/**
	 * Get root tags (tags that have no parents OR are part of a circular chain OR are exclusive)
	 * Circular tags are included as roots so they appear in the explorer
	 * Exclusive tags are included as roots because their children only show under them
	 */
	getRootTags(): string[] {
		const result: string[] = [];
		const allTags = this.getAllTags();
		const circularKeys = new Set(
			Array.from(this.getCircularTags()).map(t => this.key(t))
		);
		
		for (const tag of allTags) {
			const k = this.key(tag);
			const parents = this.tagParents.get(k);
			if (!parents || parents.size === 0 || circularKeys.has(k) || this.exclusiveTags.has(k)) {
				result.push(tag);
			}
		}
		return result.sort((a, b) => a.localeCompare(b));
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
		const k = this.key(tag);
		if (visited.has(k)) {
			return true;
		}
		
		visited.add(k);
		const children = this.tagChildren.get(k);
		
		if (children) {
			for (const childKey of children) {
				if (this.detectCycleFromTag(childKey, new Set(visited))) {
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
		const k = this.key(tag);
		if (path.has(k)) {
			for (const t of path) {
				result.add(this.resolve(t));
			}
			result.add(this.resolve(k));
			return;
		}
		
		path.add(k);
		const children = this.tagChildren.get(k);
		
		if (children) {
			for (const childKey of children) {
				this.collectCycleTags(childKey, new Set(path), result);
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
				this.remember(tagName);
				result.tags.add(this.key(tagName));
			}
		}
		
		return result;
	}

	/**
	 * Get child tags, optionally excluding tags already in the ancestor path (for cycle handling)
	 */
	getChildTagsExcluding(tag: string, excludeAncestors?: Set<string>): string[] {
		const children = this.tagChildren.get(this.key(tag));
		if (!children) return [];
		
		const resolved = Array.from(children).map(k => this.resolve(k));
		if (excludeAncestors) {
			const excludeKeys = new Set(Array.from(excludeAncestors).map(t => this.key(t)));
			return resolved.filter(child => !excludeKeys.has(this.key(child)));
		}
		return resolved;
	}

	/**
	 * Get the tags that a given tag is an exception to.
	 * Exception tags don't show their children under the excepted tags.
	 */
	getExceptionTags(tag: string): string[] {
		const exceptions = this.tagExceptions.get(this.key(tag));
		return exceptions ? Array.from(exceptions).map(k => this.resolve(k)) : [];
	}

	/**
	 * Check if a tag is an exception to a specific other tag.
	 */
	isExceptionTo(tag: string, exceptedTag: string): boolean {
		const exceptions = this.tagExceptions.get(this.key(tag));
		return exceptions ? exceptions.has(this.key(exceptedTag)) : false;
	}

	/**
	 * Check if a tag is exclusive (exception to "all").
	 * Exclusive tags' children only show under the exclusive tag itself.
	 */
	isExclusiveTag(tag: string): boolean {
		return this.exclusiveTags.has(this.key(tag));
	}

	/**
	 * Get all exclusive tags.
	 */
	getExclusiveTags(): string[] {
		return Array.from(this.exclusiveTags).map(k => this.resolve(k));
	}

	/**
	 * Get all files that have a specific tag (excludes registry note)
	 */
	getFilesWithTag(tag: string): TFile[] {
		const files = this.tagToFiles.get(this.key(tag));
		if (!files) return [];
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
			
			for (const tag of readFrontmatterTags(cache)) {
				if (!tag.includes('/')) {
					hasTags = true;
					break;
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
		const seen = new Set<string>();
		
		const addIfMissing = (k: string) => {
			if (!this.tagToFile.has(k) || this.tagToFile.get(k) === null) {
				if (!seen.has(k)) {
					seen.add(k);
					result.push(this.resolve(k));
				}
			}
		};

		for (const k of this.tagToFiles.keys()) {
			addIfMissing(k);
		}
		
		for (const parentKey of this.tagChildren.keys()) {
			addIfMissing(parentKey);
		}
		
		return result;
	}

	/**
	 * Get all tag files that don't have corresponding tags in use
	 */
	getFilesWithoutTags(): TFile[] {
		const result: TFile[] = [];
		for (const [path, tag] of this.fileToTag) {
			const filesWithTag = this.tagToFiles.get(this.key(tag));
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
		const files = this.tagToFiles.get(this.key(tag));
		if (!files) return 0;
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
		for (const [k, files] of this.tagToFiles.entries()) {
			if (files.has(file)) {
				tags.push(this.resolve(k));
			}
		}
		return tags;
	}

	/**
	 * Whether a metadata update would change what the explorer shows.
	 * Opening a file re-parses it and fires metadataCache.changed even when
	 * tags, tag-file identity, exceptions, and attachment links are unchanged.
	 */
	hasExplorerRelevantChanges(file: TFile, cache: CachedMetadata): boolean {
		if (this.isTagRegistryNote(file)) {
			return false;
		}

		const newTagProp = readFrontmatterString(cache, this.settings.tagPropertyName);
		const newTagName = newTagProp ? this.normalizeTag(newTagProp) : null;
		const oldTagName = this.fileToTag.get(file.path) ?? null;
		if (oldTagName === null && newTagName !== null) return true;
		if (oldTagName !== null && newTagName === null) return true;
		if (oldTagName && newTagName && this.key(oldTagName) !== this.key(newTagName)) return true;

		const isTagFile = newTagName !== null;
		const oldTagKeys = new Set<string>();
		for (const [k, files] of this.tagToFiles) {
			for (const indexed of files) {
				if (indexed.path === file.path) {
					oldTagKeys.add(k);
					break;
				}
			}
		}

		const newTagKeys = new Set<string>();
		for (const tag of readFrontmatterTags(cache)) {
			if (!tag.includes('/')) {
				newTagKeys.add(this.key(this.normalizeTag(tag)));
			}
		}
		// Tag files only contribute frontmatter tags (parents) to the index.
		if (!isTagFile && cache.tags) {
			for (const tagCache of cache.tags) {
				let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
				if (tagName.includes('/')) continue;
				newTagKeys.add(this.key(this.normalizeTag(tagName)));
			}
		}

		if (!this.sameStringSet(oldTagKeys, newTagKeys)) return true;

		if (oldTagName || newTagName) {
			const k = this.key((newTagName ?? oldTagName)!);
			const oldExceptions = this.tagExceptions.get(k) ?? new Set<string>();
			const oldExclusive = this.exclusiveTags.has(k);
			const parsed = this.parseExceptionProperty(
				frontmatterRecord(cache)?.[this.settings.exceptionToPropertyName]
			);
			if (oldExclusive !== parsed.isExclusive) return true;
			if (!this.sameStringSet(oldExceptions, parsed.tags)) return true;
		}

		const oldAtt = new Set(
			(this.noteToAttachments.get(file.path) ?? []).map(f => f.path)
		);
		const newAtt = new Set<string>();
		const resolved = this.app.metadataCache.resolvedLinks[file.path] ?? {};
		for (const targetPath of Object.keys(resolved)) {
			const dest = this.app.vault.getAbstractFileByPath(targetPath);
			if (dest instanceof TFile && dest.extension !== 'md') {
				newAtt.add(dest.path);
			}
		}
		if (!this.sameStringSet(oldAtt, newAtt)) return true;

		return false;
	}

	private sameStringSet(a: Set<string>, b: Set<string>): boolean {
		if (a.size !== b.size) return false;
		for (const value of a) {
			if (!b.has(value)) return false;
		}
		return true;
	}

	/**
	 * Rebuild the entire index
	 */
	async rebuild(): Promise<void> {
		// Clear current state
		this.canonicalByKey.clear();
		this.tagToFile.clear();
		this.fileToTag.clear();
		this.tagParents.clear();
		this.tagChildren.clear();
		this.tagToFiles.clear();
		this.tagExceptions.clear();
		this.exclusiveTags.clear();
		this.noteToAttachments.clear();
		this.attachmentReferrers.clear();
		this.tagToFolderAttachments.clear();
		this.folderConnectedAttachmentPaths.clear();

		// Get all markdown files
		const files = this.app.vault.getMarkdownFiles();
		
		// Track tag files by comparison key to handle duplicates (select most recently created)
		const tagFileCandidates: Map<string, { file: TFile; canonical: string }[]> = new Map();
		
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
					const canonical = this.normalizeTag(tagName);
					const k = this.key(canonical);
					
					if (!tagFileCandidates.has(k)) {
						tagFileCandidates.set(k, []);
					}
					tagFileCandidates.get(k)!.push({ file, canonical });
				}
				// Also track the tags used IN this tag file (for parent relationships and unused detection)
				const cache = this.app.metadataCache.getFileCache(file);
				for (const tag of readFrontmatterTags(cache)) {
					if (!tag.includes('/')) {
						const canonical = this.remember(this.normalizeTag(tag));
						const k = this.key(canonical);
						if (!this.tagToFiles.has(k)) {
							this.tagToFiles.set(k, new Set());
						}
						this.tagToFiles.get(k)!.add(file);
					}
				}
				continue;
			}

			// Process as regular file - collect tags
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			const fileTagKeys = new Set<string>();

			for (const tag of readFrontmatterTags(cache)) {
				if (!tag.includes('/')) {
					const canonical = this.remember(this.normalizeTag(tag));
					fileTagKeys.add(this.key(canonical));
				}
			}

			// Get inline tags
			if (cache.tags) {
				for (const tagCache of cache.tags) {
					let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
					if (tagName.includes('/')) {
						continue;
					}
					const canonical = this.remember(this.normalizeTag(tagName));
					fileTagKeys.add(this.key(canonical));
				}
			}

			for (const k of fileTagKeys) {
				if (!this.tagToFiles.has(k)) {
					this.tagToFiles.set(k, new Set());
				}
				this.tagToFiles.get(k)!.add(file);
			}
		}

		// Select the most recently created file for each tag (handle duplicates)
		for (const [k, candidates] of tagFileCandidates) {
			candidates.sort((a, b) => b.file.stat.ctime - a.file.stat.ctime);
			const selected = candidates[0];
			const canonical = this.rememberPreferred(selected.canonical);
			
			this.tagToFile.set(k, selected.file);
			this.fileToTag.set(selected.file.path, canonical);

			const cache = this.app.metadataCache.getFileCache(selected.file);
			const parentTags = readFrontmatterTags(cache);
			if (parentTags.length > 0) {
				const parents = new Set<string>();
				for (const parent of parentTags) {
					const parentCanonical = this.remember(this.normalizeTag(parent));
					const parentKey = this.key(parentCanonical);
					parents.add(parentKey);
					
					if (!this.tagChildren.has(parentKey)) {
						this.tagChildren.set(parentKey, new Set());
					}
					this.tagChildren.get(parentKey)!.add(k);
				}
				this.tagParents.set(k, parents);
			}

			const fm = frontmatterRecord(cache);
			if (fm) {
				const exceptionPropName = this.settings.exceptionToPropertyName;
				const exceptionValue = fm[exceptionPropName];
				if (exceptionValue) {
					const exceptions = this.parseExceptionProperty(exceptionValue);
					if (exceptions.tags.size > 0) {
						this.tagExceptions.set(k, exceptions.tags);
					}
					if (exceptions.isExclusive) {
						this.exclusiveTags.add(k);
					}
				}
			}
		}

		// Also add entries for tags that exist but have null files
		for (const k of this.tagToFiles.keys()) {
			if (!this.tagToFile.has(k)) {
				this.tagToFile.set(k, null);
			}
		}

		const allKeys = new Set<string>();
		for (const k of this.tagToFiles.keys()) {
			allKeys.add(k);
		}
		for (const k of this.tagToFile.keys()) {
			allKeys.add(k);
		}
		
		for (const k of allKeys) {
			if (!this.tagParents.has(k)) {
				this.tagParents.set(k, new Set());
			}
			if (!this.tagChildren.has(k)) {
				this.tagChildren.set(k, new Set());
			}
		}

		this.buildAttachmentIndex();
	}

	/**
	 * Build the attachment maps: which attachments each note references (and the reverse),
	 * plus which attachments live in a folder that maps to a known tag.
	 * Must run after the tag maps are populated so folder-connection can be validated.
	 */
	private buildAttachmentIndex(): void {
		// Reference maps from resolved links (covers both [[links]] and ![[embeds]]).
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		for (const sourcePath of Object.keys(resolvedLinks)) {
			const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') {
				continue;
			}
			const targets = resolvedLinks[sourcePath];
			const attachments: TFile[] = [];
			for (const targetPath of Object.keys(targets)) {
				const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
				if (!(targetFile instanceof TFile) || targetFile.extension === 'md') {
					continue;
				}
				attachments.push(targetFile);
				if (!this.attachmentReferrers.has(targetFile.path)) {
					this.attachmentReferrers.set(targetFile.path, new Set());
				}
				this.attachmentReferrers.get(targetFile.path)!.add(sourceFile);
			}
			if (attachments.length > 0) {
				this.noteToAttachments.set(sourcePath, attachments);
			}
		}

		// Folder-connected attachments: parent folder name resolves to a known tag.
		const knownTagKeys = new Set<string>();
		for (const k of this.tagToFiles.keys()) knownTagKeys.add(k);
		for (const k of this.tagToFile.keys()) knownTagKeys.add(k);

		for (const file of this.app.vault.getFiles()) {
			if (file.extension === 'md') {
				continue;
			}
			const parentPath = file.parent?.path;
			if (!parentPath) {
				continue;
			}
			const folderTag = this.getTagFromFolderPath(parentPath);
			if (!folderTag) {
				continue;
			}
			const k = this.key(folderTag);
			if (!knownTagKeys.has(k)) {
				continue;
			}
			if (!this.tagToFolderAttachments.has(k)) {
				this.tagToFolderAttachments.set(k, new Set());
			}
			this.tagToFolderAttachments.get(k)!.add(file);
			this.folderConnectedAttachmentPaths.add(file.path);
		}
	}

	/**
	 * Get all attachments (non-markdown files) in the vault, sorted by basename.
	 */
	getAllAttachments(): TFile[] {
		return this.app.vault.getFiles()
			.filter(file => file.extension !== 'md')
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/**
	 * Get the attachments (non-markdown files) referenced by a note, sorted by basename.
	 */
	getReferencedAttachments(note: TFile): TFile[] {
		const attachments = this.noteToAttachments.get(note.path);
		if (!attachments) return [];
		return [...attachments].sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/**
	 * Whether an attachment is referenced by at least one markdown note.
	 */
	isAttachmentReferenced(file: TFile): boolean {
		const referrers = this.attachmentReferrers.get(file.path);
		return referrers != null && referrers.size > 0;
	}

	/**
	 * Get attachments whose parent folder maps to the given tag, sorted by basename.
	 */
	getFolderAttachmentsForTag(tag: string): TFile[] {
		const attachments = this.tagToFolderAttachments.get(this.key(tag));
		if (!attachments) return [];
		return [...attachments].sort((a, b) => a.basename.localeCompare(b.basename));
	}

	/**
	 * Whether an attachment lives in a folder that maps to a known tag.
	 */
	isFolderConnectedAttachment(file: TFile): boolean {
		return this.folderConnectedAttachmentPaths.has(file.path);
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
			const canonical = this.rememberPreferred(this.normalizeTag(resolvedTagName));
			this.tagToFile.set(this.key(canonical), file);
			this.fileToTag.set(file.path, canonical);
		}
	}

	/**
	 * Update the index when a tag file is deleted
	 */
	onTagFileDeleted(path: string): void {
		const tagName = this.fileToTag.get(path);
		if (tagName) {
			this.tagToFile.set(this.key(tagName), null);
			this.fileToTag.delete(path);
		}
	}

	/**
	 * Update the index when a tag file's tag property changes
	 */
	onTagPropertyChanged(file: TFile, oldTag: string | null): void {
		if (oldTag) {
			this.tagToFile.set(this.key(oldTag), null);
		}
		this.fileToTag.delete(file.path);

		const newTag = this.fileToTagName(file);
		if (newTag) {
			const canonical = this.rememberPreferred(this.normalizeTag(newTag));
			this.tagToFile.set(this.key(canonical), file);
			this.fileToTag.set(file.path, canonical);
		}
	}

	/**
	 * Update the index when a tag file is renamed (file path changed)
	 */
	onTagFileRenamed(file: TFile, oldPath: string): void {
		const tag = this.fileToTag.get(oldPath);
		if (tag) {
			this.fileToTag.delete(oldPath);
			this.fileToTag.set(file.path, tag);
			this.tagToFile.set(this.key(tag), file);
		}
	}

	/**
	 * Get the first tag from a file's frontmatter tags array.
	 * Only returns flat tags (not Obsidian nested tags with '/').
	 * Returns null if the file has no tags or only nested tags.
	 */
	getFirstTag(file: TFile): string | null {
		const cache = this.app.metadataCache.getFileCache(file);
		for (const tag of readFrontmatterTags(cache)) {
			if (!tag.includes('/')) {
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
		const result: string[] = [];
		for (const tag of readFrontmatterTags(cache)) {
			if (!tag.includes('/')) {
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
