import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { 
	ConflictDetectionResult, 
	NamingConflict, 
	ConflictResolution,
	TagSource,
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
			text: `Found ${this.detectionResult.conflicts.length} naming conflict${this.detectionResult.conflicts.length === 1 ? '' : 's'} that could create issues. ${renameCount} item${renameCount === 1 ? '' : 's'} will be renamed.`,
			cls: 'taggable-tags-modal-description',
		});

		// Warning about why this matters
		const warningDiv = contentEl.createDiv({ cls: 'taggable-tags-warning' });
		warningDiv.createEl('p', {
			text: 'Multiple sources would create the same tag name. This could cause confusion or circular relationships. Renaming ensures each source creates a unique tag.',
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
		
		// Count sources by type
		const folderCount = conflict.sources.filter(s => s.type === 'folder').length;
		const tagCount = conflict.sources.filter(s => s.type === 'existing-tag').length;
		const nestedCount = conflict.sources.filter(s => s.type === 'nested-tag').length;
		
		const parts: string[] = [];
		if (folderCount > 0) parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
		if (tagCount > 0) parts.push(`${tagCount} tag file${tagCount === 1 ? '' : 's'}`);
		if (nestedCount > 0) parts.push(`${nestedCount} nested tag${nestedCount === 1 ? '' : 's'}`);
		
		section.createEl('h4', { 
			text: `"${conflict.name}" (${parts.join(', ')})`,
			cls: 'taggable-tags-conflict-header',
		});

		const resolutions = this.editableResolutions.get(conflict) || [];
		const list = section.createEl('div', { cls: 'taggable-tags-conflict-list' });

		for (const resolution of resolutions) {
			this.renderResolution(list, resolution);
		}
	}

	private renderResolution(
		container: HTMLElement, 
		resolution: ConflictResolution
	): void {
		const item = container.createDiv({ cls: 'taggable-tags-conflict-item' });
		
		const source = resolution.source;
		const icon = this.getSourceIcon(source);
		const path = this.getSourcePath(source);
		
		// Left side: icon and path
		const leftSide = item.createDiv({ cls: 'taggable-tags-conflict-item-left' });
		leftSide.createSpan({ text: icon, cls: 'taggable-tags-conflict-icon' });
		leftSide.createSpan({ text: path, cls: 'taggable-tags-conflict-path' });
		
		// Show matching file info for folders
		if (source.type === 'folder' && source.matchingFile) {
			leftSide.createSpan({ 
				text: ` (+ ${source.matchingFile.name})`, 
				cls: 'taggable-tags-conflict-extra',
			});
		}
		
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

	private getSourceIcon(source: TagSource): string {
		switch (source.type) {
			case 'folder': return '📁';
			case 'existing-tag': return '🏷️';
			case 'nested-tag': return '#';
			default: return '?';
		}
	}

	private getSourcePath(source: TagSource): string {
		switch (source.type) {
			case 'folder': return source.folder?.path || 'unknown';
			case 'existing-tag': return source.existingTagFile?.path || 'unknown';
			case 'nested-tag': return source.nestedTagPath || 'unknown';
			default: return 'unknown';
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
