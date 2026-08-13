import { Notice, Modal, Setting } from 'obsidian';
import type TaggableTagsPlugin from '../main';

/**
 * Information about a circular relationship chain.
 */
interface CircularChain {
	tags: string[];
	cycle: string[]; // The actual cycle within the chain
}

/**
 * Find and display all circular tag relationships in the vault.
 */
export async function findCircularTags(plugin: TaggableTagsPlugin): Promise<void> {
	new Notice('Scanning for circular relationships...');
	
	// Get circular tags from the tag index
	const circularTags = plugin.tagIndex.getCircularTags();
	
	// Find the actual cycles (if any)
	const cycles = circularTags.size > 0 ? findCycles(plugin, circularTags) : [];
	
	// Always show results in a modal
	const modal = new CircularTagsModal(plugin, circularTags, cycles);
	modal.open();
}

/**
 * Find the actual cycles among the circular tags.
 */
function findCycles(plugin: TaggableTagsPlugin, circularTags: Set<string>): CircularChain[] {
	const cycles: CircularChain[] = [];
	const visited = new Set<string>();
	
	for (const tag of circularTags) {
		if (visited.has(tag)) continue;
		
		// Find the cycle starting from this tag
		const cycle = traceCycle(plugin, tag, circularTags);
		if (cycle.length > 0) {
			// Mark all tags in this cycle as visited
			for (const t of cycle) {
				visited.add(t);
			}
			
			cycles.push({
				tags: cycle,
				cycle: cycle,
			});
		}
	}
	
	return cycles;
}

/**
 * Trace a cycle starting from a given tag.
 */
function traceCycle(
	plugin: TaggableTagsPlugin, 
	startTag: string, 
	circularTags: Set<string>
): string[] {
	const path: string[] = [];
	const pathSet = new Set<string>();
	let current = startTag;
	
	while (true) {
		if (pathSet.has(current)) {
			// Found the cycle - extract it
			const cycleStart = path.indexOf(current);
			return path.slice(cycleStart);
		}
		
		path.push(current);
		pathSet.add(current);
		
		// Get children (tags that have this tag as parent)
		const children = plugin.tagIndex.getChildTags(current);
		
		// Find a child that's in the circular set
		const nextTag = children.find(c => circularTags.has(c));
		if (!nextTag) {
			// No circular child found, try parents
			const parents = plugin.tagIndex.getParentTags(current);
			const nextParent = parents.find(p => circularTags.has(p) && !pathSet.has(p));
			if (!nextParent) {
				return path; // Can't continue
			}
			current = nextParent;
		} else {
			current = nextTag;
		}
		
		// Safety limit
		if (path.length > 100) {
			console.warn('Cycle detection exceeded limit');
			return path;
		}
	}
}

/**
 * Modal to display circular tag relationships.
 */
class CircularTagsModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private circularTags: Set<string>;
	private cycles: CircularChain[];

	constructor(plugin: TaggableTagsPlugin, circularTags: Set<string>, cycles: CircularChain[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.circularTags = circularTags;
		this.cycles = cycles;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('taggable-tags-circular-modal');

		contentEl.createEl('h2', { text: 'Circular tag relationships' });

		// Handle case when no circular relationships found
		if (this.circularTags.size === 0) {
			contentEl.createEl('p', {
				text: 'No circular relationships found.',
				cls: 'taggable-tags-modal-description',
			});
			
			const successDiv = contentEl.createDiv({ cls: 'taggable-tags-success' });
			successDiv.createEl('p', {
				text: 'Your tag hierarchy is free of circular relationships.',
			});
			
			// Close button
			const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
			new Setting(buttonContainer)
				.addButton((btn) =>
					btn
						.setButtonText('Close')
						.setCta()
						.onClick(() => this.close())
				);
			return;
		}

		contentEl.createEl('p', {
			text: `Found ${this.circularTags.size} tag${this.circularTags.size === 1 ? '' : 's'} involved in circular relationships.`,
			cls: 'taggable-tags-modal-description',
		});

		// Warning
		const warningDiv = contentEl.createDiv({ cls: 'taggable-tags-warning' });
		warningDiv.createEl('p', {
			text: 'Circular relationships occur when tags form a loop in their parent-child hierarchy (e.g., a → b → c → a).',
		});

		// List all circular tags
		const tagsSection = contentEl.createDiv({ cls: 'taggable-tags-circular-section' });
		tagsSection.createEl('h4', { text: 'Tags involved:' });
		
		const tagsList = tagsSection.createEl('ul', { cls: 'taggable-tags-circular-list' });
		for (const tag of Array.from(this.circularTags).sort()) {
			const li = tagsList.createEl('li');
			
			// Tag name with link to tag file
			const tagFile = this.plugin.tagIndex.getTagFile(tag);
			if (tagFile) {
				const link = li.createEl('a', { 
					text: `#${tag}`,
					cls: 'taggable-tags-circular-tag-link',
				});
				link.addEventListener('click', (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(tagFile.path, '', false);
					this.close();
				});
			} else {
				li.createSpan({ text: `#${tag}` });
			}
			
			// Show parent-child info
			const parents = this.plugin.tagIndex.getParentTags(tag);
			const children = this.plugin.tagIndex.getChildTags(tag);
			
			if (parents.length > 0 || children.length > 0) {
				const info = li.createSpan({ cls: 'taggable-tags-circular-info' });
				if (parents.length > 0) {
					info.createSpan({ text: ` ← ${parents.map(p => '#' + p).join(', ')}` });
				}
				if (children.length > 0) {
					info.createSpan({ text: ` → ${children.map(c => '#' + c).join(', ')}` });
				}
			}
		}

		// Show cycles
		if (this.cycles.length > 0) {
			const cyclesSection = contentEl.createDiv({ cls: 'taggable-tags-circular-section' });
			cyclesSection.createEl('h4', { text: 'Detected cycles:' });
			
			for (const chain of this.cycles) {
				const cycleDiv = cyclesSection.createDiv({ cls: 'taggable-tags-cycle' });
				const cycleText = chain.cycle.map(t => `#${t}`).join(' → ') + ` → #${chain.cycle[0]}`;
				cycleDiv.createSpan({ text: cycleText });
			}
		}

		// Close button
		const buttonContainer = contentEl.createDiv({ cls: 'taggable-tags-button-container' });
		new Setting(buttonContainer)
			.addButton((btn) =>
				btn
					.setButtonText('Close')
					.setCta()
					.onClick(() => this.close())
			);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
