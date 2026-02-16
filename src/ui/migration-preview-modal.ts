import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { MigrationPreview, MigrationSettings } from '../commands/migrate-vault';

/**
 * Modal that shows a preview of migration changes and lets the user confirm.
 */
export class MigrationPreviewModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private preview: MigrationPreview;
	private settings: MigrationSettings;
	private resolvePromise: ((value: boolean) => void) | null = null;
	private userMadeChoice = false;

	constructor(plugin: TaggableTagsPlugin, preview: MigrationPreview, settings: MigrationSettings) {
		super(plugin.app);
		this.plugin = plugin;
		this.preview = preview;
		this.settings = settings;
	}

	/**
	 * Show the modal and return a promise that resolves to true if user wants to apply.
	 */
	prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-migration-preview-modal');

		contentEl.createEl('h2', { text: 'Migration preview' });

		// Summary
		const summary = this.getSummary();
		if (summary.totalChanges === 0) {
			contentEl.createEl('p', {
				text: 'No changes needed. Your vault is already organized according to the selected settings.',
				cls: 'taggable-tags-no-changes',
			});
		} else {
			contentEl.createEl('p', {
				text: `The migration will make ${summary.totalChanges} change${summary.totalChanges === 1 ? '' : 's'} to your vault:`,
				cls: 'taggable-tags-summary',
			});
		}

		// Create scrollable container for changes
		const changesContainer = contentEl.createDiv({ cls: 'taggable-tags-changes-container' });

		// Nested tags to flatten
		if (this.preview.nestedTagsToFlatten.length > 0) {
			this.renderSection(
				changesContainer,
				`Nested tags to flatten (${this.preview.nestedTagsToFlatten.length})`,
				this.preview.nestedTagsToFlatten.map((item) => ({
					primary: `#${item.tag}`,
					secondary: `→ ${item.levels.map((l) => '#' + l).join(' → ')}`,
				}))
			);
		}

		// Tag files to create
		if (this.preview.tagFilesToCreate.length > 0) {
			this.renderSection(
				changesContainer,
				`Tag files to create (${this.preview.tagFilesToCreate.length})`,
				this.preview.tagFilesToCreate.map((item) => ({
					primary: `#${item.tagName}`,
					secondary: item.fromExisting
						? `from existing: ${item.fromExisting.path}`
						: item.parentTag
						? `parent: #${item.parentTag}`
						: 'new file',
				}))
			);
		}

		// Tags to add
		if (this.preview.tagsToAdd.length > 0) {
			this.renderSection(
				changesContainer,
				`Tags to add to files (${this.preview.tagsToAdd.length})`,
				this.preview.tagsToAdd.map((item) => ({
					primary: item.file.path,
					secondary: `+ #${item.folderTag}`,
				}))
			);
		}

		// Redundant tags to remove
		if (this.preview.redundantTagsToRemove.length > 0) {
			const totalTags = this.preview.redundantTagsToRemove.reduce(
				(sum, item) => sum + item.tags.length,
				0
			);
			this.renderSection(
				changesContainer,
				`Redundant tags to remove (${totalTags} from ${this.preview.redundantTagsToRemove.length} files)`,
				this.preview.redundantTagsToRemove.map((item) => ({
					primary: item.file.path,
					secondary: `- ${item.tags.map((t) => '#' + t).join(', ')}`,
				}))
			);
		}

		// Conflicts to resolve
		if (this.preview.conflictsToResolve > 0) {
			this.renderSection(
				changesContainer,
				`Naming conflicts to resolve (${this.preview.conflictsToResolve})`,
				[{ primary: `${this.preview.conflictsToResolve} items will be renamed to prevent circular relationships`, secondary: '' }]
			);
		}

		// Empty folders (will be handled in post-migration modal)
		if (this.preview.emptyFolders.length > 0) {
			this.renderSection(
				changesContainer,
				`Empty folders (${this.preview.emptyFolders.length})`,
				this.preview.emptyFolders.slice(0, 10).map((folder) => ({
					primary: folder.path,
					secondary: '(will be handled after migration)',
				}))
			);
		}

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) =>
				btn
					.setButtonText('Cancel')
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(false);
						this.close();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply migration')
					.setCta()
					.setDisabled(summary.totalChanges === 0)
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.(true);
						this.close();
					})
			);
	}

	private getSummary(): { totalChanges: number } {
		const totalChanges =
			this.preview.conflictsToResolve +
			this.preview.nestedTagsToFlatten.length +
			this.preview.tagFilesToCreate.length +
			this.preview.tagsToAdd.length +
			this.preview.redundantTagsToRemove.reduce((sum, item) => sum + item.tags.length, 0);
		// Note: empty folders are not counted as changes since they're handled in post-migration modal

		return { totalChanges };
	}

	private renderSection(
		container: HTMLElement,
		title: string,
		items: Array<{ primary: string; secondary: string }>
	): void {
		const section = container.createDiv({ cls: 'taggable-tags-preview-section' });
		
		const header = section.createEl('h4', { text: title });
		header.addClass('taggable-tags-preview-section-header');

		const list = section.createEl('ul', { cls: 'taggable-tags-preview-list' });

		// Limit displayed items to avoid overwhelming the UI
		const maxItems = 50;
		const displayItems = items.slice(0, maxItems);

		for (const item of displayItems) {
			const li = list.createEl('li');
			li.createSpan({ text: item.primary, cls: 'taggable-tags-preview-primary' });
			if (item.secondary) {
				li.createSpan({ text: ' ' });
				li.createSpan({ text: item.secondary, cls: 'taggable-tags-preview-secondary' });
			}
		}

		if (items.length > maxItems) {
			list.createEl('li', {
				text: `... and ${items.length - maxItems} more`,
				cls: 'taggable-tags-preview-more',
			});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// If modal was closed without a choice, treat as cancel
		if (!this.userMadeChoice && this.resolvePromise) {
			this.resolvePromise(false);
		}
		this.resolvePromise = null;
	}
}
