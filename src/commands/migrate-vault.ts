import { Notice, TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { FolderTagBehavior, ExistingFileBehavior } from '../settings';
import { flattenNestedTags } from './flatten-nested-tags';
import { 
	ensureFilesHaveFolderTags, 
	previewFilesNeedingFolderTags,
	previewEmptyFolders,
	isInExcludedFolder,
	isExcludedFolderPath
} from '../sync/folder-sync';
import { 
	removeRedundantParentTags, 
	previewRedundantParentTags 
} from '../utils/tag-ordering';
import { generateTagFileContent, addTagPropertiesToFile } from '../utils/tag-template';
import { namesMatch } from '../utils/name-matching';
import { MigrationSettingsModal } from '../ui/migration-settings-modal';
import { MigrationPreviewModal } from '../ui/migration-preview-modal';
import { BackupReminderModal } from '../ui/backup-reminder-modal';
import { ConflictResolutionModal } from '../ui/conflict-resolution-modal';
import { EmptyFoldersModal } from '../ui/empty-folders-modal';
import { MigrationProgressModal, MigrationStep } from '../ui/migration-progress-modal';
import { 
	detectNamingConflicts, 
	hasConflicts, 
	applyConflictResolutions,
	NamingConflict,
	ConflictResolution,
	countRenames
} from '../migration/conflict-detector';

/**
 * Settings that the user can configure for migration.
 */
export interface MigrationSettings {
	removeRedundantParentTags: boolean;
	flattenNestedTags: boolean;
	enableFolderSyncAfter: boolean;
	excludedFolders: string[];
}

/**
 * Recommended defaults for migration settings.
 */
export const RECOMMENDED_MIGRATION_SETTINGS: MigrationSettings = {
	removeRedundantParentTags: true,
	flattenNestedTags: true,
	enableFolderSyncAfter: false,
	excludedFolders: [], // Will be populated from current plugin settings
};

/**
 * Settings that are temporarily forced during migration.
 * These prevent modal spam and race conditions.
 */
interface ForcedSettings {
	existingFileBehavior: ExistingFileBehavior;
	keepOriginalFolderTag: FolderTagBehavior;
	autoCreateFiles: boolean;
	syncFoldersWithTags: boolean;
}

const FORCED_DURING_MIGRATION: ForcedSettings = {
	existingFileBehavior: 'auto', // Always use existing files (no modal)
	keepOriginalFolderTag: 'always', // Always keep original tags (no modal)
	autoCreateFiles: false, // Don't auto-create to prevent race conditions
	syncFoldersWithTags: false, // Disable folder sync to prevent event handler interference
};

/**
 * Preview of what the migration will do.
 */
export interface MigrationPreview {
	conflictsToResolve: number;
	tagFilesToCreate: Array<{ tagName: string; fromExisting: TFile | null; parentTag: string | null }>;
	tagsToAdd: Array<{ file: TFile; folderTag: string }>;
	redundantTagsToRemove: Array<{ file: TFile; tags: string[] }>;
	nestedTagsToFlatten: Array<{ tag: string; levels: string[] }>;
	emptyFolders: TFolder[];
}

/**
 * Main entry point for the migrate vault command.
 * Runs a multi-step wizard: backup reminder -> settings -> conflict detection -> preview -> apply -> empty folders.
 */
export async function migrateVault(plugin: TaggableTagsPlugin): Promise<void> {
	// Step 1: Show backup reminder
	const backupModal = new BackupReminderModal(plugin);
	const proceedAfterBackup = await backupModal.prompt();
	
	if (!proceedAfterBackup) {
		return; // User cancelled
	}
	
	// Step 2: Show settings configuration
	const settingsModal = new MigrationSettingsModal(plugin);
	const migrationSettings = await settingsModal.prompt();
	
	if (!migrationSettings) {
		return; // User cancelled
	}
	
	// Step 3: Detect naming conflicts
	new Notice('Detecting naming conflicts...');
	const conflictResult = detectNamingConflicts(plugin, migrationSettings.flattenNestedTags);
	
	let resolvedConflicts: Map<NamingConflict, ConflictResolution[]> | null = null;
	
	if (hasConflicts(conflictResult)) {
		// Show conflict resolution modal
		const conflictModal = new ConflictResolutionModal(plugin, conflictResult);
		resolvedConflicts = await conflictModal.prompt();
		
		if (!resolvedConflicts) {
			return; // User cancelled
		}
	}
	
	// Step 4: Generate and show preview
	new Notice('Generating migration preview...');
	const preview = await generateMigrationPreview(plugin, migrationSettings, resolvedConflicts);
	
	const previewModal = new MigrationPreviewModal(plugin, preview, migrationSettings);
	const shouldApply = await previewModal.prompt();
	
	if (!shouldApply) {
		return; // User cancelled
	}
	
	// Step 5: Apply migration with progress modal
	// Migration always completes - errors are tracked and shown, but it never stops halfway
	const emptyFolders = await applyMigration(plugin, migrationSettings, resolvedConflicts);
	
	// Step 6: Show empty folders modal if there are any
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

/**
 * Generate a preview of what the migration will do.
 */
export async function generateMigrationPreview(
	plugin: TaggableTagsPlugin,
	settings: MigrationSettings,
	resolvedConflicts: Map<NamingConflict, ConflictResolution[]> | null
): Promise<MigrationPreview> {
	const preview: MigrationPreview = {
		conflictsToResolve: resolvedConflicts ? countRenames(resolvedConflicts) : 0,
		tagFilesToCreate: [],
		tagsToAdd: [],
		redundantTagsToRemove: [],
		nestedTagsToFlatten: [],
		emptyFolders: [],
	};
	
	// Preview nested tags to flatten (must happen first)
	if (settings.flattenNestedTags) {
		preview.nestedTagsToFlatten = findNestedTagsToFlatten(plugin);
	}
	
	// Preview tag files to create for folders
	preview.tagFilesToCreate = previewTagFilesForFolders(plugin, settings.excludedFolders);
	
	// Preview files that need folder tags
	const filesNeedingTags = previewFilesNeedingFolderTags(plugin);
	preview.tagsToAdd = filesNeedingTags;
	
	// Preview redundant tags to remove (after considering what would be added)
	if (settings.removeRedundantParentTags) {
		preview.redundantTagsToRemove = previewAllRedundantTags(plugin);
	}
	
	// Preview empty folders (will be shown in post-migration modal)
	preview.emptyFolders = previewEmptyFolders(plugin);
	
	return preview;
}

/**
 * Apply the migration with the given settings.
 * Returns the list of empty folders for post-migration handling.
 * 
 * IMPORTANT: This function continues even if individual operations fail.
 * Errors are collected and reported at the end, but migration never stops halfway.
 */
async function applyMigration(
	plugin: TaggableTagsPlugin,
	settings: MigrationSettings,
	resolvedConflicts: Map<NamingConflict, ConflictResolution[]> | null
): Promise<TFolder[]> {
	// Define migration steps
	const steps: MigrationStep[] = [
		{ id: 'conflicts', name: 'Resolving naming conflicts', status: 'pending' },
		{ id: 'flatten', name: 'Flattening nested tags', status: 'pending' },
		{ id: 'tag-files', name: 'Creating tag files for folders', status: 'pending' },
		{ id: 'folder-tags', name: 'Adding folder tags to files', status: 'pending' },
		{ id: 'redundant', name: 'Removing redundant parent tags', status: 'pending' },
		{ id: 'rebuild', name: 'Rebuilding tag index', status: 'pending' },
	];
	
	// Open progress modal
	const progressModal = new MigrationProgressModal(plugin, steps);
	// Don't await - we want to run migration while modal is open
	const progressPromise = progressModal.start();
	
	// Save original settings
	const originalSettings = {
		existingFileBehavior: plugin.settings.existingFileBehavior,
		keepOriginalFolderTag: plugin.settings.keepOriginalFolderTag,
		autoCreateFiles: plugin.settings.autoCreateFiles,
		removeRedundantParentTags: plugin.settings.removeRedundantParentTags,
		emptyFolderBehavior: plugin.settings.emptyFolderBehavior,
		syncFoldersWithTags: plugin.settings.syncFoldersWithTags,
	};
	
	// Apply forced settings during migration
	plugin.settings.existingFileBehavior = FORCED_DURING_MIGRATION.existingFileBehavior;
	plugin.settings.keepOriginalFolderTag = FORCED_DURING_MIGRATION.keepOriginalFolderTag;
	plugin.settings.autoCreateFiles = FORCED_DURING_MIGRATION.autoCreateFiles;
	plugin.settings.syncFoldersWithTags = FORCED_DURING_MIGRATION.syncFoldersWithTags;
	plugin.settings.removeRedundantParentTags = settings.removeRedundantParentTags;
	plugin.settings.emptyFolderBehavior = 'nothing'; // Handle in post-migration modal
	
	let emptyFolders: TFolder[] = [];
	
	// Step 1: Apply conflict resolutions (renames)
	let conflictErrors = 0;
	if (resolvedConflicts && countRenames(resolvedConflicts) > 0) {
		progressModal.startStep('conflicts');
		const result = await applyConflictResolutionsSafe(plugin, resolvedConflicts, progressModal);
		conflictErrors = result.errors;
		progressModal.completeStep('conflicts', conflictErrors > 0);
	} else {
		progressModal.skipStep('conflicts');
	}
	
	// Step 2: Flatten nested tags FIRST
	let flattenErrors = 0;
	if (settings.flattenNestedTags) {
		progressModal.startStep('flatten');
		flattenErrors = await flattenNestedTagsSafe(plugin, progressModal);
		progressModal.completeStep('flatten', flattenErrors > 0);
	} else {
		progressModal.skipStep('flatten');
	}
	
	// Step 3: Create tag files for all folders
	progressModal.startStep('tag-files');
	const tagFileResult = await createTagFilesForAllFoldersSafe(plugin, settings.excludedFolders, progressModal);
	progressModal.completeStep('tag-files', tagFileResult.errors > 0);
	
	// Step 4: Ensure files have folder tags
	progressModal.startStep('folder-tags');
	const folderTagResult = await ensureFilesHaveFolderTagsSafe(plugin, progressModal);
	progressModal.completeStep('folder-tags', folderTagResult.errors > 0);
	
	// Step 5: Remove redundant parent tags AFTER flattening
	let redundantErrors = 0;
	if (settings.removeRedundantParentTags) {
		progressModal.startStep('redundant');
		redundantErrors = await removeAllRedundantParentTagsSafe(plugin, progressModal);
		progressModal.completeStep('redundant', redundantErrors > 0);
	} else {
		progressModal.skipStep('redundant');
	}
	
	// Step 6: Rebuild index (this should always work)
	progressModal.startStep('rebuild');
	try {
		await plugin.tagIndex.rebuild();
		await plugin.updateTagRegistry();
		progressModal.completeStep('rebuild');
	} catch (error) {
		progressModal.addError('rebuild', 'Failed to rebuild tag index: ' + String(error));
		progressModal.completeStep('rebuild', true);
	}
	
	// Optionally enable folder sync going forward
	if (settings.enableFolderSyncAfter) {
		plugin.settings.syncFoldersWithTags = true;
	}
	
	// Get empty folders for post-migration modal
	emptyFolders = previewEmptyFolders(plugin);
	
	// Restore original settings
	plugin.settings.existingFileBehavior = originalSettings.existingFileBehavior;
	plugin.settings.keepOriginalFolderTag = originalSettings.keepOriginalFolderTag;
	plugin.settings.autoCreateFiles = originalSettings.autoCreateFiles;
	plugin.settings.emptyFolderBehavior = originalSettings.emptyFolderBehavior;
	// Restore syncFoldersWithTags unless user chose to enable it after migration
	if (!settings.enableFolderSyncAfter) {
		plugin.settings.syncFoldersWithTags = originalSettings.syncFoldersWithTags;
	}
	
	await plugin.saveSettings();
	
	// Create error report note if there were errors
	let errorNotePath: string | undefined;
	if (progressModal.hasErrors()) {
		errorNotePath = await createMigrationErrorNote(plugin, progressModal.getErrors());
	}
	
	// Mark migration as complete
	progressModal.setComplete(errorNotePath);
	
	// Wait for user to click Continue in progress modal
	await progressPromise;
	
	return emptyFolders;
}

/**
 * Create a note with all migration errors.
 */
async function createMigrationErrorNote(
	plugin: TaggableTagsPlugin,
	errors: Array<{ step: string; message: string; file?: string }>
): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const notePath = `Migration Errors ${timestamp}.md`;
	
	// Group errors by step
	const errorsByStep = new Map<string, Array<{ message: string; file?: string }>>();
	for (const error of errors) {
		if (!errorsByStep.has(error.step)) {
			errorsByStep.set(error.step, []);
		}
		errorsByStep.get(error.step)!.push({ message: error.message, file: error.file });
	}
	
	// Step ID to human-readable name
	const stepNames: Record<string, string> = {
		'conflicts': 'Resolving naming conflicts',
		'flatten': 'Flattening nested tags',
		'tag-files': 'Creating tag files for folders',
		'folder-tags': 'Adding folder tags to files',
		'redundant': 'Removing redundant parent tags',
		'rebuild': 'Rebuilding tag index',
	};
	
	// Build the note content
	let content = `# Migration Errors\n\n`;
	content += `Migration completed on ${new Date().toLocaleString()} with ${errors.length} error${errors.length === 1 ? '' : 's'}.\n\n`;
	content += `Review each error below and fix manually if needed. Delete this note when done.\n\n`;
	content += `---\n\n`;
	
	for (const [step, stepErrors] of errorsByStep) {
		const stepName = stepNames[step] || step;
		content += `## ${stepName}\n\n`;
		
		for (const error of stepErrors) {
			if (error.file) {
				content += `- **${error.file}**: ${error.message}\n`;
			} else {
				content += `- ${error.message}\n`;
			}
		}
		content += `\n`;
	}
	
	await plugin.app.vault.create(notePath, content);
	return notePath;
}

/**
 * Apply conflict resolutions with error handling for each operation.
 */
async function applyConflictResolutionsSafe(
	plugin: TaggableTagsPlugin,
	resolutions: Map<NamingConflict, ConflictResolution[]>,
	progressModal: MigrationProgressModal
): Promise<{ renamed: number; errors: number }> {
	let renamed = 0;
	let errors = 0;
	
	for (const [conflict, conflictResolutions] of resolutions) {
		for (const resolution of conflictResolutions) {
			if (resolution.keepsOriginalName) continue;
			
			try {
				const result = await applyConflictResolutions(plugin, new Map([[conflict, [resolution]]]));
				renamed += result;
			} catch (error) {
				errors++;
				const source = resolution.source;
				const path = source.folder?.path || source.existingTagFile?.path || 'unknown';
				progressModal.addError('conflicts', `Failed to rename: ${String(error)}`, path);
			}
		}
	}
	
	return { renamed, errors };
}

/**
 * Flatten nested tags with error handling.
 */
async function flattenNestedTagsSafe(
	plugin: TaggableTagsPlugin,
	progressModal: MigrationProgressModal
): Promise<number> {
	try {
		await flattenNestedTags(plugin);
		return 0;
	} catch (error) {
		progressModal.addError('flatten', `Failed to flatten nested tags: ${String(error)}`);
		return 1;
	}
}

/**
 * Create tag files for all folders with error handling for each folder.
 */
async function createTagFilesForAllFoldersSafe(
	plugin: TaggableTagsPlugin,
	excludedFolders: string[],
	progressModal: MigrationProgressModal
): Promise<{ created: number; errors: number }> {
	let created = 0;
	let errors = 0;
	const root = plugin.app.vault.getRoot();
	
	async function processFolder(folder: TFolder): Promise<void> {
		if (folder.isRoot()) {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					await processFolder(child);
				}
			}
			return;
		}
		
		// Check if excluded
		const isExcluded = excludedFolders.some(ef => 
			folder.path === ef || folder.path.startsWith(ef + '/')
		);
		if (isExcluded) return;
		
		// Check if this folder needs a tag file
		const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
		if (tagName) {
			const existingTagFile = plugin.tagIndex.getTagFile(tagName);
			if (!existingTagFile) {
				try {
					// Determine parent tag
					const parentFolder = folder.parent;
					const parentTag = parentFolder && !parentFolder.isRoot()
						? plugin.tagIndex.getTagFromFolderPath(parentFolder.path)
						: null;
					
					// Check for existing file with matching name
					const matchingFile = findMatchingFileInFolderForMigration(plugin, folder, tagName);
					if (matchingFile) {
						await addTagPropertiesToFile(plugin, matchingFile, tagName, parentTag);
						plugin.tagIndex.onTagFileCreated(matchingFile, tagName);
					} else {
						// Create new tag file
						const filePath = `${folder.path}/${tagName}.md`;
						const content = await generateTagFileContent(plugin, tagName, parentTag);
						const file = await plugin.app.vault.create(filePath, content);
						plugin.tagIndex.onTagFileCreated(file, tagName);
					}
					created++;
				} catch (error) {
					errors++;
					progressModal.addError('tag-files', `Failed to create tag file: ${String(error)}`, folder.path);
				}
			}
		}
		
		// Process children
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				await processFolder(child);
			}
		}
	}
	
	await processFolder(root);
	return { created, errors };
}

