import { Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * A migration step with its status.
 */
export interface MigrationStep {
	id: string;
	name: string;
	status: 'pending' | 'in_progress' | 'completed' | 'skipped';
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
	private resolvePromise: (() => void) | null = null;
	
	// UI elements for updating
	private stepsContainer: HTMLElement | null = null;
	private statusText: HTMLElement | null = null;
	private continueButton: HTMLButtonElement | null = null;

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
	 * Mark the current step as completed.
	 */
	completeStep(stepId: string): void {
		const step = this.steps.find(s => s.id === stepId);
		if (step) {
			step.status = 'completed';
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
	 * Mark the migration as complete and allow closing.
	 */
	setComplete(): void {
		this.isComplete = true;
		this.updateUI();
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

		// Button container (hidden until complete)
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
		
		const setting = new Setting(buttonContainer);
		setting.addButton((btn) => {
			this.continueButton = btn.buttonEl;
			btn
				.setButtonText('Continue')
				.setCta()
				.setDisabled(true)
				.onClick(() => {
					this.resolvePromise?.();
					this.close();
				});
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
				this.statusText.textContent = 'Migration complete!';
				this.statusText.addClass('taggable-tags-progress-complete');
			} else if (this.currentStepIndex >= 0 && this.currentStepIndex < this.steps.length) {
				const currentStep = this.steps[this.currentStepIndex];
				this.statusText.textContent = currentStep.name + '...';
			}
		}

		// Enable continue button when complete
		if (this.continueButton) {
			this.continueButton.disabled = !this.isComplete;
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
