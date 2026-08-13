import { Modal, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Modal that asks the user whether to keep or remove the original folder tag
 * when a file is moved to a new folder.
 */
export class KeepFolderTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private file: TFile;
	private tagName: string;
	private resolvePromise: ((keepTag: boolean) => void) | null = null;

	constructor(plugin: TaggableTagsPlugin, file: TFile, tagName: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.file = file;
		this.tagName = tagName;
	}

	/**
	 * Opens the modal and returns a promise that resolves to the user's choice.
	 * @returns true if the user wants to keep the tag, false if they want to remove it
	 */
	async askUser(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Keep original folder tag?' });

		// File info
		const fileInfo = contentEl.createDiv({ cls: 'tt-modal-info-panel' });
		
		fileInfo.createDiv({ 
			text: `File: ${this.file.basename}`,
			cls: 'setting-item-name'
		});
		
		const tagDisplay = fileInfo.createDiv({ cls: 'tt-modal-mono' });
		tagDisplay.createSpan({ text: `Tag: #${this.tagName}` });

		// Description
		const descEl = contentEl.createEl('p', { cls: 'tt-modal-muted' });
		descEl.setText('This file was moved to a new folder. Would you like to keep the tag from the original folder, or remove it?');

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'tt-modal-buttons' });

		const removeBtn = buttonContainer.createEl('button', { text: 'Remove tag' });
		removeBtn.addEventListener('click', () => {
			this.resolvePromise?.(false);
			this.close();
		});

		const keepBtn = buttonContainer.createEl('button', { 
			text: 'Keep tag',
			cls: 'mod-cta'
		});
		keepBtn.addEventListener('click', () => {
			this.resolvePromise?.(true);
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		
		// If modal was closed without making a choice (e.g., clicking outside),
		// default to keeping the tag (safer option)
		if (this.resolvePromise) {
			this.resolvePromise(true);
			this.resolvePromise = null;
		}
	}
}

/**
 * Shows the keep folder tag modal and returns the user's choice.
 */
export async function askKeepFolderTag(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagName: string
): Promise<boolean> {
	const modal = new KeepFolderTagModal(plugin, file, tagName);
	return modal.askUser();
}
