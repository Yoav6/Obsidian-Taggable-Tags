import { Modal, Setting, TFolder, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';

export interface FlattenFileStructureResult {
	ignoredFolders: string[];
}

/**
 * Modal for configuring the flatten file structure operation.
 * Allows users to specify folders to ignore (which won't be flattened).
 */
export class FlattenFileStructureModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private resolve: (result: FlattenFileStructureResult | null) => void;
	private ignoredFolders: string[] = [];
	private folderListEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.resolve = () => {};
	}

	/**
	 * Opens the modal and returns a promise that resolves with the user's configuration.
	 */
	async prompt(): Promise<FlattenFileStructureResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Flatten file structure' });

		contentEl.createEl('p', {
			text: 'This will move all files to the root of your vault and delete all folders.',
		});

		contentEl.createEl('p', {
			text: 'Warning: This operation cannot be undone. Make sure you have a backup.',
			cls: 'mod-warning',
		});

		// Folder input section
		const inputSetting = new Setting(contentEl)
			.setName('Folders to ignore')
			.setDesc('These folders and their contents will not be affected');

		inputSetting.addText(text => {
			this.inputEl = text.inputEl;
			text.setPlaceholder('Enter folder path...');
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this.addFolder();
				}
			});
			return text;
		});

		inputSetting.addButton(button => button
			.setButtonText('Add')
			.onClick(() => this.addFolder()));

		// Folder suggestions
		const suggestionContainer = contentEl.createDiv({ cls: 'flatten-folder-suggestions' });
		suggestionContainer.createEl('p', { 
			text: 'Common folders to ignore:',
			cls: 'mod-muted setting-item-description'
		});
		
		const suggestionsEl = suggestionContainer.createDiv({ cls: 'flatten-suggestions-list' });
		const commonFolders = [this.plugin.app.vault.configDir, 'templates', 'attachments', 'assets', 'images'];
		
		for (const folder of commonFolders) {
			const folderExists = this.plugin.app.vault.getAbstractFileByPath(folder) instanceof TFolder;
			if (folderExists) {
				const chip = suggestionsEl.createSpan({ 
					text: folder,
					cls: 'flatten-suggestion-chip'
				});
				chip.addEventListener('click', () => {
					if (!this.ignoredFolders.includes(folder)) {
						this.ignoredFolders.push(folder);
						this.renderFolderList();
					}
				});
			}
		}

		// List of ignored folders
		this.folderListEl = contentEl.createDiv({ cls: 'flatten-ignored-folders' });
		this.renderFolderList();

		// Action buttons
		const buttonContainer = contentEl.createDiv({ cls: 'flatten-button-container' });
		
		new Setting(buttonContainer)
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => {
					this.resolve(null);
					this.close();
				}))
			.addButton(button => button
				.setButtonText('Flatten vault')
				.setDestructive()
				.setCta()
				.onClick(() => {
					this.resolve({ ignoredFolders: this.ignoredFolders });
					this.close();
				}));
	}

	private addFolder(): void {
		if (!this.inputEl) return;

		let folderPath = this.inputEl.value.trim();
		
		// Remove leading/trailing slashes
		folderPath = folderPath.replace(/^\/+|\/+$/g, '');

		if (!folderPath) {
			return;
		}

		// Check if folder exists
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			new Notice(`Folder "${folderPath}" does not exist`);
			return;
		}

		// Check if already added
		if (this.ignoredFolders.includes(folderPath)) {
			new Notice(`Folder "${folderPath}" is already in the list`);
			return;
		}

		this.ignoredFolders.push(folderPath);
		this.inputEl.value = '';
		this.renderFolderList();
	}

	private renderFolderList(): void {
		if (!this.folderListEl) return;

		this.folderListEl.empty();

		if (this.ignoredFolders.length === 0) {
			this.folderListEl.createEl('p', {
				text: 'No folders will be ignored. All files will be moved to the root.',
				cls: 'mod-muted'
			});
			return;
		}

		this.folderListEl.createEl('p', {
			text: 'Ignored folders:',
			cls: 'mod-muted'
		});

		const listEl = this.folderListEl.createEl('ul', { cls: 'flatten-folder-list' });

		for (const folder of this.ignoredFolders) {
			const itemEl = listEl.createEl('li', { cls: 'flatten-folder-item' });
			itemEl.createSpan({ text: folder });
			
			const removeBtn = itemEl.createEl('button', {
				text: '×',
				cls: 'flatten-remove-btn',
				attr: { 'aria-label': 'Remove folder' }
			});
			removeBtn.addEventListener('click', () => {
				this.ignoredFolders = this.ignoredFolders.filter(f => f !== folder);
				this.renderFolderList();
			});
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		// If modal is closed without choosing, resolve with null
		this.resolve(null);
	}
}
