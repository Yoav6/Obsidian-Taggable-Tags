import { TFile, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { createTagFile } from './auto-create';
import { replaceTagEverywhere, markPluginInitiatedChange } from './file-rename-sync';
import { parseFrontmatter, serializeFrontmatter } from '../utils/tag-template';
import { filterSafeParentTags } from '../utils/cycle-prevention';

/**
 * Merge removedTag into survivorTag. The survivor keeps its identity and gains
 * all parents, children, properties, and content from the removed tag, which is deleted.
 */
export async function mergeTags(
	plugin: TaggableTagsPlugin,
	survivorTag: string,
	removedTag: string
): Promise<void> {
	const survivor = plugin.tagIndex.normalizeTag(survivorTag);
	const removed = plugin.tagIndex.normalizeTag(removedTag);

	if (plugin.tagIndex.tagsMatch(survivor, removed)) {
		throw new Error('Cannot merge a tag with itself');
	}

	let survivorFile = plugin.tagIndex.getTagFile(survivor);
	const removedFile = plugin.tagIndex.getTagFile(removed);

	if (!survivorFile) {
		survivorFile = await createTagFile(plugin, survivor);
	}

	if (survivorFile) {
		await mergeTagFileContent(plugin, survivor, removed, survivorFile, removedFile);
	}

	await replaceTagEverywhere(plugin, removed, survivor, survivorFile ?? undefined);
	await dedupeTagInAllFiles(plugin, survivor);

	if (removedFile) {
		markPluginInitiatedChange(removedFile.path);
		await plugin.app.vault.delete(removedFile);
	}

	await plugin.tagIndex.rebuild();
	await plugin.updateTagRegistry();
}

async function mergeTagFileContent(
	plugin: TaggableTagsPlugin,
	survivor: string,
	removed: string,
	survivorFile: TFile,
	removedFile: TFile | null
): Promise<void> {
	const survivorContent = await plugin.app.vault.read(survivorFile);
	const { frontmatter: survivorFm, body: survivorBody } = parseFrontmatter(survivorContent);

	let removedFm: Record<string, unknown> | null = null;
	let removedBody = '';
	if (removedFile) {
		const removedContent = await plugin.app.vault.read(removedFile);
		const parsed = parseFrontmatter(removedContent);
		removedFm = parsed.frontmatter;
		removedBody = parsed.body;
	}

	const mergedFrontmatter = mergeTagFrontmatter(plugin, survivor, removed, survivorFm, removedFm);
	const mergedBody = mergeTagBodies(survivorBody, removedBody);
	const mergedContent = `---\n${serializeFrontmatter(mergedFrontmatter)}\n---\n${mergedBody}`;

	if (mergedContent !== survivorContent) {
		markPluginInitiatedChange(survivorFile.path);
		await plugin.app.vault.modify(survivorFile, mergedContent);
	}
}

function mergeTagFrontmatter(
	plugin: TaggableTagsPlugin,
	survivor: string,
	removed: string,
	survivorFm: Record<string, unknown> | null,
	removedFm: Record<string, unknown> | null
): Record<string, unknown> {
	const propName = plugin.settings.tagPropertyName;
	const exceptionPropName = plugin.settings.exceptionToPropertyName;

	const parentTags = new Set<string>();
	for (const parent of [
		...plugin.tagIndex.getParentTags(survivor),
		...plugin.tagIndex.getParentTags(removed),
	]) {
		if (!plugin.tagIndex.tagsMatch(parent, survivor) && !plugin.tagIndex.tagsMatch(parent, removed)) {
			parentTags.add(plugin.tagIndex.normalizeTag(parent));
		}
	}
	for (const fm of [survivorFm, removedFm]) {
		collectParentTagsFromFrontmatter(plugin, fm, survivor, removed, parentTags);
	}

	const safeParents = filterSafeParentTags(plugin, survivor, Array.from(parentTags));
	const merged: Record<string, unknown> = { [propName]: survivor, tags: safeParents };

	for (const fm of [survivorFm, removedFm]) {
		if (!fm) continue;
		for (const [key, value] of Object.entries(fm)) {
			if (key === propName || key === 'tags') continue;
			if (!(key in merged)) {
				merged[key] = clonePropertyValue(value);
				continue;
			}
			merged[key] = mergePropertyValues(merged[key], value);
		}
	}

	if (!(exceptionPropName in merged)) {
		merged[exceptionPropName] = [];
	}

	return merged;
}

function collectParentTagsFromFrontmatter(
	plugin: TaggableTagsPlugin,
	fm: Record<string, unknown> | null,
	survivor: string,
	removed: string,
	parentTags: Set<string>
): void {
	if (!fm || !Array.isArray(fm.tags)) return;
	for (const tag of fm.tags) {
		if (typeof tag !== 'string') continue;
		const normalized = plugin.tagIndex.normalizeTag(tag);
		if (!plugin.tagIndex.tagsMatch(normalized, survivor) && !plugin.tagIndex.tagsMatch(normalized, removed)) {
			parentTags.add(normalized);
		}
	}
}

function clonePropertyValue(value: unknown): unknown {
	if (Array.isArray(value)) return [...value];
	return value;
}

function mergePropertyValues(existing: unknown, incoming: unknown): unknown {
	if (Array.isArray(existing) && Array.isArray(incoming)) {
		const merged = [...existing];
		for (const item of incoming) {
			if (!merged.some(existingItem => JSON.stringify(existingItem) === JSON.stringify(item))) {
				merged.push(item);
			}
		}
		return merged;
	}
	return existing;
}

function mergeTagBodies(survivorBody: string, removedBody: string): string {
	const survivor = survivorBody.trim();
	const removed = removedBody.trim();
	if (!survivor) return removed;
	if (!removed) return survivor;
	return `${survivor}\n\n${removed}`;
}

async function dedupeTagInAllFiles(plugin: TaggableTagsPlugin, tag: string): Promise<void> {
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		await dedupeTagInFile(plugin, file, tag);
	}
}

