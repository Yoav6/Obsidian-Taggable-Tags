import { Modal, Setting, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { generateTagFileContent } from '../utils/tag-template';
import {
	disambiguateFolderIfNeeded,
	collectSafeParentTags,
} from '../utils/cycle-prevention';

/**
 * Action to take for an empty folder.
 */
export type EmptyFolderAction = 'delete' | 'create-tag' | 'skip';

/**
 * Decision for a single empty folder.
 */
export interface EmptyFolderDecision {
	folder: TFolder;
	action: EmptyFolderAction;
}

/**
 * Result of the empty folders modal.
 */
export interface EmptyFoldersResult {
	decisions: EmptyFolderDecision[];
	foldersDeleted: number;
	tagFilesCreated: number;
}

/**
 * Modal for deciding what to do with empty folders after migration.
 */
export class EmptyFoldersModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private emptyFolders: TFolder[];
	private resolvePromise: ((value: EmptyFoldersResult | null) => void) | null = null;
	private userMadeChoice = false;
	
	// Track decisions for each folder
	private decisions: Map<string, EmptyFolderAction>;

	constructor(plugin: TaggableTagsPlugin, emptyFolders: TFolder[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.emptyFolders = emptyFolders;
		
		// Initialize all decisions to 'skip'
		this.decisions = new Map();
		for (const folder of emptyFolders) {
			this.decisions.set(folder.path, 'skip');
		}
	}

	/**
	 * Show the modal and return a promise that resolves with the result or null if cancelled.
	 */
	prompt(): Promise<EmptyFoldersResult | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-empty-folders-modal');

		contentEl.createEl('h2', { text: 'Empty folders' });

		contentEl.createEl('p', {
			text: `Found ${this.emptyFolders.length} empty folder${this.emptyFolders.length === 1 ? '' : 's'} after migration. Choose what to do with each:`,
			cls: 'taggable-tags-modal-description',
		});

		// Bulk action buttons
		const bulkActions = contentEl.createDiv({ cls: 'taggable-tags-bulk-actions' });
		
		new Setting(bulkActions)
			.setName('Set all to:')
			.addButton(btn => btn
				.setButtonText('Delete')
				.onClick(() => this.setAllActions('delete'))
			)
			.addButton(btn => btn
				.setButtonText('Create tag')
				.onClick(() => this.setAllActions('create-tag'))
			)
			.addButton(btn => btn
				.setButtonText('Skip')
				.onClick(() => this.setAllActions('skip'))
			);

		// Scrollable container for folders
		const foldersContainer = contentEl.createDiv({ cls: 'taggable-tags-empty-folders-container' });

		for (const folder of this.emptyFolders) {
			this.renderFolderRow(foldersContainer, folder);
		}

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(null);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply')
					.setCta()
					.onClick(() => { void (async () => {
						this.userMadeChoice = true;
						const result = await this.applyDecisions();
						this.resolvePromise?.(result);
						this.close();
					})(); })
			);
	}

	private renderFolderRow(container: HTMLElement, folder: TFolder): void {
		const row = container.createDiv({ cls: 'taggable-tags-empty-folder-row' });
		row.dataset.path = folder.path;
		
		// Folder path
		row.createSpan({ text: '📁 ', cls: 'taggable-tags-folder-icon' });
		row.createSpan({ text: folder.path, cls: 'taggable-tags-folder-path' });
		
		// Action dropdown
		const select = row.createEl('select', { cls: 'taggable-tags-folder-action' });
		
		select.createEl('option', { value: 'skip', text: 'Skip' });
		select.createEl('option', { value: 'delete', text: 'Delete' });
		select.createEl('option', { value: 'create-tag', text: 'Create tag' });
		
		select.value = this.decisions.get(folder.path) || 'skip';
		
		select.addEventListener('change', () => {
			this.decisions.set(folder.path, select.value as EmptyFolderAction);
		});
	}

	private setAllActions(action: EmptyFolderAction): void {
		for (const folder of this.emptyFolders) {
			this.decisions.set(folder.path, action);
		}
		
		// Update all dropdowns
		const selects = this.contentEl.querySelectorAll('.taggable-tags-folder-action');
		selects.forEach((select) => {
			(select as HTMLSelectElement).value = action;
		});
	}

	private async applyDecisions(): Promise<EmptyFoldersResult> {
		const decisions: EmptyFolderDecision[] = [];
		let foldersDeleted = 0;
		let tagFilesCreated = 0;
		
		// Process folders deepest first to handle nested empty folders
		const sortedFolders = [...this.emptyFolders].sort((a, b) => {
			const depthA = a.path.split('/').length;
			const depthB = b.path.split('/').length;
			return depthB - depthA; // Deepest first
		});
		
		for (const folder of sortedFolders) {
			const action = this.decisions.get(folder.path) || 'skip';
			decisions.push({ folder, action });
			
			// Check if folder still exists (might have been deleted as parent of another)
			const stillExists = this.plugin.app.vault.getAbstractFileByPath(folder.path);
			if (!stillExists) continue;
			
			if (action === 'delete') {
				try {
					await this.plugin.app.fileManager.trashFile(folder);
					foldersDeleted++;
				} catch (error) {
					console.error(`Failed to delete folder ${folder.path}:`, error);
				}
			} else if (action === 'create-tag') {
				try {
					await this.createTagFileForFolder(folder);
					tagFilesCreated++;
				} catch (error) {
					console.error(`Failed to create tag file for ${folder.path}:`, error);
				}
			}
		}
		
		return { decisions, foldersDeleted, tagFilesCreated };
	}

	private async createTagFileForFolder(folder: TFolder): Promise<void> {
		const disambiguated = await disambiguateFolderIfNeeded(this.plugin, folder);
		if (disambiguated.failed) return;

		const currentFolder = disambiguated.folder;
		const tagName = this.plugin.tagIndex.getTagFromFolderPath(currentFolder.path);
		if (!tagName) return;
		
		const existingTagFile = this.plugin.tagIndex.getTagFile(tagName);
		if (existingTagFile) return;
		
		const parentFolder = currentFolder.parent;
		const parentTag = parentFolder && !parentFolder.isRoot()
			? this.plugin.tagIndex.getTagFromFolderPath(parentFolder.path)
			: null;
		const safeParents = collectSafeParentTags(
			this.plugin,
			tagName,
			parentTag,
			disambiguated.collisionParents
		);
		
		const displayName = this.plugin.tagIndex.toDisplayName(tagName);
		const filePath = `${currentFolder.path}/${displayName}.md`;
		const content = await generateTagFileContent(this.plugin, tagName, safeParents);
		
		const file = await this.plugin.app.vault.create(filePath, content);
		this.plugin.tagIndex.onTagFileCreated(file, tagName);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// If modal was closed without a choice, treat as cancel
		if (!this.userMadeChoice && this.resolvePromise) {
			this.resolvePromise(null);
		}
		this.resolvePromise = null;
	}
}
