import { Notice, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { ExistingFileBehavior } from '../settings';
import { previewEmptyFolders } from '../sync/folder-sync';
import { MigrationSettingsModal } from '../ui/migration-settings-modal';
import { MigrationReviewModal } from '../ui/migration-review-modal';
import { BackupReminderModal } from '../ui/backup-reminder-modal';
import { EmptyFoldersModal } from '../ui/empty-folders-modal';
import { MigrationProgressModal, MigrationStep } from '../ui/migration-progress-modal';
import {
	detectNamingConflicts,
	detectDisambiguationConflicts,
	mergeConflictResults,
	hasConflicts,
	NamingConflict,
	ConflictResolution,
} from '../migration/conflict-detector';
import { buildMigrationPlan } from '../migration/planner';
import { executePlan, progressStepForOp, PROGRESS_STEP_IDS } from '../migration/executor';
import type { MigrationPlan } from '../migration/plan';

/**
 * Settings that the user can configure for migration.
 */
export interface MigrationSettings {
	removeRedundantParentTags: boolean;
	flattenNestedTags: boolean;
	enableFolderSyncAfter: boolean;
	excludedFolders: string[];
}

export const RECOMMENDED_MIGRATION_SETTINGS: MigrationSettings = {
	removeRedundantParentTags: true,
	flattenNestedTags: true,
	enableFolderSyncAfter: false,
	excludedFolders: [],
};

interface ForcedSettings {
	existingFileBehavior: ExistingFileBehavior;
	keepOriginalFolderTag: 'always';
	autoCreateFiles: boolean;
	syncFoldersWithTags: boolean;
	confirmUnusedTagDeletion: boolean;
}

const FORCED_DURING_MIGRATION: ForcedSettings = {
	existingFileBehavior: 'auto',
	keepOriginalFolderTag: 'always',
	autoCreateFiles: false,
	syncFoldersWithTags: false,
	confirmUnusedTagDeletion: false,
};

/**
 * Main entry point for the migrate vault command.
 */
export async function migrateVault(plugin: TaggableTagsPlugin): Promise<void> {
	const backupModal = new BackupReminderModal(plugin);
	const proceedAfterBackup = await backupModal.prompt();
	if (!proceedAfterBackup) return;

	const settingsModal = new MigrationSettingsModal(plugin);
	const migrationSettings = await settingsModal.prompt();
	if (!migrationSettings) return;

	let plan: MigrationPlan | null = null;
	let reviewModal: MigrationReviewModal | null = null;

	new Notice('Detecting naming conflicts...');
	let conflictResult = detectNamingConflicts(plugin, migrationSettings.flattenNestedTags);
	const disambiguation = detectDisambiguationConflicts(plugin);
	conflictResult = mergeConflictResults(conflictResult, disambiguation, plugin);

	// Conflicts <-> preview loop (single modal, multiple pages)
	while (true) {
		let resolvedConflicts: Map<NamingConflict, ConflictResolution[]>;

		if (hasConflicts(conflictResult)) {
			if (!reviewModal) {
				reviewModal = new MigrationReviewModal(plugin, migrationSettings, conflictResult);
			}
			const resolutions = await reviewModal.waitForConflictsContinue();
			if (!resolutions) {
				reviewModal.closeReview();
				return;
			}
			resolvedConflicts = resolutions;
		} else {
			if (!reviewModal) {
				reviewModal = new MigrationReviewModal(plugin, migrationSettings);
				reviewModal.showGenerating();
				reviewModal.open();
			}
			resolvedConflicts = conflictResult.resolutions;
		}

		const previewResult = await reviewModal.buildAndShowPreview(() =>
			buildMigrationPlan(plugin, {
				settings: migrationSettings,
				resolvedConflicts,
			})
		);

		if (previewResult === 'apply') {
			plan = reviewModal.getPlan();
			break;
		}
		if (previewResult === 'cancel') {
			reviewModal.closeReview();
			return;
		}
		// 'back' — return to conflicts page in the same modal (resolutions preserved)
	}

	reviewModal?.closeReview();

	if (!plan) return;

	const emptyFolders = await applyMigration(plugin, migrationSettings, plan);

	if (emptyFolders.length > 0) {
		const emptyFoldersModal = new EmptyFoldersModal(plugin, emptyFolders);
		const result = await emptyFoldersModal.prompt();
		if (result) {
			const parts: string[] = [];
			if (result.foldersDeleted > 0) parts.push(`${result.foldersDeleted} folders deleted`);
			if (result.tagFilesCreated > 0) parts.push(`${result.tagFilesCreated} tag files created`);
			if (parts.length > 0) {
				new Notice(`Empty folders: ${parts.join(', ')}`);
			}
		}
	}
}

async function applyMigration(
	plugin: TaggableTagsPlugin,
	settings: MigrationSettings,
	plan: MigrationPlan
): Promise<TFolder[]> {
	const steps: MigrationStep[] = [
		{ id: 'conflicts', name: 'Resolving naming conflicts', status: 'pending' },
		{ id: 'flatten', name: 'Flattening nested tags', status: 'pending' },
		{ id: 'tag-files', name: 'Creating tag files for folders', status: 'pending' },
		{ id: 'folder-tags', name: 'Adding folder tags to files', status: 'pending' },
		{ id: 'redundant', name: 'Removing redundant tags', status: 'pending' },
		{ id: 'remaining-tags', name: 'Creating tag files for remaining tags', status: 'pending' },
		{ id: 'rebuild', name: 'Rebuilding tag index', status: 'pending' },
	];

	const progressModal = new MigrationProgressModal(plugin, steps);
	const progressPromise = progressModal.start();

	const originalSettings = {
		existingFileBehavior: plugin.settings.existingFileBehavior,
		keepOriginalFolderTag: plugin.settings.keepOriginalFolderTag,
		autoCreateFiles: plugin.settings.autoCreateFiles,
		removeRedundantParentTags: plugin.settings.removeRedundantParentTags,
		emptyFolderBehavior: plugin.settings.emptyFolderBehavior,
		syncFoldersWithTags: plugin.settings.syncFoldersWithTags,
		confirmUnusedTagDeletion: plugin.settings.confirmUnusedTagDeletion,
	};

	plugin.settings.existingFileBehavior = FORCED_DURING_MIGRATION.existingFileBehavior;
	plugin.settings.keepOriginalFolderTag = FORCED_DURING_MIGRATION.keepOriginalFolderTag;
	plugin.settings.autoCreateFiles = FORCED_DURING_MIGRATION.autoCreateFiles;
	plugin.settings.syncFoldersWithTags = FORCED_DURING_MIGRATION.syncFoldersWithTags;
	plugin.settings.confirmUnusedTagDeletion = FORCED_DURING_MIGRATION.confirmUnusedTagDeletion;
	plugin.settings.removeRedundantParentTags = settings.removeRedundantParentTags;
	plugin.settings.emptyFolderBehavior = 'nothing';

	const usedSteps = new Set(plan.ops.map(progressStepForOp));
	usedSteps.add('rebuild');
	for (const stepId of PROGRESS_STEP_IDS) {
		if (!usedSteps.has(stepId)) progressModal.skipStep(stepId);
	}

	const result = await executePlan(plugin, plan, {
		onStepStart: stepId => progressModal.startStep(stepId),
		onStepComplete: (stepId, hadErrors) => progressModal.completeStep(stepId, hadErrors),
	});

	for (const error of result.errors) {
		progressModal.addError(error.step, error.message, error.file);
	}

	if (settings.enableFolderSyncAfter) {
		plugin.settings.syncFoldersWithTags = true;
	}

	const emptyFolders = plan.emptyFolders
		.map(p => plugin.app.vault.getAbstractFileByPath(p))
		.filter((f): f is TFolder => f instanceof TFolder);

	plugin.settings.existingFileBehavior = originalSettings.existingFileBehavior;
	plugin.settings.keepOriginalFolderTag = originalSettings.keepOriginalFolderTag;
	plugin.settings.autoCreateFiles = originalSettings.autoCreateFiles;
	plugin.settings.emptyFolderBehavior = originalSettings.emptyFolderBehavior;
	plugin.settings.confirmUnusedTagDeletion = originalSettings.confirmUnusedTagDeletion;
	if (!settings.enableFolderSyncAfter) {
		plugin.settings.syncFoldersWithTags = originalSettings.syncFoldersWithTags;
	}
	await plugin.saveSettings();

	let errorNotePath: string | undefined;
	if (progressModal.hasErrors()) {
		errorNotePath = await createMigrationErrorNote(plugin, progressModal.getErrors());
	}

	progressModal.setComplete(errorNotePath);
	await progressPromise;

	return emptyFolders.length > 0 ? emptyFolders : previewEmptyFolders(plugin);
}

async function createMigrationErrorNote(
	plugin: TaggableTagsPlugin,
	errors: Array<{ step: string; message: string; file?: string }>
): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const notePath = `Migration Errors ${timestamp}.md`;

	const errorsByStep = new Map<string, Array<{ message: string; file?: string }>>();
	for (const error of errors) {
		if (!errorsByStep.has(error.step)) errorsByStep.set(error.step, []);
		errorsByStep.get(error.step)!.push({ message: error.message, file: error.file });
	}

	const stepNames: Record<string, string> = {
		conflicts: 'Resolving naming conflicts',
		flatten: 'Flattening nested tags',
		'tag-files': 'Creating tag files for folders',
		'folder-tags': 'Adding folder tags to files',
		redundant: 'Removing redundant tags',
		'remaining-tags': 'Creating tag files for remaining tags',
		rebuild: 'Rebuilding tag index',
	};

	let content = `# Migration Errors\n\n`;
	content += `Migration completed on ${new Date().toLocaleString()} with ${errors.length} error${errors.length === 1 ? '' : 's'}.\n\n`;
	content += `---\n\n`;

	for (const [step, stepErrors] of errorsByStep) {
		content += `## ${stepNames[step] || step}\n\n`;
		for (const error of stepErrors) {
			content += error.file
				? `- **${error.file}**: ${error.message}\n`
				: `- ${error.message}\n`;
		}
		content += `\n`;
	}

	await plugin.app.vault.create(notePath, content);
	return notePath;
}
