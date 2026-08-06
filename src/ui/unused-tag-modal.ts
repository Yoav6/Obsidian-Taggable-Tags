import { Modal, Setting, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

export type UnusedTagAction = 'keep' | 'delete' | 'rename';

export interface UnusedTagModalResult {
	action: UnusedTagAction;
	newName?: string;
}

/**
 * Modal for handling unused tag files.
 * Shows when a tag has zero usages in any file.
 */
export class UnusedTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private tagFile: TFile;
	private tagName: string;
	private resolve: (result: UnusedTagModalResult | null) => void;
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
	async prompt(): Promise<UnusedTagModalResult | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Unused tag file' });

		contentEl.createEl('p', {
			text: `The tag #${this.tagName} is no longer used anywhere. What would you like to do with its tag file?`,
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
			.setDesc('Rename to a different tag');
		
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

		// Validate (# not allowed; spaces OK — converted via naming helpers)
		if (newName.includes('#')) {
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