/**
 * Ensure files have folder tags with error handling for each file.
 */
async function ensureFilesHaveFolderTagsSafe(
	plugin: TaggableTagsPlugin,
	progressModal: MigrationProgressModal
): Promise<{ tagsAdded: number; errors: number }> {
	let tagsAdded = 0;
	let errors = 0;
	
	try {
		const result = await ensureFilesHaveFolderTags(plugin);
		tagsAdded = result.tagsAdded;
	} catch (error) {
		errors++;
		progressModal.addError('folder-tags', `Failed to add folder tags: ${String(error)}`);
	}
	
	return { tagsAdded, errors };
}

/**
 * Remove redundant parent tags with error handling.
 */
async function removeAllRedundantParentTagsSafe(
	plugin: TaggableTagsPlugin,
	progressModal: MigrationProgressModal
): Promise<number> {
	let errors = 0;
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		if (plugin.tagIndex.isTagFile(file)) continue;
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		if (isInExcludedFolder(plugin, file)) continue;
		
		try {
			await removeRedundantParentTags(plugin, file);
		} catch (error) {
			errors++;
			progressModal.addError('redundant', `Failed to remove redundant tags: ${String(error)}`, file.path);
		}
	}
	
	return errors;
}

/**
 * Find a file in a folder with a name matching the tag name (for migration).
 */
