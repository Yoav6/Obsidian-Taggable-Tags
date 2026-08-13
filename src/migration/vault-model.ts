import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { namesMatch, toComparisonKey } from '../utils/tag-naming';
import { isInExcludedFolder, isExcludedFolderPath } from '../sync/folder-sync';

export interface ModelFolder {
	path: string;
	name: string;
	parentPath: string;
	excluded: boolean;
}

export interface ModelFile {
	path: string;
	basename: string;
	extension: string;
	parentPath: string;
	/** Canonical tag name if this is a tag note */
	tagName: string | null;
	/** Frontmatter tags (canonical) */
	tags: string[];
	/** Raw frontmatter tag spellings as stored in YAML */
	rawTags: string[];
	/** Inline body tags (canonical), without # */
	inlineTags: string[];
	/** Raw inline tag spellings as they appear in the body */
	rawInlineTags: string[];
	excluded: boolean;
	isTagRegistry: boolean;
}

/**
 * In-memory snapshot of the vault for migration planning.
 * Mutators update this model so later phases see prior decisions.
 */
export class VaultModel {
	readonly folders = new Map<string, ModelFolder>();
	readonly files = new Map<string, ModelFile>();
	/** tag comparison key -> canonical tag name */
	readonly tagNames = new Map<string, string>();
	/** tag comparison key -> tag note file path */
	readonly tagToFile = new Map<string, string>();
	/** tag comparison key -> parent tag comparison keys */
	readonly tagParents = new Map<string, Set<string>>();
	/** tag comparison key -> child tag comparison keys */
	readonly tagChildren = new Map<string, Set<string>>();
	/** file path -> set of tag comparison keys used in that file */
	readonly fileTags = new Map<string, Set<string>>();

	constructor(
		private readonly plugin: TaggableTagsPlugin,
		readonly excludedFolders: string[]
	) {}

	static fromVault(plugin: TaggableTagsPlugin, excludedFolders: string[]): VaultModel {
		const model = new VaultModel(plugin, excludedFolders);
		model.snapshot();
		return model;
	}

	private tagKey(tag: string): string {
		return toComparisonKey(tag, this.plugin.settings);
	}

	normalizeTag(tag: string): string {
		return this.plugin.tagIndex.normalizeTag(tag);
	}

	tagsMatch(a: string, b: string): boolean {
		return this.plugin.tagIndex.tagsMatch(a, b);
	}

	toDisplayName(tag: string): string {
		return this.plugin.tagIndex.toDisplayName(tag);
	}

	getTagFromFolderPath(folderPath: string): string | null {
		if (!folderPath) return null;
		const parts = folderPath.split('/').filter(Boolean);
		if (parts.length === 0) return null;
		return this.normalizeTag(parts[parts.length - 1]);
	}

	snapshot(): void {
		this.folders.clear();
		this.files.clear();
		this.tagNames.clear();
		this.tagToFile.clear();
		this.tagParents.clear();
		this.tagChildren.clear();
		this.fileTags.clear();

		const root = this.plugin.app.vault.getRoot();
		this.walkFolder(root);

		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			this.addFile(file);
		}

