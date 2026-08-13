import { Modal, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Modal that asks the user whether to use an existing file as a tag file
 * or create a new tag file.
 */
export class UseExistingFileModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private existingFile: TFile;
	private tagName: string;
	private resolvePromise: ((useExisting: boolean) => void) | null = null;

	constructor(plugin: TaggableTagsPlugin, existingFile: TFile, tagName: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.existingFile = existingFile;
		this.tagName = tagName;
	}

	/**
	 * Opens the modal and returns a promise that resolves to the user's choice.
	 * @returns true if the user wants to use the existing file, false to create a new file
	 */
	async askUser(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Use existing file as tag?' });

		// Description
		const descEl = contentEl.createEl('p', { cls: 'tt-modal-desc' });
		descEl.setText(`A file with a similar name already exists. Would you like to use it as the tag file for #${this.tagName}?`);

		// File info
		const fileInfo = contentEl.createDiv({ cls: 'tt-modal-info-panel' });
		
		fileInfo.createDiv({ 
			text: `Existing file: ${this.existingFile.path}`,
			cls: 'setting-item-name'
		});
		
		const tagDisplay = fileInfo.createDiv({ cls: 'tt-modal-mono' });
		tagDisplay.createSpan({ text: `Tag: #${this.tagName}` });

		// Info about what happens
		const infoEl = contentEl.createEl('p', { cls: 'tt-modal-muted' });
		infoEl.setText('If you use the existing file, the required tag properties will be added to its frontmatter.');

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'tt-modal-buttons' });

		const createNewBtn = buttonContainer.createEl('button', { text: 'Create new file' });
		createNewBtn.addEventListener('click', () => {
			this.resolvePromise?.(false);
			this.close();
		});

		const useExistingBtn = buttonContainer.createEl('button', { 
			text: 'Use existing file',
			cls: 'mod-cta'
		});
		useExistingBtn.addEventListener('click', () => {
			this.resolvePromise?.(true);
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		
		// If modal was closed without making a choice (e.g., clicking outside),
		// default to creating a new file (safer option)
		if (this.resolvePromise) {
			this.resolvePromise(false);
			this.resolvePromise = null;
		}
	}
}

/**
 * Shows the use existing file modal and returns the user's choice.
 */
export async function askUseExistingFile(
	plugin: TaggableTagsPlugin,
	existingFile: TFile,
	tagName: string
): Promise<boolean> {
	const modal = new UseExistingFileModal(plugin, existingFile, tagName);
	return modal.askUser();
}
