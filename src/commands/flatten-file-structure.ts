import { TFile, TFolder, Notice, normalizePath } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { FlattenFileStructureModal } from '../ui/flatten-file-structure-modal';

/**
 * Main entry point for the flatten file structure command.
 * Opens a modal to configure ignored folders, then moves all files to the root
 * and deletes all non-ignored folders.
 */
export async function flattenFileStructure(plugin: TaggableTagsPlugin): Promise<void> {
	// Show the configuration modal
	const modal = new FlattenFileStructureModal(plugin);
	const result = await modal.prompt();

	if (!result) {
		// User cancelled
		return;
	}

	const { ignoredFolders } = result;

	new Notice('Flattening file structure...');

	try {
		// Step 1: Get all files that need to be moved
		const filesToMove = getFilesToMove(plugin, ignoredFolders);

		// Step 2: Move files to root, handling name conflicts
		let movedCount = 0;
		let skippedCount = 0;

		for (const file of filesToMove) {
			const moved = await moveFileToRoot(plugin, file);
			if (moved) {
				movedCount++;
			} else {
				skippedCount++;
			}
		}

		// Step 3: Delete all non-ignored empty folders (bottom-up)
		const deletedFolders = await deleteEmptyFolders(plugin, ignoredFolders);

		// Step 4: Rebuild the tag index if needed
		await plugin.tagIndex.rebuild();
		await plugin.updateTagRegistry();

		// Show summary
		let message = `Flattened file structure: moved ${movedCount} file${movedCount === 1 ? '' : 's'}`;
		if (skippedCount > 0) {
			message += `, skipped ${skippedCount} (name conflicts)`;
		}
		message += `, deleted ${deletedFolders} folder${deletedFolders === 1 ? '' : 's'}`;
		
		new Notice(message);
	} catch (error) {
		console.error('Error flattening file structure:', error);
		new Notice(`Error flattening file structure: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

/**
 * Gets all files that should be moved (not in ignored folders and not already at root).
 */
function getFilesToMove(plugin: TaggableTagsPlugin, ignoredFolders: string[]): TFile[] {
	const files: TFile[] = [];
	const allFiles = plugin.app.vault.getFiles();

	for (const file of allFiles) {
		// Skip files already at root
		if (!file.parent || file.parent.isRoot()) {
			continue;
		}

		// Check if file is in an ignored folder
		if (isInIgnoredFolder(file.path, ignoredFolders)) {
			continue;
		}

		files.push(file);
	}

	return files;
}

/**
 * Checks if a path is inside any of the ignored folders.
 */
function isInIgnoredFolder(filePath: string, ignoredFolders: string[]): boolean {
	for (const ignoredFolder of ignoredFolders) {
		// Check if the file path starts with the ignored folder path
		if (filePath === ignoredFolder || filePath.startsWith(ignoredFolder + '/')) {
			return true;
		}
	}
	return false;
}

/**
 * Moves a file to the root of the vault.
 * Returns true if the file was moved, false if skipped due to conflict.
 */
async function moveFileToRoot(plugin: TaggableTagsPlugin, file: TFile): Promise<boolean> {
	const targetPath = normalizePath(file.name);

	// Check if a file already exists at the target path
	const existingFile = plugin.app.vault.getAbstractFileByPath(targetPath);
	if (existingFile) {
		// Try to find a unique name
		const uniquePath = await findUniquePath(plugin, file.name);
		if (uniquePath) {
			await plugin.app.fileManager.renameFile(file, uniquePath);
			return true;
		}
		// Could not find unique name, skip
		console.warn(`Skipping ${file.path}: could not find unique name at root`);
		return false;
	}

	await plugin.app.fileManager.renameFile(file, targetPath);
	return true;
}

/**
 * Finds a unique file path at the root by appending a number.
 */
async function findUniquePath(plugin: TaggableTagsPlugin, fileName: string): Promise<string | null> {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';

	for (let i = 1; i <= 100; i++) {
		const candidatePath = normalizePath(`${baseName} ${i}${extension}`);
		const existing = plugin.app.vault.getAbstractFileByPath(candidatePath);
		if (!existing) {
			return candidatePath;
		}
	}

	return null;
}

/**
 * Deletes all empty folders that are not in the ignored list.
 * Works bottom-up to handle nested folders.
 * Returns the number of folders deleted.
 */
export async function deleteEmptyFolders(plugin: TaggableTagsPlugin, ignoredFolders: string[]): Promise<number> {
	let deletedCount = 0;
	let changed = true;

	// Keep iterating until no more folders can be deleted
	while (changed) {
		changed = false;

		// Get all folders sorted by depth (deepest first)
		const folders = getAllFoldersSortedByDepth(plugin);

		for (const folder of folders) {
			// Skip root
			if (folder.isRoot()) {
				continue;
			}

			// Skip ignored folders and their parents
			if (isIgnoredOrParentOfIgnored(folder.path, ignoredFolders)) {
				continue;
			}

			// Check if folder is empty
			if (folder.children.length === 0) {
				try {
					await plugin.app.vault.delete(folder);
					deletedCount++;
					changed = true;
				} catch (error) {
					console.warn(`Could not delete folder ${folder.path}:`, error);
				}
			}
		}
	}

	return deletedCount;
}

/**
 * Gets all folders sorted by depth (deepest first).
 */
function getAllFoldersSortedByDepth(plugin: TaggableTagsPlugin): TFolder[] {
	const folders: TFolder[] = [];
	
	function collectFolders(folder: TFolder): void {
		folders.push(folder);
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				collectFolders(child);
			}
		}
	}

	const root = plugin.app.vault.getRoot();
	collectFolders(root);

	// Sort by depth (deepest first)
	folders.sort((a, b) => {
		const depthA = a.path.split('/').length;
		const depthB = b.path.split('/').length;
		return depthB - depthA;
	});

	return folders;
}

/**
 * Checks if a folder path is ignored or is a parent of an ignored folder.
 */
function isIgnoredOrParentOfIgnored(folderPath: string, ignoredFolders: string[]): boolean {
	for (const ignoredFolder of ignoredFolders) {
		// Check if this folder is the ignored folder
		if (folderPath === ignoredFolder) {
			return true;
		}
		// Check if this folder is inside the ignored folder
		if (folderPath.startsWith(ignoredFolder + '/')) {
			return true;
		}
		// Check if the ignored folder is inside this folder (this folder is a parent)
		if (ignoredFolder.startsWith(folderPath + '/')) {
			return true;
		}
	}
	return false;
}
