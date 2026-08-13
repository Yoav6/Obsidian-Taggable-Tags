import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { MigrationSettings, RECOMMENDED_MIGRATION_SETTINGS } from '../commands/migrate-vault';

/**
 * Modal for configuring migration settings.
 */
export class MigrationSettingsModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private resolvePromise: ((value: MigrationSettings | null) => void) | null = null;
	private settings: MigrationSettings;
	private userMadeChoice = false;

	constructor(plugin: TaggableTagsPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		
		// Initialize with recommended settings, using current excluded folders
		this.settings = {
			...RECOMMENDED_MIGRATION_SETTINGS,
			excludedFolders: [...plugin.settings.excludedFoldersFromSync],
		};
	}

	/**
	 * Show the modal and return a promise that resolves with settings or null if cancelled.
	 */
	prompt(): Promise<MigrationSettings | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-migration-settings-modal');

		contentEl.createEl('h2', { text: 'Migration settings' });

		contentEl.createEl('p', {
			text: 'Configure how the migration should process your vault. Recommended settings are pre-selected.',
			cls: 'taggable-tags-modal-description',
		});

		// Flatten nested tags
		new Setting(contentEl)
			.setName('Flatten nested tags')
			.setDesc('Convert nested tags (e.g., #media/music/jazz) to flat tags with parent relationships (jazz → music → media). Recommended: ON')
			.addToggle((toggle) =>
				toggle
					.setValue(this.settings.flattenNestedTags)
					.onChange((value) => {
						this.settings.flattenNestedTags = value;
					})
			);

		// Remove redundant parent tags
		new Setting(contentEl)
			.setName('Remove redundant parent tags')
			.setDesc('If a file has both a tag and its ancestor (e.g., "recipes" and "cooking" where recipes is under cooking), remove the ancestor since it\'s implied. Recommended: ON')
			.addToggle((toggle) =>
				toggle
					.setValue(this.settings.removeRedundantParentTags)
					.onChange((value) => {
						this.settings.removeRedundantParentTags = value;
					})
			);

		// Enable folder sync after
		new Setting(contentEl)
			.setName('Enable folder sync after migration')
			.setDesc('Turn on folder synchronization after migration completes. This will keep your folder structure in sync with tags going forward. Recommended: ON (but can also be enabled manually afterwards)')
			.addToggle((toggle) =>
				toggle
					.setValue(this.settings.enableFolderSyncAfter)
					.onChange((value) => {
						this.settings.enableFolderSyncAfter = value;
					})
			);

		// Excluded folders
		new Setting(contentEl)
			.setName('Excluded folders')
			.setDesc('Comma-separated list of folder paths to exclude from migration (e.g., "templates, attachments").')
			.addText((text) =>
				text
					.setPlaceholder('templates, attachments')
					.setValue(this.settings.excludedFolders.join(', '))
					.onChange((value) => {
						this.settings.excludedFolders = value
							.split(',')
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
					})
			);

		// Info about forced settings
		const infoDiv = contentEl.createDiv({ cls: 'taggable-tags-info' });
		infoDiv.createEl('h4', { text: 'Settings applied during migration' });
		infoDiv.createEl('p', {
			text: 'The following settings will be temporarily applied during migration to ensure smooth operation:',
		});
		const infoList = infoDiv.createEl('ul');
		infoList.createEl('li', { text: '"Use existing files as tags" → Automatically use (no prompts)' });
		infoList.createEl('li', { text: '"Keep original folder tag" → Always keep (no prompts)' });
		infoList.createEl('li', { text: '"Auto-create tag notes" → Off (prevents race conditions)' });
		infoList.createEl('li', { text: '"Ask about unused tag files" → Off (no prompts)' });
		infoDiv.createEl('p', {
			text: 'Your original settings will be restored after migration.',
		});

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
					.setButtonText('Preview changes')
					.setCta()
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(this.settings);
						this.close();
					})
			);
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