function findMatchingFileInFolderForMigration(plugin: TaggableTagsPlugin, folder: TFolder, tagName: string): TFile | null {
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		if (plugin.tagIndex.isTagFile(child)) continue;
		
		if (namesMatch(child.basename, tagName)) {
			return child;
		}
	}
	return null;
}

/**
 * Find all nested tags that would be flattened.
 */
function findNestedTagsToFlatten(plugin: TaggableTagsPlugin): Array<{ tag: string; levels: string[] }> {
	const result: Array<{ tag: string; levels: string[] }> = [];
	const files = plugin.app.vault.getMarkdownFiles();
	const seenTags = new Set<string>();
	
	for (const file of files) {
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		
		const cache = plugin.app.metadataCache.getFileCache(file);
		if (!cache) continue;
		
		// Check frontmatter tags
		if (cache.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			if (Array.isArray(fmTags)) {
				for (const tag of fmTags) {
					if (typeof tag === 'string' && tag.includes('/') && !seenTags.has(tag)) {
						seenTags.add(tag);
						result.push({ tag, levels: tag.split('/') });
					}
				}
			}
		}
		
		// Check inline tags
		if (cache.tags) {
			for (const tagCache of cache.tags) {
				let tagName = tagCache.tag.startsWith('#') ? tagCache.tag.slice(1) : tagCache.tag;
				if (tagName.includes('/') && !seenTags.has(tagName)) {
					seenTags.add(tagName);
					result.push({ tag: tagName, levels: tagName.split('/') });
				}
			}
		}
	}
	
	return result;
}

