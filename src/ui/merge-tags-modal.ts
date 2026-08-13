import { Modal, setIcon } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { describeMergeTags, performMergeTags } from '../sync/merge-tag';

export class MergeTagsModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private survivorTag: string;
	private removedTag: string;
	private onComplete: (() => void) | null;
	private summaryEl: HTMLElement | null = null;

	constructor(
		plugin: TaggableTagsPlugin,
		tagA: string,
		tagB: string,
		onComplete?: () => void
	) {
		super(plugin.app);
		this.plugin = plugin;
		// Left = removed, right (after "into") = survivor
		this.removedTag = tagA;
		this.survivorTag = tagB;
		this.onComplete = onComplete ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('create-tag-from-filters-modal');
		contentEl.addClass('merge-tags-modal');

		this.renderContent(contentEl);

		const buttonContainer = contentEl.createDiv({ cls: 'modal-buttons tt-modal-buttons-spaced' });

		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const confirmBtn = buttonContainer.createEl('button', { text: 'Merge', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => void this.performMerge());
	}

	private renderContent(container: HTMLElement): void {
		container.empty();
		container.addClass('create-tag-from-filters-modal');
		container.addClass('merge-tags-modal');

		const headingRow = container.createDiv({ cls: 'merge-tags-heading' });

		headingRow.createSpan({ text: 'Merge', cls: 'merge-tags-heading-label' });

		const removedChip = headingRow.createSpan({
			text: `#${this.removedTag}`,
			cls: 'modal-chip modal-chip-tag merge-tags-chip merge-tags-chip-removed',
		});

		const swapBtn = headingRow.createEl('button', {
			cls: 'merge-tags-swap-button clickable-icon',
			attr: { 'aria-label': 'Switch merge direction' },
		});
		setIcon(swapBtn, 'arrow-left-right');
		swapBtn.addEventListener('click', () => {
			[this.survivorTag, this.removedTag] = [this.removedTag, this.survivorTag];
			removedChip.textContent = `#${this.removedTag}`;
			survivorChip.textContent = `#${this.survivorTag}`;
			this.updateSummary();
		});

		headingRow.createSpan({ text: 'into', cls: 'merge-tags-heading-label' });

		const survivorChip = headingRow.createSpan({
			text: `#${this.survivorTag}`,
			cls: 'modal-chip modal-chip-tag merge-tags-chip',
		});

		this.summaryEl = container.createEl('p', { cls: 'setting-item-description merge-tags-summary' });
		this.updateSummary();
	}

	private updateSummary(): void {
		if (!this.summaryEl) return;
		this.summaryEl.textContent = describeMergeTags(this.plugin, this.survivorTag, this.removedTag);
	}

	private async performMerge(): Promise<void> {
		try {
			this.close();
			await performMergeTags(this.plugin, this.survivorTag, this.removedTag);
			this.onComplete?.();
		} catch {
			// performMergeTags already shows a notice
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
