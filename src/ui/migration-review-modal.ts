import { Modal, Notice, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type { MigrationSettings } from '../commands/migrate-vault';
import {
	ConflictDetectionResult,
	NamingConflict,
	ConflictResolution,
	TagSource,
	countRenames,
	getAvailableResolutionKinds,
	describeSource,
	sourceSupportsKeeperAsParent,
	hasConflicts,
	type ResolutionKind,
} from '../migration/conflict-detector';
import { appendSourceDescription } from './path-display';
import {
	describeOp,
	groupOpsByKind,
	kindLabel,
	planSummary,
	type MigrationPlan,
} from '../migration/plan';

export type ReviewModalResult = 'apply' | 'back' | 'cancel';

type ReviewStep = 'conflicts' | 'generating' | 'preview';

/**
 * Single modal for the conflicts → preview migration review flow.
 * Transitions between pages without closing.
 */
export class MigrationReviewModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private settings: MigrationSettings;
	private detectionResult: ConflictDetectionResult | null;
	private editableResolutions: Map<NamingConflict, ConflictResolution[]>;
	private plan: MigrationPlan | null = null;
	private step: ReviewStep = 'conflicts';
	private conflictsResolve: ((value: Map<NamingConflict, ConflictResolution[]> | null) => void) | null = null;
	private previewResolve: ((value: ReviewModalResult) => void) | null = null;
	private errorResolve: ((value: ReviewModalResult) => void) | null = null;
	private modalIsOpen = false;
	private intentionalClose = false;

	constructor(
		plugin: TaggableTagsPlugin,
		settings: MigrationSettings,
		detectionResult: ConflictDetectionResult | null = null
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.settings = settings;
		this.detectionResult = detectionResult;
		this.editableResolutions = new Map();
		if (detectionResult) {
			this.initResolutions(detectionResult);
		}
	}

	private initResolutions(detectionResult: ConflictDetectionResult): void {
		this.editableResolutions.clear();
		for (const [conflict, resolutions] of detectionResult.resolutions) {
			this.editableResolutions.set(
				conflict,
				resolutions.map(r => ({ ...r, mergeInto: r.mergeInto ? { ...r.mergeInto } : undefined }))
			);
		}
	}

	updateDetectionResult(detectionResult: ConflictDetectionResult): void {
		this.detectionResult = detectionResult;
		this.initResolutions(detectionResult);
	}

	/** Wait for the user to finish the conflicts page (continue or cancel). */
	waitForConflictsContinue(): Promise<Map<NamingConflict, ConflictResolution[]> | null> {
		return new Promise((resolve) => {
			this.conflictsResolve = resolve;
			this.intentionalClose = false;
			this.step = 'conflicts';
			if (!this.modalIsOpen) {
				this.open();
			} else {
				this.renderConflicts();
			}
		});
	}

	/**
	 * Show generating state, yield to the UI, build the plan, then show preview or an error page.
	 */
	async buildAndShowPreview(buildPlan: () => MigrationPlan): Promise<ReviewModalResult> {
		this.showGenerating();
		await this.yieldToUi();

		let plan: MigrationPlan;
		try {
			plan = buildPlan();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('Migration plan generation failed:', error);
			new Notice(`Failed to generate migration preview: ${message}`);
			return await this.showPlanError(message);
		}

		return this.showPreview(plan);
	}

	private yieldToUi(): Promise<void> {
		return new Promise((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
	}

	private ensureModalVisible(): void {
		if (!this.modalIsOpen) {
			this.open();
		}
	}

	private renderCurrentStep(): void {
		if (this.step === 'preview' && this.plan) {
			this.renderPreview();
		} else if (this.step === 'generating') {
			this.renderGenerating();
		} else if (this.detectionResult) {
			this.renderConflicts();
		} else {
			this.renderGenerating();
		}
	}

	/** Transition to preview when plan is ready. */
	showPreview(plan: MigrationPlan): Promise<ReviewModalResult> {
		this.plan = plan;
		this.step = 'preview';
		return new Promise((resolve) => {
			this.previewResolve = resolve;
			this.intentionalClose = false;
			this.ensureModalVisible();
			this.renderPreview();
		});
	}

	private showPlanError(message: string): Promise<ReviewModalResult> {
		this.step = 'generating';
		return new Promise((resolve) => {
			this.errorResolve = resolve;
			this.ensureModalVisible();
			const { contentEl } = this;
			contentEl.empty();
			contentEl.addClass('taggable-tags-conflict-modal');
			contentEl.createEl('h2', { text: 'Could not generate preview' });
			contentEl.createEl('p', {
				text: message,
				cls: 'taggable-tags-modal-description',
			});

			const showBack = this.detectionResult && hasConflicts(this.detectionResult);
			const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
			new Setting(buttonContainer)
				.addButton((btn) => {
					btn.setButtonText('Back to conflicts');
					btn.setDisabled(!showBack);
					btn.onClick(() => {
						if (showBack) this.finishErrorStep('back');
					});
				})
				.addButton((btn) =>
					btn.setButtonText('Cancel migration').onClick(() => {
						this.finishErrorStep('cancel');
					})
				);
		});
	}

	private finishErrorStep(result: ReviewModalResult): void {
		const resolve = this.errorResolve;
		this.errorResolve = null;
		resolve?.(result);
	}

	showGenerating(): void {
		this.step = 'generating';
		this.renderGenerating();
	}

	getPlan(): MigrationPlan | null {
		return this.plan;
	}

	onOpen() {
		this.modalIsOpen = true;
		this.renderCurrentStep();
	}

	private renderGenerating(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-conflict-modal');
		contentEl.createEl('h2', { text: 'Generating preview…' });
		contentEl.createEl('p', {
			text: 'Building the migration plan. This may take a moment for large vaults.',
			cls: 'taggable-tags-modal-description',
		});
	}

	private renderConflicts(): void {
		if (!this.detectionResult) return;

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-conflict-modal');
		this.step = 'conflicts';

		contentEl.createEl('h2', { text: 'Naming conflicts detected' });

		const renameCount = countRenames(this.editableResolutions);
		contentEl.createEl('p', {
			text: `Found ${this.detectionResult.conflicts.length} naming conflict${this.detectionResult.conflicts.length === 1 ? '' : 's'}. ${renameCount} item${renameCount === 1 ? '' : 's'} will be renamed.`,
			cls: 'taggable-tags-modal-description',
		});

		const warningDiv = contentEl.createDiv({ cls: 'taggable-tags-warning' });
		warningDiv.createEl('p', {
			text: 'Multiple sources would create the same tag name. Choose how to resolve each conflict before migration runs.',
		});

		const conflictsContainer = contentEl.createDiv({ cls: 'taggable-tags-conflicts-container' });
		for (const conflict of this.detectionResult.conflicts) {
			this.renderConflict(conflictsContainer, conflict);
		}

		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
		new Setting(buttonContainer)
			.addButton((btn) =>
				btn.setButtonText('Cancel migration').onClick(() => {
					this.finishConflictsStep(null);
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Continue to preview')
					.setCta()
					.onClick(async () => {
						this.showGenerating();
						await this.yieldToUi();
						this.finishConflictsStep(this.editableResolutions);
					})
			);
	}

	private renderPreview(): void {
		if (!this.plan) return;

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-migration-preview-modal');
		this.step = 'preview';

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
			this.renderPreviewSection(
				changesContainer,
				`${kindLabel(kind)} (${ops.length})`,
				ops.map(op => describeOp(op))
			);
		}

		if (this.plan.emptyFolders.length > 0) {
			this.renderPreviewSection(
				changesContainer,
				`Empty folders (${this.plan.emptyFolders.length})`,
				this.plan.emptyFolders.slice(0, 10).map(path => ({
					primary: path,
					secondary: '(handled after migration)',
				}))
			);
		}

		const showBack = this.detectionResult && hasConflicts(this.detectionResult);
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });

		new Setting(buttonContainer)
			.addButton((btn) => {
				btn.setButtonText('Back to conflicts');
				btn.setDisabled(!showBack);
				btn.onClick(() => {
					if (showBack) this.finishPreviewStep('back');
				});
			})
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => {
					this.finishPreviewStep('cancel');
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply migration')
					.setCta()
					.setDisabled(summary.total === 0)
					.onClick(() => {
						this.finishPreviewStep('apply');
					})
			);
	}

	private finishConflictsStep(result: Map<NamingConflict, ConflictResolution[]> | null): void {
		const resolve = this.conflictsResolve;
		this.conflictsResolve = null;
		resolve?.(result);
	}

	private finishPreviewStep(result: ReviewModalResult): void {
		const resolve = this.previewResolve;
		this.previewResolve = null;
		resolve?.(result);
	}

	private renderConflict(container: HTMLElement, conflict: NamingConflict): void {
		const section = container.createDiv({ cls: 'taggable-tags-conflict-section' });
		section.createEl('h4', {
			text: `"${conflict.name}"`,
			cls: 'taggable-tags-conflict-header',
		});

		const resolutions = this.editableResolutions.get(conflict) || [];
		const keeper = resolutions.find(r => r.kind === 'keep' || r.keepsOriginalName);

		for (const resolution of resolutions) {
			this.renderResolution(section, conflict, resolution, keeper);
		}
	}

	private renderResolution(
		container: HTMLElement,
		conflict: NamingConflict,
		resolution: ConflictResolution,
		keeper: ConflictResolution | undefined
	): void {
		const item = container.createDiv({ cls: 'taggable-tags-conflict-item' });
		const source = resolution.source;
		const isKeeper = resolution.kind === 'keep' || resolution.keepsOriginalName;

		const labelRow = item.createDiv({ cls: 'taggable-tags-conflict-item-label' });
		labelRow.createSpan({ text: this.getSourceIcon(source), cls: 'taggable-tags-conflict-icon' });
		appendSourceDescription(labelRow, source);

		const actionRow = item.createDiv({ cls: 'taggable-tags-conflict-item-actions' });

		if (isKeeper) {
			actionRow.createSpan({ text: '✓ keeps name', cls: 'taggable-tags-conflict-keeps' });
			return;
		}

		const kinds = getAvailableResolutionKinds(source);
		const primaryRow = actionRow.createDiv({ cls: 'taggable-tags-conflict-primary' });
		const select = primaryRow.createEl('select', { cls: 'taggable-tags-conflict-select' });
		for (const kind of kinds) {
			if (kind === 'keep') continue;
			const opt = select.createEl('option', { value: kind, text: this.kindLabel(kind) });
			if (resolution.kind === kind) opt.selected = true;
		}
		if (!kinds.includes(resolution.kind) || resolution.kind === 'keep') {
			select.value = resolution.kind === 'keep' ? 'rename' : resolution.kind;
		}

		const detailArea = actionRow.createDiv({ cls: 'taggable-tags-conflict-detail' });

		const renderDetail = () => {
			detailArea.empty();
			primaryRow.querySelectorAll('.taggable-tags-conflict-input').forEach(el => el.remove());
			const kind = select.value as ResolutionKind;
			resolution.kind = kind;
			resolution.keepsOriginalName = false;

			if (kind === 'rename') {
				const nameInput = primaryRow.createEl('input', {
					type: 'text',
					value: resolution.newName,
					cls: 'taggable-tags-conflict-input',
				});
				nameInput.addEventListener('change', () => {
					resolution.newName = nameInput.value.trim() || resolution.newName;
				});

				if (keeper && sourceSupportsKeeperAsParent(source)) {
					resolution.keeperIsParent = resolution.keeperIsParent !== false;
					const toggleLabel = detailArea.createEl('label', { cls: 'taggable-tags-conflict-parent-toggle' });
					const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
					toggle.checked = resolution.keeperIsParent !== false;
					toggleLabel.createSpan({
						text: ` Add #${keeper.source.name} as a parent`,
					});
					toggle.addEventListener('change', () => {
						resolution.keeperIsParent = toggle.checked;
					});
				}
			}

			if (kind === 'merge' && keeper) {
				resolution.mergeInto = keeper.source;
				detailArea.createSpan({
					text: `Merge into ${describeSource(keeper.source)}`,
					cls: 'taggable-tags-conflict-extra',
				});
			}

			if (kind === 'delete') {
				detailArea.createSpan({
					text: 'This source will be removed and will not create a tag.',
					cls: 'taggable-tags-conflict-extra',
				});
			}
		};

		select.addEventListener('change', renderDetail);
		renderDetail();
	}

	private renderPreviewSection(
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

	private kindLabel(kind: ResolutionKind): string {
		switch (kind) {
			case 'rename': return 'Rename';
			case 'merge': return 'Merge';
			case 'delete': return 'Delete';
			default: return kind;
		}
	}

	private getSourceIcon(source: TagSource): string {
		switch (source.type) {
			case 'folder': return '📁';
			case 'existing-tag': return '🏷️';
			case 'matching-note': return '📄';
			case 'nested-tag': return '#';
			default: return '?';
		}
	}

	closeReview(): void {
		this.intentionalClose = true;
		this.close();
	}

	onClose() {
		this.modalIsOpen = false;
		const { contentEl } = this;
		contentEl.empty();
		if (this.intentionalClose) {
			this.intentionalClose = false;
			return;
		}
		if (this.conflictsResolve) {
			this.conflictsResolve(null);
			this.conflictsResolve = null;
		}
		if (this.previewResolve) {
			this.previewResolve('cancel');
			this.previewResolve = null;
		}
		if (this.errorResolve) {
			this.errorResolve('cancel');
			this.errorResolve = null;
		}
	}
}
