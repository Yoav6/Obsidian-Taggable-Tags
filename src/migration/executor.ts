import { TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { MigrationPlan, PlanOp } from './plan';
import { generateTagFileContent, addTagPropertiesToFile } from '../utils/tag-template';
import { mergeTags } from '../sync/merge-tag';
import { markPluginInitiatedChange } from '../sync/file-rename-sync';
import { toComparisonKey } from '../utils/tag-naming';

export interface ExecutorError {
	step: string;
	message: string;
	file?: string;
}

export interface ExecuteResult {
	errors: ExecutorError[];
	opsApplied: number;
}

export const PROGRESS_STEP_IDS = [
	'conflicts',
	'flatten',
	'tag-files',
	'folder-tags',
	'redundant',
	'remaining-tags',
	'rebuild',
] as const;

export type ProgressStepId = (typeof PROGRESS_STEP_IDS)[number];

export interface ExecuteProgress {
	onStepStart?: (stepId: ProgressStepId) => void;
	onStepComplete?: (stepId: ProgressStepId, hadErrors: boolean) => void;
}

export function progressStepForOp(op: PlanOp): ProgressStepId {
	switch (op.kind) {
		case 'rename-folder':
		case 'rename-file':
		case 'delete-folder':
		case 'delete-file':
		case 'merge-tags':
			return 'conflicts';
		case 'create-tag-note':
		case 'adopt-note-as-tag':
		case 'set-tag-parents':
			if (op.reason.startsWith('Flatten') || op.reason.includes('Flatten nested')) return 'flatten';
			if (op.reason.includes('Remaining')) return 'remaining-tags';
			if (op.reason.includes('keeper')) return 'conflicts';
			return 'tag-files';
		case 'edit-file-tags':
			if (op.reason.includes('Flatten')) return 'flatten';
			if (op.reason.includes('folder tag')) return 'folder-tags';
			if (op.reason.includes('redundant')) return 'redundant';
			if (op.reason.includes('Delete nested')) return 'conflicts';
			return 'flatten';
	}
}

function yieldToUI(): Promise<void> {
	return new Promise(resolve => {
		requestAnimationFrame(() => setTimeout(resolve, 0));
	});
}

/**
 * Apply a migration plan to the vault. Never throws; collects per-op errors.
 */
export async function executePlan(
	plugin: TaggableTagsPlugin,
	plan: MigrationPlan,
	progress?: ExecuteProgress
): Promise<ExecuteResult> {
	const errors: ExecutorError[] = [];
	let opsApplied = 0;
	let currentStep: ProgressStepId | null = null;
	let currentStepHadErrors = false;

	const enterStep = async (step: ProgressStepId) => {
		if (step === currentStep) return;
		if (currentStep) {
			progress?.onStepComplete?.(currentStep, currentStepHadErrors);
		}
		currentStep = step;
		currentStepHadErrors = false;
		progress?.onStepStart?.(step);
		await yieldToUI();
	};

	for (const op of plan.ops) {
		const step = progressStepForOp(op);
		await enterStep(step);
		try {
			await applyOp(plugin, op);
			opsApplied++;
		} catch (error) {
			currentStepHadErrors = true;
			errors.push({
				step,
				message: String(error),
				file: 'path' in op ? (op as { path: string }).path : undefined,
			});
		}
	}

	if (currentStep) {
		progress?.onStepComplete?.(currentStep, currentStepHadErrors);
		currentStep = null;
	}

	await enterStep('rebuild');
	try {
		await plugin.tagIndex.rebuild();
		await plugin.updateTagRegistry();
	} catch (error) {
		currentStepHadErrors = true;
		errors.push({ step: 'rebuild', message: String(error) });
	}
	progress?.onStepComplete?.('rebuild', currentStepHadErrors);

	return { errors, opsApplied };
}

async function applyOp(plugin: TaggableTagsPlugin, op: PlanOp): Promise<void> {
	switch (op.kind) {
		case 'rename-folder':
			await applyRenameFolder(plugin, op.from, op.to);
			break;
		case 'rename-file':
			await applyRenameFile(plugin, op.from, op.to);
			break;
		case 'delete-folder':
			await applyDeleteFolder(plugin, op.path);
			break;
		case 'delete-file':
			await applyDeleteFile(plugin, op.path);
			break;
		case 'create-tag-note':
			await applyCreateTagNote(plugin, op.path, op.tag, op.parents);
			break;
		case 'adopt-note-as-tag':
			await applyAdoptNote(plugin, op.path, op.tag, op.parents);
			break;
		case 'set-tag-parents':
			await applySetTagParents(plugin, op.path, op.tag, op.parents);
			break;
		case 'edit-file-tags':
			await applyEditFileTags(plugin, op);
			break;
		case 'merge-tags':
			await mergeTags(plugin, op.survivor, op.removed);
			break;
	}
}

// A rename that quietly does nothing leaves the vault behind the plan, and every
// later op addressing the new path fails instead. Report it where it happens.
async function applyRenameFolder(plugin: TaggableTagsPlugin, from: string, to: string): Promise<void> {
	const folder = plugin.app.vault.getAbstractFileByPath(from);
	if (!folder) throw new Error(`Folder to rename not found: ${from}`);
	await plugin.app.vault.rename(folder, to);
}

async function applyRenameFile(plugin: TaggableTagsPlugin, from: string, to: string): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(from);
	if (!(file instanceof TFile)) throw new Error(`File to rename not found: ${from}`);
	markPluginInitiatedChange(from);
	await plugin.app.fileManager.renameFile(file, to);
}

