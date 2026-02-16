import { Modal, Setting, TFile, TFolder } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { 
	ConflictDetectionResult, 
	NamingConflict, 
	ConflictResolution,
	countRenames 
} from '../migration/conflict-detector';

/**
 * Modal for reviewing and editing conflict resolutions before migration.
 */
export class ConflictResolutionModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private detectionResult: ConflictDetectionResult;
	private resolvePromise: ((value: Map<NamingConflict, ConflictResolution[]> | null) => void) | null = null;
	private userMadeChoice = false;
	
	// Editable copy of resolutions
	private editableResolutions: Map<NamingConflict, ConflictResolution[]>;

	constructor(plugin: TaggableTagsPlugin, detectionResult: ConflictDetectionResult) {
		super(plugin.app);
		this.plugin = plugin;
		this.detectionResult = detectionResult;
		
		// Create editable copy of resolutions
		this.editableResolutions = new Map();
		for (const [conflict, resolutions] of detectionResult.resolutions) {
			this.editableResolutions.set(conflict, resolutions.map(r => ({ ...r })));
		}
	}

	/**
	 * Show the modal and return a promise that resolves with edited resolutions or null if cancelled.
	 */
	prompt(): Promise<Map<NamingConflict, ConflictResolution[]> | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-conflict-modal');

		contentEl.createEl('h2', { text: 'Naming conflicts detected' });

		const renameCount = countRenames(this.editableResolutions);
		
		contentEl.createEl('p', {
			text: `Found ${this.detectionResult.conflicts.length} naming conflict${this.detectionResult.conflicts.length === 1 ? '' : 's'} that could create circular relationships. ${renameCount} item${renameCount === 1 ? '' : 's'} will be renamed.`,
			cls: 'taggable-tags-modal-description',
		});

		// Warning about why this matters
		const warningDiv = contentEl.createDiv({ cls: 'taggable-tags-warning' });
		warningDiv.createEl('p', {
			text: 'When multiple folders share the same name, they would all become the same tag, potentially creating circular parent-child relationships. Renaming ensures each folder becomes a unique tag.',
		});

		// Scrollable container for conflicts
		const conflictsContainer = contentEl.createDiv({ cls: 'taggable-tags-conflicts-container' });

		for (const conflict of this.detectionResult.conflicts) {
			this.renderConflict(conflictsContainer, conflict);
		}

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel migration')
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(null);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply renames and continue')
					.setCta()
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(this.editableResolutions);
						this.close();
					})
			);
	}

	private renderConflict(container: HTMLElement, conflict: NamingConflict): void {
		const section = container.createDiv({ cls: 'taggable-tags-conflict-section' });
		
		section.createEl('h4', { 
			text: `"${conflict.name}" (${conflict.folders.length} folder${conflict.folders.length === 1 ? '' : 's'}${conflict.files.length > 0 ? `, ${conflict.files.length} file${conflict.files.length === 1 ? '' : 's'}` : ''})`,
			cls: 'taggable-tags-conflict-header',
		});

		const resolutions = this.editableResolutions.get(conflict) || [];
		const list = section.createEl('div', { cls: 'taggable-tags-conflict-list' });

		for (const resolution of resolutions) {
			this.renderResolution(list, conflict, resolution);
		}
	}

	private renderResolution(
		container: HTMLElement, 
		conflict: NamingConflict,
		resolution: ConflictResolution
	): void {
		const item = container.createDiv({ cls: 'taggable-tags-conflict-item' });
		
		const isFolder = resolution.original instanceof TFolder;
		const icon = isFolder ? '📁' : '📄';
		const originalPath = resolution.original.path;
		
		// Left side: original path and icon
		const leftSide = item.createDiv({ cls: 'taggable-tags-conflict-item-left' });
		leftSide.createSpan({ text: icon, cls: 'taggable-tags-conflict-icon' });
		leftSide.createSpan({ text: originalPath, cls: 'taggable-tags-conflict-path' });
		
		// Right side: new name (editable if being renamed)
		const rightSide = item.createDiv({ cls: 'taggable-tags-conflict-item-right' });
		
		if (resolution.keepsOriginalName) {
			rightSide.createSpan({ 
				text: '✓ keeps name', 
				cls: 'taggable-tags-conflict-keeps',
			});
		} else {
			rightSide.createSpan({ text: '→ ', cls: 'taggable-tags-conflict-arrow' });
			
			// Editable text input for new name
			const input = rightSide.createEl('input', {
				type: 'text',
				value: resolution.newName,
				cls: 'taggable-tags-conflict-input',
			});
			
			input.addEventListener('change', () => {
				resolution.newName = input.value.trim() || resolution.newName;
			});
		}
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
