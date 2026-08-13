import { ButtonComponent, Modal, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * A migration step with its status.
 */
export interface MigrationStep {
	id: string;
	name: string;
	status: 'pending' | 'in_progress' | 'completed' | 'skipped' | 'completed_with_errors';
}

/**
 * An error that occurred during migration.
 */
export interface MigrationError {
	step: string;
	message: string;
	file?: string;
}

/**
 * Modal that shows migration progress with step tracking.
 * Stays open during migration and prevents closing until complete.
 */
export class MigrationProgressModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private steps: MigrationStep[];
	private currentStepIndex: number = -1;
	private isComplete: boolean = false;
	private errors: MigrationError[] = [];
	private errorNotePath: string | null = null;
	private resolvePromise: (() => void) | null = null;
	
	// UI elements for updating
	private stepsContainer: HTMLElement | null = null;
	private statusText: HTMLElement | null = null;
	private errorInfoContainer: HTMLElement | null = null;
	private continueButtonComponent: ButtonComponent | null = null;

	constructor(plugin: TaggableTagsPlugin, steps: MigrationStep[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.steps = steps;
	}

	/**
	 * Open the modal and return a promise that resolves when the user clicks Continue.
	 */
	start(): Promise<void> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	/**
	 * Update the current step to in_progress.
	 */
	startStep(stepId: string): void {
		const stepIndex = this.steps.findIndex(s => s.id === stepId);
		if (stepIndex === -1) return;
		
		this.currentStepIndex = stepIndex;
		this.steps[stepIndex].status = 'in_progress';
		this.updateUI();
	}

	/**
	 * Mark the current step as completed (with or without errors).
	 */
	completeStep(stepId: string, hadErrors: boolean = false): void {
		const step = this.steps.find(s => s.id === stepId);
		if (step) {
			step.status = hadErrors ? 'completed_with_errors' : 'completed';
			this.updateUI();
		}
	}

	/**
	 * Mark a step as skipped.
	 */
	skipStep(stepId: string): void {
		const step = this.steps.find(s => s.id === stepId);
		if (step) {
			step.status = 'skipped';
			this.updateUI();
		}
	}

	/**
	 * Add an error that occurred during migration.
	 * The migration continues, but the error is tracked.
	 */
	addError(step: string, message: string, file?: string): void {
		this.errors.push({ step, message, file });
	}

	/**
	 * Mark the migration as complete and allow closing.
	 */
	setComplete(errorNotePath?: string): void {
		this.isComplete = true;
		this.errorNotePath = errorNotePath || null;
		this.updateUI();
	}

	/**
	 * Check if there were any errors during migration.
	 */
	hasErrors(): boolean {
		return this.errors.length > 0;
	}

	/**
	 * Get all errors that occurred.
	 */
	getErrors(): MigrationError[] {
		return this.errors;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-progress-modal');

		contentEl.createEl('h2', { text: 'Migration in progress' });

		// Status text
		this.statusText = contentEl.createEl('p', {
			text: 'Starting migration...',
			cls: 'taggable-tags-progress-status',
		});

		// Steps container
		this.stepsContainer = contentEl.createDiv({ cls: 'taggable-tags-progress-steps' });
		this.renderSteps();

		// Error info container (hidden by default, shown at the end if there are errors)
		this.errorInfoContainer = contentEl.createDiv({ cls: 'taggable-tags-progress-error-info is-hidden' });

		// Button container
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
		
		this.continueButtonComponent = new ButtonComponent(buttonContainer)
			.setButtonText('Continue')
			.setCta()
			.setDisabled(true)
			.onClick(() => {
				if (this.isComplete) {
					this.resolvePromise?.();
					this.close();
				}
			});

		this.updateUI();
	}

	private renderSteps(): void {
		if (!this.stepsContainer) return;
		this.stepsContainer.empty();

		for (const step of this.steps) {
			const stepEl = this.stepsContainer.createDiv({ 
				cls: `taggable-tags-progress-step taggable-tags-progress-step-${step.status}`,
			});
			
			// Status icon
			let icon = '○'; // pending
			if (step.status === 'in_progress') icon = '◐';
			else if (step.status === 'completed') icon = '✓';
			else if (step.status === 'skipped') icon = '–';
			else if (step.status === 'completed_with_errors') icon = '⚠';
			
			stepEl.createSpan({ text: icon, cls: 'taggable-tags-progress-icon' });
			stepEl.createSpan({ text: step.name, cls: 'taggable-tags-progress-name' });
		}
	}

	private updateUI(): void {
		// Update steps display
		this.renderSteps();

		// Update status text
		if (this.statusText) {
			if (this.isComplete) {
				if (this.errors.length > 0) {
					this.statusText.textContent = `Migration complete with ${this.errors.length} error${this.errors.length === 1 ? '' : 's'}`;
					this.statusText.removeClass('taggable-tags-progress-complete');
					this.statusText.addClass('taggable-tags-progress-warning');
				} else {
					this.statusText.textContent = 'Migration complete!';
					this.statusText.addClass('taggable-tags-progress-complete');
				}
			} else if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
				const currentStep = this.steps[this.currentStepIndex];
				this.statusText.textContent = currentStep.name + '...';
			}
		}

		// Show error info when complete with errors
		if (this.errorInfoContainer && this.isComplete && this.errors.length > 0 && this.errorNotePath) {
			this.errorInfoContainer.removeClass('is-hidden');
			this.errorInfoContainer.empty();
			
			this.errorInfoContainer.createEl('p', { 
				text: `A note with all errors has been created at:`,
			});
			
			const link = this.errorInfoContainer.createEl('a', {
				text: this.errorNotePath,
				cls: 'taggable-tags-error-note-link',
				href: '#',
			});
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const file = this.plugin.app.vault.getAbstractFileByPath(this.errorNotePath!);
				if (file instanceof TFile) {
					void this.plugin.app.workspace.getLeaf().openFile(file);
				}
			});
			
			this.errorInfoContainer.createEl('p', {
				text: 'You can review and fix the errors, then delete the note when done.',
				cls: 'taggable-tags-error-note-hint',
			});
		}

		// Enable continue button when complete
		if (this.continueButtonComponent) {
			this.continueButtonComponent.setDisabled(!this.isComplete);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		
		// If closed before complete (shouldn't happen normally), resolve anyway
		this.resolvePromise?.();
		this.resolvePromise = null;
	}
}
