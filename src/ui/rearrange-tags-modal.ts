import { Modal, Notice, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Modal for rearranging the order of tags in the current note's tags property.
 * Tags are displayed as draggable chips that can be reordered.
 */
export class RearrangeTagsModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private file: TFile;
	private tags: string[];
	private tagListEl: HTMLElement | null = null;
	private draggedEl: HTMLElement | null = null;
	private draggedIndex: number = -1;

	constructor(plugin: TaggableTagsPlugin, file: TFile, tags: string[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.file = file;
		this.tags = [...tags]; // Create a copy to work with
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('rearrange-tags-modal');

		contentEl.createEl('h3', { text: 'Rearrange tag order' });

		const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
		descEl.textContent = 'Drag and drop tags to rearrange their order in the tags property.';
		descEl.style.marginBottom = '16px';

		// Create the tag list container
		this.tagListEl = contentEl.createEl('div', { cls: 'rearrange-tags-list' });
		this.tagListEl.style.cssText = `
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			padding: 16px;
			min-height: 60px;
			background: var(--background-secondary);
			border-radius: 8px;
			margin-bottom: 16px;
		`;

		this.renderTags();

		// Button container
		const buttonContainer = contentEl.createEl('div', { cls: 'rearrange-tags-buttons' });
		buttonContainer.style.cssText = `
			display: flex;
			justify-content: flex-end;
			gap: 8px;
		`;

		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = buttonContainer.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => this.confirmRearrange());

		// Handle keyboard shortcuts
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});

		this.scope.register([], 'Enter', () => {
			this.confirmRearrange();
			return false;
		});
	}

	private renderTags(): void {
		if (!this.tagListEl) return;
		this.tagListEl.empty();

		this.tags.forEach((tag, index) => {
			const tagChip = this.createTagChip(tag, index);
			this.tagListEl!.appendChild(tagChip);
		});
	}

	private createTagChip(tag: string, index: number): HTMLElement {
		const chip = document.createElement('div');
		chip.className = 'rearrange-tag-chip';
		chip.setAttribute('data-index', String(index));
		chip.draggable = true;
		chip.style.cssText = `
			display: inline-flex;
			align-items: center;
			gap: 4px;
			padding: 6px 12px;
			background: var(--interactive-normal);
			border-radius: 16px;
			cursor: grab;
			user-select: none;
			transition: background 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
			font-size: 14px;
		`;

		// Hash symbol
		const hashSpan = chip.createSpan({ cls: 'tag-hash' });
		hashSpan.textContent = '#';
		hashSpan.style.cssText = `
			color: var(--text-accent);
			font-weight: 500;
		`;

		// Tag name
		const nameSpan = chip.createSpan({ cls: 'tag-name' });
		nameSpan.textContent = tag;

		// Drag handle icon
		const handleSpan = chip.createSpan({ cls: 'drag-handle' });
		handleSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>`;
		handleSpan.style.cssText = `
			opacity: 0.5;
			margin-left: 4px;
			display: flex;
			align-items: center;
		`;

		// Drag events
		chip.addEventListener('dragstart', (e) => this.handleDragStart(e, index));
		chip.addEventListener('dragend', (e) => this.handleDragEnd(e));
		chip.addEventListener('dragover', (e) => this.handleDragOver(e, index));
		chip.addEventListener('dragenter', (e) => this.handleDragEnter(e));
		chip.addEventListener('dragleave', (e) => this.handleDragLeave(e));
		chip.addEventListener('drop', (e) => this.handleDrop(e, index));

		// Hover effects
		chip.addEventListener('mouseenter', () => {
			if (!this.draggedEl) {
				chip.style.background = 'var(--interactive-hover)';
			}
		});
		chip.addEventListener('mouseleave', () => {
			if (!this.draggedEl) {
				chip.style.background = 'var(--interactive-normal)';
			}
		});

		return chip;
	}

	private handleDragStart(e: DragEvent, index: number): void {
		this.draggedEl = e.target as HTMLElement;
		this.draggedIndex = index;
		
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}

		// Style the dragged element
		setTimeout(() => {
			if (this.draggedEl) {
				this.draggedEl.style.opacity = '0.5';
				this.draggedEl.style.cursor = 'grabbing';
			}
		}, 0);
	}

	private handleDragEnd(e: DragEvent): void {
		const target = e.target as HTMLElement;
		target.style.opacity = '1';
		target.style.cursor = 'grab';
		
		// Remove all drag-over styling
		if (this.tagListEl) {
			const chips = this.tagListEl.querySelectorAll('.rearrange-tag-chip');
			chips.forEach((chip) => {
				(chip as HTMLElement).style.background = 'var(--interactive-normal)';
				(chip as HTMLElement).style.transform = 'scale(1)';
			});
		}

		this.draggedEl = null;
		this.draggedIndex = -1;
	}

	private handleDragOver(e: DragEvent, index: number): void {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
	}

	private handleDragEnter(e: DragEvent): void {
		e.preventDefault();
		const target = e.target as HTMLElement;
		const chip = target.closest('.rearrange-tag-chip') as HTMLElement;
		
		if (chip && chip !== this.draggedEl) {
			chip.style.background = 'var(--interactive-accent)';
			chip.style.transform = 'scale(1.05)';
		}
	}

	private handleDragLeave(e: DragEvent): void {
		const target = e.target as HTMLElement;
		const chip = target.closest('.rearrange-tag-chip') as HTMLElement;
		
		if (chip && chip !== this.draggedEl) {
			chip.style.background = 'var(--interactive-normal)';
			chip.style.transform = 'scale(1)';
		}
	}

	private handleDrop(e: DragEvent, targetIndex: number): void {
		e.preventDefault();
		
		if (this.draggedIndex === -1 || this.draggedIndex === targetIndex) {
			return;
		}

		// Reorder the tags array
		const draggedTag = this.tags[this.draggedIndex];
		this.tags.splice(this.draggedIndex, 1);
		this.tags.splice(targetIndex, 0, draggedTag);

		// Re-render the tags
		this.renderTags();
	}

	private async confirmRearrange(): Promise<void> {
		try {
			await this.updateTagsInFile();
			new Notice('Tag order updated');
			this.close();
		} catch (error) {
			console.error('Failed to rearrange tags:', error);
			new Notice(`Failed to rearrange tags: ${error}`);
		}
	}

	private async updateTagsInFile(): Promise<void> {
		const content = await this.plugin.app.vault.read(this.file);
		
		// Check if file has frontmatter
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		if (!match) {
			throw new Error('File has no frontmatter');
		}

		const frontmatter = match[1];
		let newFrontmatter: string;

		// Detect the format used for tags (array or list)
		const tagsArrayRegex = /^(tags:\s*)\[([^\]]*)\]\s*$/m;
		const tagsListRegex = /^tags:\s*\n((?:\s*-\s*[^\n]+\n?)*)/m;
		
		const arrayMatch = frontmatter.match(tagsArrayRegex);
		const listMatch = frontmatter.match(tagsListRegex);

		if (arrayMatch) {
			// Tags in array format: tags: [tag1, tag2]
			const newTagsArray = this.tags.join(', ');
			newFrontmatter = frontmatter.replace(tagsArrayRegex, `$1[${newTagsArray}]`);
		} else if (listMatch) {
			// Tags in list format - need to preserve non-flat tags and replace flat ones
			const existingListContent = listMatch[1];
			const existingLines = existingListContent.split('\n').filter(line => line.trim());
			
			// Separate flat tags from nested tags (with '/')
			const nestedTags: string[] = [];
			for (const line of existingLines) {
				const tagMatch = line.match(/^\s*-\s*(.+)$/);
				if (tagMatch) {
					const tag = tagMatch[1].trim();
					if (tag.includes('/')) {
						nestedTags.push(tag);
					}
				}
			}

			// Build new tags list: flat tags first (in new order), then nested tags
			const allTags = [...this.tags, ...nestedTags];
			const newTagsList = allTags.map(tag => `  - ${tag}`).join('\n');
			
			// Replace the entire tags section
			newFrontmatter = frontmatter.replace(
				/^tags:\s*\n(?:\s*-\s*[^\n]+\n?)*/m,
				`tags:\n${newTagsList}\n`
			);
		} else {
			// Tags property exists but in unexpected format, try to add as list
			throw new Error('Could not parse tags format');
		}

		const newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);

		if (newContent !== content) {
			// Just modify the file - folder sync will handle the rest.
			// For tag files, getTargetFolderForTagFile now reads fresh data from metadata cache.
			// For regular files, getTargetFolderForFile reads fresh data too.
			await this.plugin.app.vault.modify(this.file, newContent);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Opens the rearrange tags modal for the current note.
 * Shows an error notice if no file is active or if the file has no tags.
 */
export function showRearrangeTagsModal(plugin: TaggableTagsPlugin): void {
	const activeFile = plugin.app.workspace.getActiveFile();
	
	if (!activeFile) {
		new Notice('No active file');
		return;
	}

	// Get tags from the file's frontmatter
	const cache = plugin.app.metadataCache.getFileCache(activeFile);
	if (!cache?.frontmatter?.tags) {
		new Notice('This file has no tags property');
		return;
	}

	const tags = cache.frontmatter.tags;
	if (!Array.isArray(tags) || tags.length === 0) {
		new Notice('This file has no tags');
		return;
	}

	// Filter to only flat tags (not nested Obsidian tags with '/')
	const flatTags = tags.filter((tag: unknown): tag is string => 
		typeof tag === 'string' && !tag.includes('/')
	);

	if (flatTags.length === 0) {
		new Notice('This file has no flat tags to rearrange');
		return;
	}

	if (flatTags.length < 2) {
		new Notice('Need at least 2 tags to rearrange');
		return;
	}

	new RearrangeTagsModal(plugin, activeFile, flatTags).open();
}
