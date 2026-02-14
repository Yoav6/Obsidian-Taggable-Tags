import { Modal, Setting, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

export type ChildlessTagAction = 'keep' | 'delete' | 'rename';

export interface ChildlessTagModalResult {
	action: ChildlessTagAction;
	newName?: string;
}

// Keep old type aliases for backwards compatibility
export type OrphanAction = ChildlessTagAction;
export type OrphanModalResult = ChildlessTagModalResult;

/**
 * Modal for handling childless tag files.
 * Shows when a tag has no children (no child tags and no files using it).
 */
export class ChildlessTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private tagFile: TFile;
	private tagName: string;
	private resolve: (result: ChildlessTagModalResult | null) => void;
	private newNameInput: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, tagFile: TFile, tagName: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.tagFile = tagFile;
		this.tagName = tagName;
		this.resolve = () => {};
	}

	/**
	 * Opens the modal and returns a promise that resolves with the user's choice.
	 */
	async prompt(): Promise<ChildlessTagModalResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Childless tag file' });

		contentEl.createEl('p', {
			text: `The tag #${this.tagName} has no children (no child tags and no files using it). What would you like to do with its tag file?`,
		});

		contentEl.createEl('p', {
			text: `File: ${this.tagFile.path}`,
			cls: 'mod-muted',
		});

		// Keep button
		new Setting(contentEl)
			.setName('Keep')
			.setDesc('Keep the tag file for future use')
			.addButton(button => button
				.setButtonText('Keep')
				.onClick(() => {
					this.resolve({ action: 'keep' });
					this.close();
				}));

		// Delete button
		new Setting(contentEl)
			.setName('Delete')
			.setDesc('Delete the tag file permanently')
			.addButton(button => button
				.setButtonText('Delete')
				.setWarning()
				.onClick(() => {
					this.resolve({ action: 'delete' });
					this.close();
				}));

		// Rename option
		const renameSetting = new Setting(contentEl)
			.setName('Rename')
			.setDesc('Rename to a different tag (will replace old tag usages if any remain)');
		
		renameSetting.addText(text => {
			this.newNameInput = text.inputEl;
			text.setPlaceholder('New tag name...');
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					this.handleRename();
				}
			});
			return text;
		});

		renameSetting.addButton(button => button
			.setButtonText('Rename')
			.onClick(() => {
				this.handleRename();
			}));
	}

	private handleRename(): void {
		if (!this.newNameInput) return;
		
		let newName = this.newNameInput.value.trim();
		
		// Remove # if present
		if (newName.startsWith('#')) {
			newName = newName.slice(1);
		}

		if (!newName) {
			return;
		}

		// Validate
		if (/[\s#]/.test(newName)) {
			// Show error (could use Notice, but keeping modal open)
			this.newNameInput.addClass('is-invalid');
			return;
		}

		this.resolve({ action: 'rename', newName });
		this.close();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		// If modal is closed without choosing, resolve with null
		this.resolve(null);
	}
}

// Keep old class alias for backwards compatibility
export const OrphanModal = ChildlessTagModal;