async function dedupeTagInFile(plugin: TaggableTagsPlugin, file: TFile, tag: string): Promise<boolean> {
	const content = await plugin.app.vault.read(file);
	const { frontmatter, body } = parseFrontmatter(content);
	if (!frontmatter || !Array.isArray(frontmatter.tags)) return false;

	const deduped: string[] = [];
	for (const entry of frontmatter.tags) {
		if (typeof entry !== 'string') continue;
		if (deduped.some(existing => plugin.tagIndex.tagsMatch(existing, entry))) continue;
		deduped.push(entry);
	}

	if (deduped.length === frontmatter.tags.length) return false;

	frontmatter.tags = deduped;
	const newContent = `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`;
	markPluginInitiatedChange(file.path);
	await plugin.app.vault.modify(file, newContent);
	return true;
}

export function describeMergeTags(plugin: TaggableTagsPlugin, survivorTag: string, removedTag: string): string {
	const survivor = plugin.tagIndex.normalizeTag(survivorTag);
	const removed = plugin.tagIndex.normalizeTag(removedTag);
	const survivorParents = plugin.tagIndex.getParentTags(survivor);
	const removedParents = plugin.tagIndex.getParentTags(removed);
	const survivorChildren = plugin.tagIndex.getChildTags(survivor);
	const removedChildren = plugin.tagIndex.getChildTags(removed);
	const survivorFiles = plugin.tagIndex.getFilesWithTag(survivor).length;
	const removedFiles = plugin.tagIndex.getFilesWithTag(removed).length;
	const survivorHasFile = plugin.tagIndex.getTagFile(survivor) !== null;
	const removedHasFile = plugin.tagIndex.getTagFile(removed) !== null;

	const parts = [
		`#${removed} will be completely removed from the vault.`,
		`#${survivor} will keep its name and tag file${survivorHasFile || removedHasFile ? '' : ' (created if needed)'}.`,
	];

	if (removedParents.length > 0 || survivorParents.length > 0) {
		const allParents = new Set([...survivorParents, ...removedParents]);
		parts.push(`Parent tags (${Array.from(allParents).map(t => `#${t}`).join(', ')}) will apply to #${survivor}.`);
	}

	const childCount = new Set([...survivorChildren, ...removedChildren]).size;
	if (childCount > 0) {
		parts.push(`Child tag relationships (${childCount} tag${childCount === 1 ? '' : 's'}) will point to #${survivor} instead of #${removed}.`);
	}

	const fileCount = survivorFiles + removedFiles;
	if (fileCount > 0) {
		parts.push(`References in ${fileCount} note${fileCount === 1 ? '' : 's'} will use #${survivor}.`);
	}

	if (removedHasFile) {
		parts.push(`Properties and content from the #${removed} tag file will be merged into #${survivor}'s tag file.`);
	}

	return parts.join(' ');
}

export async function performMergeTags(
	plugin: TaggableTagsPlugin,
	survivorTag: string,
	removedTag: string
): Promise<void> {
	try {
		await mergeTags(plugin, survivorTag, removedTag);
		new Notice(`Merged #${plugin.tagIndex.normalizeTag(removedTag)} into #${plugin.tagIndex.normalizeTag(survivorTag)}`);
	} catch (error) {
		console.error('Failed to merge tags:', error);
		new Notice(`Failed to merge tags: ${error}`);
		throw error;
	}
}