/**
 * Preview which tag files would be created for folders.
 */
function previewTagFilesForFolders(
	plugin: TaggableTagsPlugin,
	excludedFolders: string[]
): Array<{ tagName: string; fromExisting: TFile | null; parentTag: string | null }> {
	const result: Array<{ tagName: string; fromExisting: TFile | null; parentTag: string | null }> = [];
	const root = plugin.app.vault.getRoot();
	
	function processFolder(folder: TFolder): void {
		// Skip root and excluded folders
		if (folder.isRoot()) {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					processFolder(child);
				}
			}
			return;
		}
		
		if (isExcludedFolderPath(plugin, folder.path)) {
			return;
		}
		
		// Check if this folder needs a tag file
		const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
		if (tagName) {
			const existingTagFile = plugin.tagIndex.getTagFile(tagName);
			if (!existingTagFile) {
				// Check for existing file with matching name
				const matchingFile = findMatchingFileInFolder(plugin, folder, tagName);
				const parentFolder = folder.parent;
				const parentTag = parentFolder && !parentFolder.isRoot() 
					? plugin.tagIndex.getTagFromFolderPath(parentFolder.path) 
					: null;
				
				result.push({
					tagName,
					fromExisting: matchingFile,
					parentTag,
				});
			}
		}
		
		// Process children
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				processFolder(child);
			}
		}
	}
	
	processFolder(root);
	return result;
}