async function applyDeleteFolder(plugin: TaggableTagsPlugin, path: string): Promise<void> {
	const folder = plugin.app.vault.getAbstractFileByPath(path);
	if (!folder) return;
	await plugin.app.vault.trash(folder, true);
}

async function applyDeleteFile(plugin: TaggableTagsPlugin, path: string): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;
	markPluginInitiatedChange(path);
	await plugin.app.vault.trash(file, true);
}

async function applyCreateTagNote(
	plugin: TaggableTagsPlugin,
	path: string,
	tag: string,
	parents: string[]
): Promise<void> {
	await applyCreateOrAdopt(plugin, path, tag, parents);
}

async function applyAdoptNote(
	plugin: TaggableTagsPlugin,
	path: string,
	tag: string,
	parents: string[]
): Promise<void> {
	await applyCreateOrAdopt(plugin, path, tag, parents);
}

/**
 * Obsidian's in-memory file index can lag a rename: getAbstractFileByPath(newPath)
 * returns null even though the file is already on disk. Creating then throws
 * "File already exists". Treat any occupant of the path as the tag note.
 */
async function applyCreateOrAdopt(
	plugin: TaggableTagsPlugin,
	path: string,
	tag: string,
	parents: string[]
): Promise<void> {
	const existing = await resolveMarkdownFile(plugin, path);
	if (existing) {
		await addTagPropertiesToFile(plugin, existing, tag, parents);
		plugin.tagIndex.onTagFileCreated(existing, tag);
		return;
	}

	if (await plugin.app.vault.adapter.exists(path)) {
		const retry = await resolveMarkdownFile(plugin, path);
		if (retry) {
			await addTagPropertiesToFile(plugin, retry, tag, parents);
			plugin.tagIndex.onTagFileCreated(retry, tag);
			return;
		}
		throw new Error(
			`File exists on disk but Obsidian has not indexed it yet: ${path}`
		);
	}

	const folderPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
	if (folderPath && !(plugin.app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
		throw new Error(`Cannot place tag note for #${tag}, folder is missing: ${folderPath}`);
	}

	try {
		const content = await generateTagFileContent(plugin, tag, parents);
		const file = await plugin.app.vault.create(path, content);
		plugin.tagIndex.onTagFileCreated(file, tag);
	} catch (error) {
		const message = String(error);
		if (!/already exists/i.test(message)) throw error;
		const occupant = await resolveMarkdownFile(plugin, path);
		if (!occupant) throw error;
		await addTagPropertiesToFile(plugin, occupant, tag, parents);
		plugin.tagIndex.onTagFileCreated(occupant, tag);
	}
}

async function resolveMarkdownFile(plugin: TaggableTagsPlugin, path: string): Promise<TFile | null> {
	const direct = plugin.app.vault.getAbstractFileByPath(path);
	if (direct instanceof TFile) return direct;
	return plugin.app.vault.getMarkdownFiles().find(file => file.path === path) ?? null;
}

async function applySetTagParents(
	plugin: TaggableTagsPlugin,
	path: string,
	tag: string,
	parents: string[]
): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error(`Tag file not found: ${path}`);
	await addTagPropertiesToFile(plugin, file, tag, parents);
}

