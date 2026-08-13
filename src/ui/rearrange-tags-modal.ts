import { Modal, Notice, TFile, setIcon } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { readFrontmatterTags } from '../utils/frontmatter';

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

		const descEl = contentEl.createEl('p', { cls: 'setting-item-description tt-modal-desc' });
		descEl.textContent = 'Drag and drop tags to rearrange their order in the tags property.';

		this.tagListEl = contentEl.createDiv({ cls: 'rearrange-tags-list' });

		this.renderTags();

		const buttonContainer = contentEl.createDiv({ cls: 'rearrange-tags-buttons' });

		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = buttonContainer.createEl('button', { text: 'Confirm', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => void this.confirmRearrange());

		// Handle keyboard shortcuts
		this.scope.register([], 'Escape', () => {
			this.close();
			return false;
		});

		this.scope.register([], 'Enter', () => {
			void this.confirmRearrange();
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
		const chip = createDiv({ cls: 'rearrange-tag-chip' });
		chip.setAttribute('data-index', String(index));
		chip.draggable = true;

		const hashSpan = chip.createSpan({ cls: 'tag-hash' });
		hashSpan.textContent = '#';

		const nameSpan = chip.createSpan({ cls: 'tag-name' });
		nameSpan.textContent = tag;

		const handleSpan = chip.createSpan({ cls: 'drag-handle' });
		setIcon(handleSpan, 'grip-vertical');

		chip.addEventListener('dragstart', (e) => this.handleDragStart(e, index));
		chip.addEventListener('dragend', (e) => this.handleDragEnd(e));
		chip.addEventListener('dragover', (e) => this.handleDragOver(e, index));
		chip.addEventListener('dragenter', (e) => this.handleDragEnter(e));
		chip.addEventListener('dragleave', (e) => this.handleDragLeave(e));
		chip.addEventListener('drop', (e) => this.handleDrop(e, index));

		return chip;
	}

	private handleDragStart(e: DragEvent, index: number): void {
		this.draggedEl = e.target as HTMLElement;
		this.draggedIndex = index;
		
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}

		window.setTimeout(() => {
			if (this.draggedEl) {
				this.draggedEl.addClass('is-dragging');
			}
		}, 0);
	}

	private handleDragEnd(e: DragEvent): void {
		const target = e.target as HTMLElement;
		target.removeClass('is-dragging');
		
		if (this.tagListEl) {
			const chips = this.tagListEl.querySelectorAll('.rearrange-tag-chip');
			chips.forEach((chip) => {
				chip.removeClass('is-drop-target');
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
			chip.addClass('is-drop-target');
		}
	}

	private handleDragLeave(e: DragEvent): void {
		const target = e.target as HTMLElement;
		const chip = target.closest('.rearrange-tag-chip') as HTMLElement;
		
		if (chip && chip !== this.draggedEl) {
			chip.removeClass('is-drop-target');
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
			new Notice(`Failed to rearrange tags: ${String(error)}`);
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
	const tags = readFrontmatterTags(cache);
	if (tags.length === 0) {
		new Notice('This file has no tags property');
		return;
	}

	const flatTags = tags.filter((tag) => !tag.includes('/'));

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