/**
 * Find a file in a folder with a name matching the tag name.
 */
function findMatchingFileInFolder(plugin: TaggableTagsPlugin, folder: TFolder, tagName: string): TFile | null {
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== 'md') continue;
		if (plugin.tagIndex.isTagFile(child)) continue;
		
		if (namesMatch(child.basename, tagName)) {
			return child;
		}
	}
	return null;
}

/**
 * Preview all redundant parent tags across the vault.
 */
function previewAllRedundantTags(plugin: TaggableTagsPlugin): Array<{ file: TFile; tags: string[] }> {
	const result: Array<{ file: TFile; tags: string[] }> = [];
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		if (plugin.tagIndex.isTagFile(file)) continue;
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		if (isInExcludedFolder(plugin, file)) continue;
		
		const redundantTags = previewRedundantParentTags(plugin, file);
		if (redundantTags.length > 0) {
			result.push({ file, tags: redundantTags });
		}
	}
	
	return result;
}

/**
 * Create tag files for all folders that don't have one.
 */
async function createTagFilesForAllFolders(
	plugin: TaggableTagsPlugin,
	excludedFolders: string[]
): Promise<number> {
	let count = 0;
	const root = plugin.app.vault.getRoot();
	
	async function processFolder(folder: TFolder): Promise<void> {
		if (folder.isRoot()) {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					await processFolder(child);
				}
			}
			return;
		}
		
		// Check if excluded
		const isExcluded = excludedFolders.some(ef => 
			folder.path === ef || folder.path.startsWith(ef + '/')
		);
		if (isExcluded) return;
		
		// Check if this folder needs a tag file
		const tagName = plugin.tagIndex.getTagFromFolderPath(folder.path);
		if (tagName) {
			const existingTagFile = plugin.tagIndex.getTagFile(tagName);
			if (!existingTagFile) {
				// Determine parent tag
				const parentFolder = folder.parent;
				const parentTag = parentFolder && !parentFolder.isRoot()
					? plugin.tagIndex.getTagFromFolderPath(parentFolder.path)
					: null;
				
				// Check for existing file with matching name
				const matchingFile = findMatchingFileInFolder(plugin, folder, tagName);
				if (matchingFile) {
					await addTagPropertiesToFile(plugin, matchingFile, tagName, parentTag);
					plugin.tagIndex.onTagFileCreated(matchingFile, tagName);
				} else {
					// Create new tag file
					const filePath = `${folder.path}/${tagName}.md`;
					const content = await generateTagFileContent(plugin, tagName, parentTag);
					const file = await plugin.app.vault.create(filePath, content);
					plugin.tagIndex.onTagFileCreated(file, tagName);
				}
				count++;
			}
		}
		
		// Process children
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				await processFolder(child);
			}
		}
	}
	
	await processFolder(root);
	return count;
}

/**
 * Remove redundant parent tags from all files in the vault.
 */
async function removeAllRedundantParentTags(plugin: TaggableTagsPlugin): Promise<number> {
	let count = 0;
	const files = plugin.app.vault.getMarkdownFiles();
	
	for (const file of files) {
		if (plugin.tagIndex.isTagFile(file)) continue;
		if (plugin.tagIndex.isTagRegistryNote(file)) continue;
		if (isInExcludedFolder(plugin, file)) continue;
		
		const removed = await removeRedundantParentTags(plugin, file);
		count += removed.length;
	}
	
	return count;
}
