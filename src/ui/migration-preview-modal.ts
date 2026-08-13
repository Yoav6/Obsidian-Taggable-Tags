import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { MigrationSettings } from '../commands/migrate-vault';
import {
	describeOp,
	groupOpsByKind,
	kindLabel,
	planSummary,
	serializePlanToNote,
	type MigrationPlan,
} from '../migration/plan';

export type PreviewModalResult = 'apply' | 'back' | 'cancel';

/**
 * Modal that shows a migration plan and lets the user confirm or go back to conflicts.
 */
export class MigrationPreviewModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private plan: MigrationPlan;
	private settings: MigrationSettings;
	private resolvePromise: ((value: PreviewModalResult) => void) | null = null;
	private userMadeChoice = false;

	constructor(plugin: TaggableTagsPlugin, plan: MigrationPlan, settings: MigrationSettings) {
		super(plugin.app);
		this.plugin = plugin;
		this.plan = plan;
		this.settings = settings;
	}

	prompt(): Promise<PreviewModalResult> {
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

		const summary = planSummary(this.plan);
		if (summary.total === 0) {
			contentEl.createEl('p', {
				text: 'No changes needed. Your vault is already organized according to the selected settings.',
				cls: 'taggable-tags-no-changes',
			});
		} else {
			contentEl.createEl('p', {
				text: `The migration will make ${summary.total} change${summary.total === 1 ? '' : 's'} to your vault:`,
				cls: 'taggable-tags-summary',
			});
		}

		const changesContainer = contentEl.createDiv({ cls: 'taggable-tags-changes-container' });
		const groups = groupOpsByKind(this.plan);

		for (const [kind, ops] of groups) {
			this.renderSection(
				changesContainer,
				`${kindLabel(kind)} (${ops.length})`,
				ops.map(op => describeOp(op))
			);
		}

		if (this.plan.emptyFolders.length > 0) {
			this.renderSection(
				changesContainer,
				`Empty folders (${this.plan.emptyFolders.length})`,
				this.plan.emptyFolders.slice(0, 10).map(path => ({
					primary: path,
					secondary: '(handled after migration)',
				}))
			);
		}

		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) =>
				btn.setButtonText('Back to conflicts').onClick(() => {
					this.userMadeChoice = true;
					this.resolvePromise?.('back');
					this.close();
				})
			)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => {
					this.userMadeChoice = true;
					this.resolvePromise?.('cancel');
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply migration')
					.setCta()
					.setDisabled(summary.total === 0)
					.onClick(() => {
						this.userMadeChoice = true;
						this.resolvePromise?.('apply');
						this.close();
					})
			);
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
		if (!this.userMadeChoice && this.resolvePromise) {
			this.resolvePromise('cancel');
		}
		this.resolvePromise = null;
	}

	getPlanNoteContent(): string {
		return serializePlanToNote(this.plan);
	}
}