async function applyEditFileTags(
	plugin: TaggableTagsPlugin,
	op: Extract<PlanOp, { kind: 'edit-file-tags' }>
): Promise<void> {
	const file = plugin.app.vault.getAbstractFileByPath(op.path);
	if (!(file instanceof TFile)) throw new Error(`File not found: ${op.path}`);

	const cache = plugin.app.metadataCache.getFileCache(file);
	const content = await plugin.app.vault.read(file);
	let newContent = content;
	let modified = false;

	// Inline body tags
	for (const rewrite of op.rewrite) {
		if (!rewrite.from.includes('/')) continue;
		const escaped = rewrite.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const inlineRegex = new RegExp(`#${escaped}(?![\\w/\\-])`, 'g');
		if (inlineRegex.test(newContent)) {
			newContent = newContent.replace(inlineRegex, `#${rewrite.to}`);
			modified = true;
		}
	}

	if (modified) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
	}

	// Frontmatter via processFrontMatter. Obsidian refuses to touch frontmatter it
	// cannot parse, so malformed YAML in the note surfaces here as a parse error.
	try {
		await editFrontMatterTags(plugin, file, op);
	} catch (error) {
		throw new Error(
			`Frontmatter could not be parsed, so its tags were left alone. ` +
			`Fix the YAML by hand and re-run migration. Original error: ${String(error)}`
		);
	}

	// Re-read for inline nested tags in frontmatter that processFrontMatter might miss
	if (op.rewrite.some(r => r.from.includes('/'))) {
		const after = await plugin.app.vault.read(file);
		let afterContent = after;
		let afterModified = false;
		for (const rewrite of op.rewrite) {
			const escaped = rewrite.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const fmNested = new RegExp(`(^\\s+-\\s+)${escaped}(\\s*)$`, 'gm');
			if (fmNested.test(afterContent)) {
				afterContent = afterContent.replace(fmNested, `$1${rewrite.to}$2`);
				afterModified = true;
			}
			const inlineArray = new RegExp(
				`(tags:\\s*\\[[^\\]]*?(?:^|[\\[,\\s]))${escaped}(?=[\\],\\s]|$)`,
				'gm'
			);
			if (inlineArray.test(afterContent)) {
				afterContent = afterContent.replace(inlineArray, `$1${rewrite.to}`);
				afterModified = true;
			}
		}
		if (afterModified) {
			markPluginInitiatedChange(file.path);
			await plugin.app.vault.modify(file, afterContent);
		}
	}
}

async function editFrontMatterTags(
	plugin: TaggableTagsPlugin,
	file: TFile,
	op: Extract<PlanOp, { kind: 'edit-file-tags' }>
): Promise<void> {
	await plugin.app.fileManager.processFrontMatter(file, (fm) => {
		let tags = normalizeFmTags(fm.tags);
		if (tags === null && (op.add.length > 0 || op.remove.length > 0 || op.rewrite.length > 0)) {
			tags = [];
		}
		if (tags === null) return;

		tags = tags.map(t => {
			for (const r of op.rewrite) {
				if (plugin.tagIndex.tagsMatch(t, r.from) || t.includes('/')) {
					const key = toComparisonKey(t, plugin.settings);
					const fromKey = toComparisonKey(r.from, plugin.settings);
					if (key === fromKey || t === r.from) {
						return plugin.tagIndex.normalizeTag(r.to);
					}
				}
			}
			return plugin.tagIndex.normalizeTag(t);
		});

		tags = tags.filter(t => !op.remove.some(r => plugin.tagIndex.tagsMatch(r, t)));

		for (const a of op.add) {
			const normalized = plugin.tagIndex.normalizeTag(a);
			if (!tags.some(t => plugin.tagIndex.tagsMatch(t, normalized))) {
				tags.unshift(normalized);
			}
		}

		// Dedupe
		const deduped: string[] = [];
		for (const t of tags) {
			if (!deduped.some(d => plugin.tagIndex.tagsMatch(d, t))) {
				deduped.push(t);
			}
		}

		fm.tags = deduped.length === 0 ? [] : deduped;
	});
}

function normalizeFmTags(tags: unknown): string[] | null {
	if (tags === undefined || tags === null) return null;
	if (typeof tags === 'string') return [tags];
	if (Array.isArray(tags)) {
		return tags.filter((t): t is string => typeof t === 'string');
	}
	return null;
}

export async function createMigrationPlanNote(
	plugin: TaggableTagsPlugin,
	content: string
): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const notePath = `Migration Plan ${timestamp}.md`;
	await plugin.app.vault.create(notePath, content);
	return notePath;
}
