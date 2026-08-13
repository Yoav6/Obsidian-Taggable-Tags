import { Modal, Notice } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import {
	deleteTagAndInstances,
	deleteTagAndExclusiveChildren,
	deleteTagAndAllChildren,
	getDeleteTagStats,
	DeleteTagStats,
	DeleteTagResult
} from '../sync/delete-tag';
import { refreshActiveView } from './tag-context-menu';

export type DeleteMode = 'instances' | 'exclusive' | 'all';

/**
 * Confirmation modal for deleting a tag.
 * Shows what will be affected and requires user confirmation.
 */
export class DeleteTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private tagName: string;
	private mode: DeleteMode;
	private stats: DeleteTagStats;
	private onComplete: (() => void) | null;

	constructor(
		plugin: TaggableTagsPlugin, 
		tagName: string, 
		mode: DeleteMode,
		onComplete?: () => void
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.tagName = tagName;
		this.mode = mode;
		this.stats = getDeleteTagStats(plugin, tagName);
		this.onComplete = onComplete ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		// Add warning styling
		contentEl.addClass('delete-tag-modal');
		
		// Title
		const title = this.getModeTitle();
		contentEl.createEl('h2', { text: title });
		
		// Tag being deleted
		const tagDisplay = contentEl.createDiv({ cls: 'delete-tag-target tt-modal-info-panel' });
		tagDisplay.createSpan({ text: `#${this.stats.tagName}` });
		
		// Warning message
		const warningEl = contentEl.createDiv({ cls: 'delete-tag-warning tt-modal-warning-box' });
		warningEl.createEl('strong', { text: 'Warning: ' });
		warningEl.createSpan({ text: 'This action cannot be undone.' });
		
		// Stats display
		const statsEl = contentEl.createDiv({ cls: 'delete-tag-stats tt-modal-stats' });
		
		this.renderStats(statsEl);
		
		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'delete-tag-buttons tt-modal-buttons' });
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const deleteBtn = buttonContainer.createEl('button', { 
			text: 'Delete', 
			cls: 'mod-warning' 
		});
		deleteBtn.addEventListener('click', () => void this.performDelete());
	}

	private getModeTitle(): string {
		switch (this.mode) {
			case 'instances':
				return 'Delete tag file and instances';
			case 'exclusive':
				return 'Delete tag and exclusive children';
			case 'all':
				return 'Delete tag and all children';
		}
	}

	private renderStats(container: HTMLElement): void {
		const list = container.createEl('ul', { cls: 'tt-modal-list' });
		
		// Tag file status
		if (this.stats.hasTagFile) {
			list.createEl('li', { text: 'Tag file will be deleted' });
		} else {
			list.createEl('li', { text: 'No tag file exists (tag only has instances)' });
		}
		
		// Instance count
		if (this.stats.instanceCount > 0) {
			list.createEl('li', { 
				text: `${this.stats.instanceCount} file(s) will have this tag removed` 
			});
		}
		
		// Mode-specific stats
		switch (this.mode) {
			case 'instances':
				// No additional stats for basic mode
				break;
				
			case 'exclusive':
				if (this.stats.exclusiveChildTagCount > 0) {
					list.createEl('li', { 
						text: `${this.stats.exclusiveChildTagCount} exclusive child tag(s) will be deleted` 
					});
				} else {
					list.createEl('li', { 
						text: 'No exclusive child tags to delete' 
					});
				}
				if (this.stats.directChildFileCount > 0) {
					list.createEl('li', { 
						text: `${this.stats.directChildFileCount} note file(s) directly under this tag will be deleted` 
					});
				}
				break;
				
			case 'all':
				if (this.stats.childTagCount > 0) {
					list.createEl('li', { 
						text: `${this.stats.childTagCount} child tag(s) will be deleted` 
					});
				} else {
					list.createEl('li', { 
						text: 'No child tags to delete' 
					});
				}
				if (this.stats.allDescendantFileCount > 0) {
					list.createEl('li', { 
						text: `${this.stats.allDescendantFileCount} note file(s) under this tag hierarchy will be deleted` 
					});
				}
				break;
		}
	}

	private async performDelete(): Promise<void> {
		this.close();
		
		try {
			let result: DeleteTagResult;
			
			switch (this.mode) {
				case 'instances':
					result = await deleteTagAndInstances(this.plugin, this.tagName);
					break;
				case 'exclusive':
					result = await deleteTagAndExclusiveChildren(this.plugin, this.tagName);
					break;
				case 'all':
					result = await deleteTagAndAllChildren(this.plugin, this.tagName);
					break;
			}
			
			// Update the tag registry
			await this.plugin.updateTagRegistry();
			
			// Show success notice
			const parts: string[] = [];
			if (result.tagsDeleted > 0) {
				parts.push(`${result.tagsDeleted} tag file(s)`);
			}
			if (result.filesDeleted > 0) {
				parts.push(`${result.filesDeleted} note file(s)`);
			}
			if (result.instancesRemoved > 0) {
				parts.push(`removed from ${result.instancesRemoved} file(s)`);
			}
			
			const message = parts.length > 0 
				? `Deleted #${this.tagName}: ${parts.join(', ')}`
				: `Deleted #${this.tagName}`;
			
			new Notice(message);
			
			// Refresh the active view to show the updated content
			await refreshActiveView(this.plugin);
			
			// Call completion callback if provided
			if (this.onComplete) {
				this.onComplete();
			}
		} catch (error) {
			console.error('Failed to delete tag:', error);
			new Notice(`Failed to delete tag: ${String(error)}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Opens the delete tag modal for a specific mode.
 */
export function showDeleteTagModal(
	plugin: TaggableTagsPlugin, 
	tagName: string, 
	mode: DeleteMode,
	onComplete?: () => void
): void {
	new DeleteTagModal(plugin, tagName, mode, onComplete).open();
}
