import { Notice, TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { TaggableTagsSettings, FolderTagBehavior, ExistingFileBehavior } from '../settings';
import { flattenNestedTags } from './flatten-nested-tags';
import { 
	ensureFilesHaveFolderTags, 
	previewFilesNeedingFolderTags,
	cleanupEmptyFolders,
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

/**
 * Settings that the user can configure for migration.
 */
export interface MigrationSettings {
	removeRedundantParentTags: boolean;
	deleteEmptyFolders: boolean;
	flattenNestedTags: boolean;
	enableFolderSyncAfter: boolean;
	excludedFolders: string[];
}

/**
 * Recommended defaults for migration settings.
 */
export const RECOMMENDED_MIGRATION_SETTINGS: MigrationSettings = {
	removeRedundantParentTags: true,
	deleteEmptyFolders: true,
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
}

const FORCED_DURING_MIGRATION: ForcedSettings = {
	existingFileBehavior: 'auto', // Always use existing files (no modal)
	keepOriginalFolderTag: 'always', // Always keep original tags (no modal)
	autoCreateFiles: false, // Don't auto-create to prevent race conditions
};

/**
 * Preview of what the migration will do.
 */
export interface MigrationPreview {
	tagFilesToCreate: Array<{ tagName: string; fromExisting: TFile | null; parentTag: string | null }>;
	tagsToAdd: Array<{ file: TFile; folderTag: string }>;
	redundantTagsToRemove: Array<{ file: TFile; tags: string[] }>;
	nestedTagsToFlatten: Array<{ tag: string; levels: string[] }>;
	emptyFoldersToDelete: TFolder[];
}

/**
 * Main entry point for the migrate vault command.
 * Runs a multi-step wizard: backup reminder -> settings -> preview -> apply.
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
	
	// Step 3: Generate and show preview
	new Notice('Generating migration preview...');
	const preview = await generateMigrationPreview(plugin, migrationSettings);
	
	const previewModal = new MigrationPreviewModal(plugin, preview, migrationSettings);
	const shouldApply = await previewModal.prompt();
	
	if (!shouldApply) {
		return; // User cancelled or went back
	}
	
	// Step 4: Apply migration
	await applyMigration(plugin, migrationSettings);
}

/**
 * Generate a preview of what the migration will do.
 */
export async function generateMigrationPreview(
	plugin: TaggableTagsPlugin,
	settings: MigrationSettings
): Promise<MigrationPreview> {
	const preview: MigrationPreview = {
		tagFilesToCreate: [],
		tagsToAdd: [],
		redundantTagsToRemove: [],
		nestedTagsToFlatten: [],
		emptyFoldersToDelete: [],
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
	
	// Preview empty folders to delete
	if (settings.deleteEmptyFolders) {
		preview.emptyFoldersToDelete = previewEmptyFolders(plugin);
	}
	
	return preview;
}

/**
 * Apply the migration with the given settings.
 */
async function applyMigration(
	plugin: TaggableTagsPlugin,
	settings: MigrationSettings
): Promise<void> {
	// Save original settings
	const originalSettings = {
		existingFileBehavior: plugin.settings.existingFileBehavior,
		keepOriginalFolderTag: plugin.settings.keepOriginalFolderTag,
		autoCreateFiles: plugin.settings.autoCreateFiles,
		removeRedundantParentTags: plugin.settings.removeRedundantParentTags,
		deleteEmptyFoldersAfterSync: plugin.settings.deleteEmptyFoldersAfterSync,
	};
	
	// Apply forced settings during migration
	plugin.settings.existingFileBehavior = FORCED_DURING_MIGRATION.existingFileBehavior;
	plugin.settings.keepOriginalFolderTag = FORCED_DURING_MIGRATION.keepOriginalFolderTag;
	plugin.settings.autoCreateFiles = FORCED_DURING_MIGRATION.autoCreateFiles;
	plugin.settings.removeRedundantParentTags = settings.removeRedundantParentTags;
	plugin.settings.deleteEmptyFoldersAfterSync = settings.deleteEmptyFolders;
	
	try {
		new Notice('Starting migration...');
		
		let stats = {
			tagFilesCreated: 0,
			tagsAdded: 0,
			redundantTagsRemoved: 0,
			nestedTagsFlattened: 0,
			emptyFoldersDeleted: 0,
		};
		
		// Step 1: Flatten nested tags FIRST
		// This creates tag files for nested tag levels and must happen before folder tag files
		if (settings.flattenNestedTags) {
			new Notice('Flattening nested tags...');
			await flattenNestedTags(plugin);
			// Note: flattenNestedTags shows its own notice with counts
		}
		
		// Step 2: Create tag files for all folders
		// Now checks for existing tag files (including those just created by flatten)
		new Notice('Creating tag files for folders...');
		stats.tagFilesCreated = await createTagFilesForAllFolders(plugin, settings.excludedFolders);
		
		// Step 3: Ensure files have folder tags
		new Notice('Adding folder tags to files...');
		const tagResult = await ensureFilesHaveFolderTags(plugin);
		stats.tagsAdded = tagResult.tagsAdded;
		
		// Step 4: Remove redundant parent tags AFTER flattening
		// Flattening may have added parent tags that are now redundant
		if (settings.removeRedundantParentTags) {
			new Notice('Removing redundant parent tags...');
			stats.redundantTagsRemoved = await removeAllRedundantParentTags(plugin);
		}
		
		// Step 5: Clean up empty folders
		if (settings.deleteEmptyFolders) {
			new Notice('Cleaning up empty folders...');
			stats.emptyFoldersDeleted = await cleanupEmptyFolders(plugin);
		}
		
		// Step 6: Optionally enable folder sync going forward
		if (settings.enableFolderSyncAfter) {
			plugin.settings.syncFoldersWithTags = true;
		}
		
		// Step 7: Rebuild index
		await plugin.tagIndex.rebuild();
		await plugin.updateTagRegistry();
		
		// Show summary
		const parts: string[] = [];
		if (stats.tagFilesCreated > 0) parts.push(`${stats.tagFilesCreated} tag files created`);
		if (stats.tagsAdded > 0) parts.push(`${stats.tagsAdded} tags added`);
		if (stats.redundantTagsRemoved > 0) parts.push(`${stats.redundantTagsRemoved} redundant tags removed`);
		if (stats.emptyFoldersDeleted > 0) parts.push(`${stats.emptyFoldersDeleted} empty folders deleted`);
		
		if (parts.length > 0) {
			new Notice(`Migration complete: ${parts.join(', ')}`);
		} else {
			new Notice('Migration complete: no changes needed');
		}
		
	} finally {
		// Restore original settings (except the ones user chose to keep)
		plugin.settings.existingFileBehavior = originalSettings.existingFileBehavior;
		plugin.settings.keepOriginalFolderTag = originalSettings.keepOriginalFolderTag;
		plugin.settings.autoCreateFiles = originalSettings.autoCreateFiles;
		// Keep the user's choices for these:
		// - removeRedundantParentTags (user chose during migration)
		// - deleteEmptyFoldersAfterSync (user chose during migration)
		
		await plugin.saveSettings();
	}
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