		this.rebuildTagGraph();
	}

	private walkFolder(folder: TFolder): void {
		if (!folder.isRoot()) {
			this.folders.set(folder.path, {
				path: folder.path,
				name: folder.name,
				parentPath: folder.parent?.path ?? '',
				excluded: isExcludedFolderPath(this.plugin, folder.path),
			});
		}
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				this.walkFolder(child);
			}
		}
	}

	private addFile(file: TFile): void {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const propName = this.plugin.settings.tagPropertyName;
		const tagName = this.plugin.tagIndex.getTagForFilePath(file.path)
			?? (this.plugin.tagIndex.isTagFile(file) ? this.plugin.tagIndex.fileToTagName(file) : null);

		const tags: string[] = [];
		const rawTags: string[] = [];
		const inlineTags: string[] = [];
		const rawInlineTags: string[] = [];
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				for (const t of fmTags) {
					if (typeof t === 'string') {
						if (t.includes('/')) {
							rawInlineTags.push(t);
							inlineTags.push(this.normalizeTag(t.split('/').pop() ?? t));
						} else {
							rawTags.push(t);
							tags.push(this.normalizeTag(t));
						}
					}
				}
			} else if (typeof fmTags === 'string') {
				if (fmTags.includes('/')) {
					rawInlineTags.push(fmTags);
					inlineTags.push(this.normalizeTag(fmTags.split('/').pop() ?? fmTags));
				} else {
					rawTags.push(fmTags);
					tags.push(this.normalizeTag(fmTags));
				}
			}
		}

		if (cache?.tags) {
			for (const tc of cache.tags) {
				let raw = tc.tag.startsWith('#') ? tc.tag.slice(1) : tc.tag;
				if (raw.includes('/')) {
					rawInlineTags.push(raw);
					inlineTags.push(this.normalizeTag(raw.split('/').pop() ?? raw));
				} else {
					rawInlineTags.push(raw);
					inlineTags.push(this.normalizeTag(raw));
				}
			}
		}

		this.files.set(file.path, {
			path: file.path,
			basename: file.basename,
			extension: file.extension,
			parentPath: file.parent?.path ?? '',
			tagName: tagName ? this.normalizeTag(tagName) : null,
			tags,
			rawTags,
			inlineTags,
			rawInlineTags,
			excluded: isInExcludedFolder(this.plugin, file),
			isTagRegistry: this.plugin.tagIndex.isTagRegistryNote(file),
		});
	}

	private rememberTag(tag: string): string {
		const canonical = this.normalizeTag(tag);
		const key = this.tagKey(canonical);
		if (!this.tagNames.has(key)) {
			this.tagNames.set(key, canonical);
		}
		return this.tagNames.get(key)!;
	}

	private rebuildTagGraph(): void {
		this.tagParents.clear();
		this.tagChildren.clear();
		this.fileTags.clear();
		this.tagToFile.clear();

		for (const file of this.files.values()) {
			if (file.isTagRegistry || file.excluded) continue;

			if (file.tagName) {
				const key = this.tagKey(file.tagName);
				this.tagToFile.set(key, file.path);
				this.rememberTag(file.tagName);
			}

			const fileTagKeys = new Set<string>();
			for (const t of [...file.tags, ...file.inlineTags]) {
				const canonical = this.rememberTag(t);
				fileTagKeys.add(this.tagKey(canonical));
			}
			this.fileTags.set(file.path, fileTagKeys);

			if (file.tagName) {
				const selfKey = this.tagKey(file.tagName);
				const parents = new Set<string>();
				for (const t of file.tags) {
					if (this.tagsMatch(t, file.tagName)) continue;
					const pKey = this.tagKey(this.rememberTag(t));
					parents.add(pKey);
					if (!this.tagChildren.has(pKey)) {
						this.tagChildren.set(pKey, new Set());
					}
					this.tagChildren.get(pKey)!.add(selfKey);
				}
				this.tagParents.set(selfKey, parents);
			}
		}
	}

	getFolder(path: string): ModelFolder | undefined {
		return this.folders.get(path);
	}

	getFile(path: string): ModelFile | undefined {
		return this.files.get(path);
	}

	getTagFile(tag: string): string | null {
		return this.tagToFile.get(this.tagKey(tag)) ?? null;
	}

	getAllTags(): string[] {
		const seen = new Set<string>();
		const result: string[] = [];
		for (const key of this.tagNames.keys()) {
			if (!seen.has(key)) {
				seen.add(key);
				result.push(this.tagNames.get(key)!);
			}
		}
		for (const keys of this.fileTags.values()) {
			for (const k of keys) {
				if (!seen.has(k)) {
					seen.add(k);
					result.push(this.tagNames.get(k)!);
				}
			}
		}
		return result;
	}

	getTagsWithoutFiles(): string[] {
		const result: string[] = [];
		const seen = new Set<string>();
		for (const key of this.tagNames.keys()) {
			if (!this.tagToFile.has(key) && !seen.has(key)) {
				seen.add(key);
				result.push(this.tagNames.get(key)!);
			}
		}
		for (const keys of this.fileTags.values()) {
			for (const k of keys) {
				if (!this.tagToFile.has(k) && !seen.has(k)) {
					seen.add(k);
					result.push(this.tagNames.get(k)!);
				}
			}
		}
		return result;
	}

	getParentTags(tag: string): string[] {
		const parents = this.tagParents.get(this.tagKey(tag));
		if (!parents) return [];
		return Array.from(parents).map(k => this.tagNames.get(k)!);
	}

	getChildTags(tag: string): string[] {
		const children = this.tagChildren.get(this.tagKey(tag));
		if (!children) return [];
		return Array.from(children).map(k => this.tagNames.get(k)!);
	}

	getAllTagsFromFile(path: string): string[] {
		const file = this.files.get(path);
		if (!file) return [];
		const result: string[] = [];
		const seen = new Set<string>();
		for (const t of [...file.tags, ...file.inlineTags]) {
			const key = this.tagKey(t);
			if (!seen.has(key)) {
				seen.add(key);
				result.push(t);
			}
		}
		return result;
	}

	findFoldersWithLeafTag(tagName: string): ModelFolder[] {
		const result: ModelFolder[] = [];
		for (const folder of this.folders.values()) {
			if (folder.excluded) continue;
			const leaf = this.getTagFromFolderPath(folder.path);
			if (leaf && this.tagsMatch(leaf, tagName)) {
				result.push(folder);
			}
		}
		return result;
	}

	findMatchingFileInFolder(folderPath: string, tagName: string): ModelFile | null {
		const folder = this.folders.get(folderPath);
		if (!folder) return null;
		for (const file of this.files.values()) {
			if (file.parentPath !== folderPath) continue;
			if (file.tagName) continue;
			if (namesMatch(file.basename, tagName, this.plugin.settings)) {
				return file;
			}
		}
		return null;
	}

	/**
	 * Any markdown file in the folder whose basename matches `name`, including tag notes.
	 * Placement uses this so we don't try to create a second note next to one that already exists.
	 */
	findNamedFileInFolder(folderPath: string, name: string): ModelFile | null {
		if (!this.folders.get(folderPath)) return null;
		for (const file of this.files.values()) {
			if (file.parentPath !== folderPath) continue;
			if (namesMatch(file.basename, name, this.plugin.settings)) {
				return file;
			}
		}
		return null;
	}

	findMatchingNonTagFile(tagName: string, opts?: { parentPath?: string; directChildOnly?: boolean }): ModelFile | null {
		for (const file of this.files.values()) {
			if (file.tagName) continue;
			if (!namesMatch(file.basename, tagName, this.plugin.settings)) continue;
			if (opts?.parentPath) {
				if (opts.directChildOnly) {
					if (file.parentPath !== opts.parentPath) continue;
				} else if (!file.path.startsWith(opts.parentPath + '/') && file.parentPath !== opts.parentPath) {
					continue;
				}
			}
			return file;
		}
		return null;
	}

	folderDepth(path: string): number {
		return path.split('/').filter(Boolean).length;
	}

	isFolderUnder(folderPath: string, ancestorPath: string): boolean {
		return folderPath === ancestorPath || folderPath.startsWith(ancestorPath + '/');
	}

	renameFolder(oldPath: string, newName: string): string | null {
		const folder = this.folders.get(oldPath);
		if (!folder) return null;
		const parentPath = folder.parentPath;
		const newPath = parentPath ? `${parentPath}/${newName}` : newName;
		if (this.folders.has(newPath)) return null;

		const updated: ModelFolder = { ...folder, path: newPath, name: newName, parentPath };
		this.folders.delete(oldPath);
		this.folders.set(newPath, updated);

		for (const f of [...this.folders.values()]) {
			if (f.path.startsWith(oldPath + '/')) {
				const child = this.folders.get(f.path)!;
				const rel = f.path.slice(oldPath.length + 1);
				const childNewPath = `${newPath}/${rel}`;
				this.folders.delete(f.path);
				child.path = childNewPath;
				child.parentPath = childNewPath.includes('/')
					? childNewPath.slice(0, childNewPath.lastIndexOf('/'))
					: '';
				this.folders.set(childNewPath, child);
			}
		}

		for (const file of [...this.files.values()]) {
			if (file.path.startsWith(oldPath + '/') || file.parentPath === oldPath) {
				const rel = file.path.startsWith(oldPath + '/')
					? file.path.slice(oldPath.length + 1)
					: file.basename + '.' + file.extension;
				const newFilePath = file.parentPath === oldPath && !file.path.startsWith(oldPath + '/')
					? `${newPath}/${file.basename}.${file.extension}`
					: `${newPath}/${rel}`;
				this.moveFileRecord(file.path, newFilePath);
			}
		}

		return newPath;
	}

	deleteFolder(path: string): boolean {
		if (!this.folders.has(path)) return false;
		for (const folderPath of [...this.folders.keys()]) {
			if (folderPath === path || folderPath.startsWith(path + '/')) {
				this.folders.delete(folderPath);
			}
		}
		for (const filePath of [...this.files.keys()]) {
			const file = this.files.get(filePath)!;
			if (file.path.startsWith(path + '/') || file.parentPath === path) {
				this.removeFileRecord(filePath);
			}
		}
		return true;
	}

	deleteFile(path: string): boolean {
		if (!this.files.has(path)) return false;
		this.removeFileRecord(path);
		return true;
	}

	private removeFileRecord(path: string): void {
		const file = this.files.get(path);
		if (!file) return;
		if (file.tagName) {
			const key = this.tagKey(file.tagName);
			this.tagToFile.delete(key);
			this.tagNames.delete(key);
			this.tagParents.delete(key);
			this.tagChildren.delete(key);
		}
		this.files.delete(path);
		this.fileTags.delete(path);
	}

	renameFile(oldPath: string, newBasename: string): string | null {
		const file = this.files.get(oldPath);
		if (!file) return null;
		const newPath = file.parentPath
			? `${file.parentPath}/${newBasename}.${file.extension}`
			: `${newBasename}.${file.extension}`;
		if (this.files.has(newPath)) return null;
		this.moveFileRecord(oldPath, newPath);
		const updated = this.files.get(newPath)!;
		updated.basename = newBasename;
		return newPath;
	}

	private moveFileRecord(oldPath: string, newPath: string): void {
		const file = this.files.get(oldPath);
		if (!file) return;
		file.path = newPath;
		file.parentPath = newPath.includes('/')
			? newPath.slice(0, newPath.lastIndexOf('/'))
			: '';
		file.basename = newPath.slice(newPath.lastIndexOf('/') + 1, newPath.lastIndexOf('.'));
		this.files.delete(oldPath);
		this.files.set(newPath, file);
		if (this.fileTags.has(oldPath)) {
			this.fileTags.set(newPath, this.fileTags.get(oldPath)!);
			this.fileTags.delete(oldPath);
		}
		if (file.tagName) {
			this.tagToFile.set(this.tagKey(file.tagName), newPath);
		}
	}

	setFileTagNote(path: string, tagName: string, parents: string[]): void {
		const file = this.files.get(path);
		if (!file) return;
		const canonical = this.normalizeTag(tagName);
		const oldKey = file.tagName ? this.tagKey(file.tagName) : null;
		if (oldKey && this.tagToFile.get(oldKey) === path) {
			this.tagToFile.delete(oldKey);
		}
		file.tagName = canonical;
		file.tags = parents.map(p => this.normalizeTag(p));
		file.rawTags = [...file.tags];
		this.tagToFile.set(this.tagKey(canonical), path);
		this.rememberTag(canonical);
		this.rebuildTagGraph();
	}

	createTagNote(path: string, tagName: string, parents: string[]): void {
		const canonical = this.normalizeTag(tagName);
		const parentPath = path.includes('/')
			? path.slice(0, path.lastIndexOf('/'))
			: '';
		const basename = path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));
		this.files.set(path, {
			path,
			basename,
			extension: 'md',
			parentPath,
			tagName: canonical,
			tags: parents.map(p => this.normalizeTag(p)),
			rawTags: parents.map(p => this.normalizeTag(p)),
			inlineTags: [],
			rawInlineTags: [],
			excluded: false,
			isTagRegistry: false,
		});
		this.tagToFile.set(this.tagKey(canonical), path);
		this.rememberTag(canonical);
		this.rebuildTagGraph();
	}

	setTagParents(tagName: string, parents: string[]): void {
		const path = this.getTagFile(tagName);
		if (!path) return;
		const file = this.files.get(path);
		if (!file) return;
		file.tags = parents.map(p => this.normalizeTag(p));
		file.rawTags = [...file.tags];
		this.rebuildTagGraph();
	}

	editFileTags(
		path: string,
		add: string[],
		remove: string[],
		rewrite: Array<{ from: string; to: string }>
	): void {
		const file = this.files.get(path);
		if (!file) return;

		const rewriteMap = new Map<string, string>();
		for (const r of rewrite) {
			rewriteMap.set(this.tagKey(r.from), this.normalizeTag(r.to));
		}

		const applyRewrite = (t: string): string => {
			const key = this.tagKey(t);
			return rewriteMap.has(key) ? rewriteMap.get(key)! : this.normalizeTag(t);
		};

		file.tags = file.tags
			.map(applyRewrite)
			.filter(t => !remove.some(r => this.tagsMatch(r, t)))
			.filter(t => !add.some(a => this.tagsMatch(a, t)));
		for (const a of add) {
			if (!file.tags.some(t => this.tagsMatch(t, a))) {
				file.tags.unshift(this.normalizeTag(a));
			}
		}

		file.rawTags = file.tags.map(t => t);
		file.inlineTags = file.inlineTags
			.map(applyRewrite)
			.filter(t => !remove.some(r => this.tagsMatch(r, t)));
		for (const a of add) {
			if (!file.inlineTags.some(t => this.tagsMatch(t, a))) {
				file.inlineTags.push(this.normalizeTag(a));
			}
		}
		file.rawInlineTags = file.inlineTags.map(t => t);

		this.rebuildTagGraph();
	}

	mergeTags(survivor: string, removed: string): void {
		const survivorKey = this.tagKey(survivor);
		const removedKey = this.tagKey(removed);
		const survivorCanonical = this.rememberTag(survivor);
		const removedCanonical = this.rememberTag(removed);

		const removedPath = this.tagToFile.get(removedKey);
		const survivorPath = this.tagToFile.get(survivorKey);

		const mergedParents = new Set<string>();
		for (const p of [...this.getParentTags(survivorCanonical), ...this.getParentTags(removedCanonical)]) {
			if (!this.tagsMatch(p, survivorCanonical) && !this.tagsMatch(p, removedCanonical)) {
				mergedParents.add(this.normalizeTag(p));
			}
		}

		if (survivorPath) {
			const file = this.files.get(survivorPath)!;
			file.tags = Array.from(mergedParents);
			file.rawTags = [...file.tags];
		}

		if (removedPath && removedPath !== survivorPath) {
			const file = this.files.get(removedPath)!;
			file.tagName = null;
			this.tagToFile.delete(removedKey);
			this.files.delete(removedPath);
			this.fileTags.delete(removedPath);
		}

		for (const [fPath, file] of this.files) {
			const allTags = [...file.tags, ...file.inlineTags];
			let changed = false;
			const newTags = file.tags.map(t => {
				if (this.tagsMatch(t, removedCanonical)) {
					changed = true;
					return survivorCanonical;
				}
				return t;
			});
			const newInline = file.inlineTags.map(t => {
				if (this.tagsMatch(t, removedCanonical)) {
					changed = true;
					return survivorCanonical;
				}
				return t;
			});
			if (changed) {
				file.tags = [...new Set(newTags.map(t => this.normalizeTag(t)))];
				file.inlineTags = [...new Set(newInline.map(t => this.normalizeTag(t)))];
				file.rawTags = [...file.tags];
				file.rawInlineTags = [...file.inlineTags];
			}
		}

		this.tagNames.delete(removedKey);
		this.rebuildTagGraph();
	}

	getEmptyFolders(): ModelFolder[] {
		const empty: ModelFolder[] = [];
		const wouldDelete = new Set<string>();
		const sorted = [...this.folders.values()].sort(
			(a, b) => this.folderDepth(b.path) - this.folderDepth(a.path)
		);
		for (const folder of sorted) {
			if (folder.excluded) continue;
			const children = [...this.folders.values(), ...this.files.values()].filter(
				item => {
					const p = 'parentPath' in item ? item.parentPath : '';
					return p === folder.path;
				}
			).filter(item => {
				const p = 'path' in item ? item.path : '';
				return !wouldDelete.has(p);
			});
			if (children.length === 0) {
				empty.push(folder);
				wouldDelete.add(folder.path);
			}
		}
		return empty;
	}

	findNestedTags(): Array<{ fullTag: string; rawFullTag: string; levels: string[]; files: string[] }> {
		const result = new Map<string, { fullTag: string; rawFullTag: string; levels: string[]; files: Set<string> }>();

		for (const file of this.files.values()) {
			if (file.isTagRegistry || file.excluded) continue;

			const addNested = (raw: string) => {
				if (!raw.includes('/')) return;
				const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw;
				const levels = withoutHash.split('/').map(l => this.normalizeTag(l));
				const normalized = levels.join('/');
				if (!result.has(normalized)) {
					result.set(normalized, {
						fullTag: normalized,
						rawFullTag: withoutHash,
						levels,
						files: new Set(),
					});
				}
				result.get(normalized)!.files.add(file.path);
			};

			for (const raw of file.rawInlineTags) {
				addNested(raw);
			}
		}

		return [...result.values()].map(r => ({
			fullTag: r.fullTag,
			rawFullTag: r.rawFullTag,
			levels: r.levels,
			files: [...r.files],
		}));
	}
}
