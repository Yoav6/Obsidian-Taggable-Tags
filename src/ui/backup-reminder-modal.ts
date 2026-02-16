import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Modal that reminds the user to backup their vault before migration.
 */
export class BackupReminderModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private resolvePromise: ((value: boolean) => void) | null = null;
	private userMadeChoice = false;

	constructor(plugin: TaggableTagsPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	/**
	 * Show the modal and return a promise that resolves when the user makes a choice.
	 */
	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-backup-modal');

		contentEl.createEl('h2', { text: 'Backup reminder' });

		const warningDiv = contentEl.createDiv({ cls: 'taggable-tags-warning' });
		warningDiv.createEl('p', {
			text: 'The migration process will make significant changes to your vault:',
		});

		const changesList = warningDiv.createEl('ul');
		changesList.createEl('li', { text: 'Create tag files for folders' });
		changesList.createEl('li', { text: 'Add tags to files based on their folder location' });
		changesList.createEl('li', { text: 'Flatten nested tags (e.g., #media/music → #music)' });
		changesList.createEl('li', { text: 'Remove redundant parent tags' });
		changesList.createEl('li', { text: 'Delete empty folders' });

		warningDiv.createEl('p', {
			text: 'Please ensure you have a backup of your vault before proceeding.',
			cls: 'taggable-tags-warning-emphasis',
		});

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(false);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText('I have a backup, continue')
					.setCta()
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(true);
						this.close();
					})
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// If modal was closed without a choice (e.g., clicking outside), treat as cancel
		if (!this.userMadeChoice && this.resolvePromise) {
			this.resolvePromise(false);
		}
		this.resolvePromise = null;
	}
}
