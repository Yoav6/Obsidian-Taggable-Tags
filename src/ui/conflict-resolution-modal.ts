import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import {
	ConflictDetectionResult,
	NamingConflict,
	ConflictResolution,
	TagSource,
	countRenames,
	getAvailableResolutionKinds,
	describeSource,
	sourceSupportsKeeperAsParent,
	type ResolutionKind,
} from '../migration/conflict-detector';
import { appendSourceDescription } from './path-display';

/**
 * Modal for reviewing and editing conflict resolutions before migration.
 */
export class ConflictResolutionModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private detectionResult: ConflictDetectionResult;
	private resolvePromise: ((value: Map<NamingConflict, ConflictResolution[]> | null) => void) | null = null;
	private userMadeChoice = false;
	private editableResolutions: Map<NamingConflict, ConflictResolution[]>;

	constructor(plugin: TaggableTagsPlugin, detectionResult: ConflictDetectionResult) {
		super(plugin.app);
		this.plugin = plugin;
		this.detectionResult = detectionResult;
		this.editableResolutions = new Map();
		for (const [conflict, resolutions] of detectionResult.resolutions) {
			this.editableResolutions.set(conflict, resolutions.map(r => ({ ...r, mergeInto: r.mergeInto ? { ...r.mergeInto } : undefined })));
		}
	}

	prompt(): Promise<Map<NamingConflict, ConflictResolution[]> | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.userMadeChoice = false;
			this.open();
		});
	}

	showGeneratingPreview(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-conflict-modal');
		contentEl.createEl('h2', { text: 'Generating preview…' });
		contentEl.createEl('p', {
			text: 'Building the migration plan. This may take a moment for large vaults.',
			cls: 'taggable-tags-modal-description',
		});
	}

	closeAfterPreview(): void {
		this.userMadeChoice = true;
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-conflict-modal');

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
					this.userMadeChoice = true;
					this.resolvePromise?.(null);
					this.resolvePromise = null;
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText('Continue to preview')
					.setCta()
					.onClick(() => {
						this.userMadeChoice = true;
						const resolve = this.resolvePromise;
						this.resolvePromise = null;
						resolve?.(this.editableResolutions);
						this.showGeneratingPreview();
					})
			);
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
		const select = actionRow.createEl('select', { cls: 'taggable-tags-conflict-select' });
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
			const kind = select.value as ResolutionKind;
			resolution.kind = kind;
			resolution.keepsOriginalName = false;

			if (kind === 'rename') {
				const nameInput = detailArea.createEl('input', {
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

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.userMadeChoice && this.resolvePromise) {
			this.resolvePromise(null);
		}
		this.resolvePromise = null;
	}
}
