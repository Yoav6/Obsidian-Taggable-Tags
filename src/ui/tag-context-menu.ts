import { Menu, Modal, Notice, TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { renameTag } from '../sync/rename-command';
import { activateTagExplorerView } from './tag-explorer-view';
import { showDeleteTagModal } from './delete-tag-modal';
import { createTagFile } from '../sync/auto-create';
import { markPluginInitiatedChange } from '../sync/file-rename-sync';

function formatTagList(tags: string[]): string {
	return tags.map(t => `#${t}`).join(', ');
}

/**
 * Adds tag-related context menu items to an existing menu.
 * Used to extend the editor context menu and property tag menus.
 * @param sourceFile - The file where the tag is located (for replace operations)
 */
export function addTagContextMenuItems(
	plugin: TaggableTagsPlugin,
	menu: Menu,
	tagName: string,
	sourceFile?: TFile
): void {
	menu.addSeparator();

	// Open tag file
	menu.addItem((item) => {
		item.setTitle('Open tag file')
			.setIcon('file-text')
			.onClick(async () => {
				const tagFile = plugin.tagIndex.getTagFile(tagName);
				if (tagFile) {
					await plugin.app.workspace.getLeaf().openFile(tagFile);
				} else {
					new Notice(`No tag file found for #${tagName}`);
				}
			});
	});

	// Rename tag
	menu.addItem((item) => {
		item.setTitle('Rename tag')
			.setIcon('pencil')
			.onClick(() => {
				new RenameTagModal(plugin, tagName).open();
			});
	});

	menu.addSeparator();

	// Add "New" submenu with create options (and replace options if in note context)
	addNewSubmenu(plugin, menu, [tagName], undefined, sourceFile);

	menu.addSeparator();

	// Filter by tag
	menu.addItem((item) => {
		item.setTitle('Filter by tag')
			.setIcon('filter')
			.onClick(async () => {
				const explorerView = await activateTagExplorerView(plugin);
				if (explorerView) {
					explorerView.setFilterTag(tagName);
				}
			});
	});

	// Filter out tag (exclude)
	menu.addItem((item) => {
		item.setTitle('Filter out tag')
			.setIcon('filter-x')
			.onClick(async () => {
				const explorerView = await activateTagExplorerView(plugin);
				if (explorerView) {
					explorerView.addExcludeTagPublic(tagName);
				}
			});
	});

	// Add delete submenu
	addDeleteTagSubmenu(plugin, menu, tagName);
}

/**
 * Adds a "New" submenu with create options (and replace options if sourceFile is provided).
 * Can be used from both tag-context-menu and tag-explorer-view.
 * @param sourceFile - If provided, includes "Replace with..." options (only for note context)
 */
export function addNewSubmenu(
	plugin: TaggableTagsPlugin,
	menu: Menu,
	tagNames: string[],
	onComplete?: () => void,
	sourceFile?: TFile
): void {
	const multi = tagNames.length > 1;

	menu.addItem((item) => {
		const submenu = (item as any)
			.setTitle('New')
			.setIcon('plus')
			.setSubmenu();

		submenu.addItem((subItem: any) => {
			subItem
				.setTitle(multi ? 'New file with tags' : 'New file with tag')
				.setIcon('file-plus')
				.onClick(async () => {
					await createNewFileWithTags(plugin, tagNames);
					if (onComplete) onComplete();
				});
		});

		submenu.addSeparator();

		submenu.addItem((subItem: any) => {
			subItem
				.setTitle('New child tag')
				.setIcon('corner-down-right')
				.onClick(() => {
					new CreateChildTagModal(plugin, tagNames, onComplete).open();
				});
		});

		submenu.addItem((subItem: any) => {
			subItem
				.setTitle('New parent tag')
				.setIcon('corner-right-up')
				.onClick(() => {
					openCreateParentTagModal(plugin, tagNames, onComplete);
				});
		});

		// Replace options only apply to a single tag in note context
		if (sourceFile && tagNames.length === 1) {
			const tagName = tagNames[0];
			submenu.addSeparator();

			submenu.addItem((subItem: any) => {
				subItem
					.setTitle('Replace with child tag')
					.setIcon('arrow-down-right')
					.onClick(() => {
						new ReplaceWithChildTagModal(plugin, tagName, sourceFile).open();
					});
			});

			submenu.addItem((subItem: any) => {
				subItem
					.setTitle('Replace with parent tag')
					.setIcon('arrow-up-right')
					.onClick(() => {
						new ReplaceWithParentTagModal(plugin, tagName, sourceFile).open();
					});
			});
		}
	});
}

/**
 * Adds a top-level "New parent tag" menu item for mixed tag/file selections.
 * The new parent is linked to selected tags and added as a regular tag on selected files.
 */
export function addNewParentTagMenuItem(
	plugin: TaggableTagsPlugin,
	menu: Menu,
	childTags: string[],
	childFiles: TFile[],
	onComplete?: () => void
): void {
	menu.addItem((item) => {
		item.setTitle('New parent tag')
			.setIcon('corner-right-up')
			.onClick(() => {
				openCreateParentTagModal(plugin, childTags, onComplete, childFiles);
			});
	});
}

function openCreateParentTagModal(
	plugin: TaggableTagsPlugin,
	childTags: string[],
	onComplete?: () => void,
	childFiles?: TFile[]
): void {
	new CreateParentTagModal(plugin, childTags, onComplete, childFiles).open();
}

/**
 * Adds a "Delete tag" submenu with three deletion options.
 * Can be used from both tag-context-menu and tag-explorer-view.
 */
export function addDeleteTagSubmenu(
	plugin: TaggableTagsPlugin,
	menu: Menu,
	tagName: string,
	onComplete?: () => void
): void {
	menu.addSeparator();

	// Create submenu for delete options
	menu.addItem((item) => {
		const submenu = (item as any)
			.setTitle('Delete tag')
			.setIcon('trash-2')
			.setSubmenu();

		// Option 1: Delete file and all instances
		submenu.addItem((subItem: any) => {
			subItem
				.setTitle('Delete file and all instances')
				.setIcon('file-x')
				.onClick(() => {
					showDeleteTagModal(plugin, tagName, 'instances', onComplete);
				});
		});

		// Option 2: Delete tag and exclusive children
		submenu.addItem((subItem: any) => {
			subItem
				.setTitle('Delete tag and exclusive children')
				.setIcon('git-branch')
				.onClick(() => {
					showDeleteTagModal(plugin, tagName, 'exclusive', onComplete);
				});
		});

		// Option 3: Delete tag and all children
		submenu.addItem((subItem: any) => {
			subItem
				.setTitle('Delete tag and all children')
				.setIcon('trash')
				.onClick(() => {
					showDeleteTagModal(plugin, tagName, 'all', onComplete);
				});
		});
	});
}

/**
 * Modal for renaming a tag.
 * This is a copy of the modal from tag-explorer-view.ts to avoid circular dependencies.
 */
class RenameTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private oldTag: string;
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, oldTag: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.oldTag = oldTag;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		contentEl.createEl('h3', { text: `Rename tag #${this.oldTag}` });
		
		const inputContainer = contentEl.createEl('div', { cls: 'rename-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			value: this.oldTag,
			cls: 'rename-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		this.inputEl.select();
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performRename();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'rename-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const renameBtn = buttonContainer.createEl('button', { text: 'Rename', cls: 'mod-cta' });
		renameBtn.addEventListener('click', () => this.performRename());
	}

	private async performRename(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTag = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTag = newTag.startsWith('#') ? newTag.slice(1) : newTag;
		
		if (newTag === this.oldTag) {
			new Notice('New tag name is the same as the old one');
			return;
		}

		if (!newTag) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTag.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		try {
			this.close();
			await renameTag(this.plugin, this.oldTag, newTag);
			new Notice(`Renamed #${this.oldTag} to #${newTag}`);
		} catch (error) {
			new Notice(`Failed to rename tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Creates a new note file in the vault root and tags it with the specified tag.
 * Opens the file and focuses on the inline title for immediate renaming.
 */
async function createNewFileWithTags(plugin: TaggableTagsPlugin, tagNames: string[]): Promise<void> {
	try {
		const baseName = 'Untitled';
		let fileName = `${baseName}.md`;
		let counter = 1;

		while (plugin.app.vault.getAbstractFileByPath(fileName)) {
			fileName = `${baseName} ${counter}.md`;
			counter++;
		}

		const tagsYaml = tagNames.map(t => `  - ${t}`).join('\n');
		const content = `---\ntags:\n${tagsYaml}\n---\n`;
		const file = await plugin.app.vault.create(fileName, content);
		
		// Open the new file
		const leaf = plugin.app.workspace.getLeaf();
		await leaf.openFile(file);
		
		// Focus the inline title and select it after a short delay to ensure the view is ready
		setTimeout(() => {
			const view = leaf.view;
			if (view && (view as any).contentEl) {
				// Find the inline title element
				const inlineTitle = (view as any).contentEl.querySelector('.inline-title');
				if (inlineTitle) {
					// Focus and select all text in the inline title
					inlineTitle.focus();
					
					// Select all text
					const selection = window.getSelection();
					const range = document.createRange();
					range.selectNodeContents(inlineTitle);
					selection?.removeAllRanges();
					selection?.addRange(range);
				}
			}
		}, 100);
	} catch (error) {
		console.error('Failed to create file with tag:', error);
		new Notice(`Failed to create file: ${error}`);
	}
}

/**
 * Modal for creating a child tag.
 * Creates a new tag file and tags it with the parent tag.
 */
class CreateChildTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private parentTags: string[];
	private inputEl: HTMLInputElement | null = null;
	private onComplete: (() => void) | null;

	constructor(plugin: TaggableTagsPlugin, parentTags: string[], onComplete?: () => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.parentTags = parentTags;
		this.onComplete = onComplete ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		const multi = this.parentTags.length > 1;

		contentEl.createEl('h3', { text: `Create child tag of ${formatTagList(this.parentTags)}` });

		const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
		descEl.textContent = multi
			? 'The new tag will be created with all selected tags in its tags property.'
			: 'The new tag will be created with the parent tag in its tags property.';
		descEl.style.marginBottom = '16px';
		
		const inputContainer = contentEl.createEl('div', { cls: 'create-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		const labelEl = inputContainer.createEl('label');
		labelEl.textContent = 'New tag name';
		labelEl.style.display = 'block';
		labelEl.style.marginBottom = '4px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter tag name...',
			cls: 'create-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performCreate();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'create-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performCreate());
		
		// Focus the input
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private async performCreate(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTagName = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTagName = newTagName.startsWith('#') ? newTagName.slice(1) : newTagName;
		
		if (!newTagName) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTagName.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		newTagName = this.plugin.tagIndex.normalizeTag(newTagName);

		// Check if tag already exists
		const existingFile = this.plugin.tagIndex.getTagFile(newTagName);
		if (existingFile) {
			new Notice(`Tag #${newTagName} already exists`);
			return;
		}

		try {
			this.close();
			
			// Create the tag file
			const tagFile = await createTagFile(this.plugin, newTagName);
			if (!tagFile) {
				new Notice('Failed to create tag file');
				return;
			}
			
			// Add all parent tags to the new tag file's tags property
			for (const parentTag of this.parentTags) {
				await addTagToFile(this.plugin, tagFile, parentTag);
			}

			await this.plugin.tagIndex.rebuild();

			await this.plugin.app.workspace.getLeaf().openFile(tagFile);

			const parentLabel = formatTagList(this.parentTags);
			new Notice(`Created child tag #${newTagName} under ${parentLabel}`);
			
			// Call completion callback if provided
			if (this.onComplete) {
				this.onComplete();
			}
		} catch (error) {
			console.error('Failed to create child tag:', error);
			new Notice(`Failed to create child tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for creating a parent tag.
 * Creates a new tag file and adds it to selected child tags' tags properties.
 * Optionally also tags selected non-tag files with the new parent (without converting them to tags).
 */
class CreateParentTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private childTags: string[];
	private childFiles: TFile[];
	private inputEl: HTMLInputElement | null = null;
	private onComplete: (() => void) | null;

	constructor(
		plugin: TaggableTagsPlugin,
		childTags: string[],
		onComplete?: () => void,
		childFiles?: TFile[]
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.childTags = childTags;
		this.childFiles = childFiles ?? [];
		this.onComplete = onComplete ?? null;
	}

	onOpen(): void {
		const { contentEl } = this;
		const hasFiles = this.childFiles.length > 0;
		const hasTags = this.childTags.length > 0;
		const multi = this.childTags.length + this.childFiles.length > 1;

		contentEl.createEl('h3', { text: `Create parent tag for ${this.formatTargets()}` });

		const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
		if (hasTags && hasFiles) {
			descEl.textContent = multi
				? 'Selected tags will gain the new parent in their tags property. Selected files will be tagged with it (without becoming tag files).'
				: 'The selected tag will gain the new parent, and the selected file will be tagged with it.';
		} else if (hasFiles) {
			descEl.textContent = multi
				? 'Each selected file will be tagged with the new parent (without becoming tag files).'
				: 'The selected file will be tagged with the new parent (without becoming a tag file).';
		} else {
			descEl.textContent = multi
				? 'Each selected tag will be updated to include the new parent in its tags property.'
				: 'The original tag will be updated to include the new parent in its tags property.';
		}
		descEl.style.marginBottom = '16px';
		
		const inputContainer = contentEl.createEl('div', { cls: 'create-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		const labelEl = inputContainer.createEl('label');
		labelEl.textContent = 'New parent tag name';
		labelEl.style.display = 'block';
		labelEl.style.marginBottom = '4px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter tag name...',
			cls: 'create-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performCreate();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'create-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Create', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performCreate());
		
		// Focus the input
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private formatTargets(): string {
		const parts: string[] = [];
		if (this.childTags.length > 0) {
			parts.push(formatTagList(this.childTags));
		}
		if (this.childFiles.length === 1) {
			parts.push(this.childFiles[0].basename);
		} else if (this.childFiles.length > 1) {
			parts.push(`${this.childFiles.length} files`);
		}
		return parts.join(' and ');
	}

	private async performCreate(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTagName = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTagName = newTagName.startsWith('#') ? newTagName.slice(1) : newTagName;
		
		if (!newTagName) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name (no spaces, no special chars that would break tags)
		if (newTagName.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		newTagName = this.plugin.tagIndex.normalizeTag(newTagName);

		// Check if tag already exists
		const existingFile = this.plugin.tagIndex.getTagFile(newTagName);
		if (existingFile) {
			new Notice(`Tag #${newTagName} already exists`);
			return;
		}

		try {
			this.close();
			
			// Create the new parent tag file
			const parentTagFile = await createTagFile(this.plugin, newTagName);
			if (!parentTagFile) {
				new Notice('Failed to create parent tag file');
				return;
			}
			
			// Link each child tag to the new parent
			for (const childTag of this.childTags) {
				const childTagFile = this.plugin.tagIndex.getTagFile(childTag);
				if (childTagFile) {
					await addTagToFile(this.plugin, childTagFile, newTagName);
				} else {
					const newChildFile = await createTagFile(this.plugin, childTag);
					if (newChildFile) {
						await addTagToFile(this.plugin, newChildFile, newTagName);
					}
				}
			}

			// Tag selected non-tag files with the new parent (do not convert them to tag files)
			for (const file of this.childFiles) {
				await addTagToFile(this.plugin, file, newTagName);
			}

			await this.plugin.tagIndex.rebuild();

			await this.plugin.app.workspace.getLeaf().openFile(parentTagFile);

			new Notice(`Created parent tag #${newTagName} for ${this.formatTargets()}`);
			
			// Call completion callback if provided
			if (this.onComplete) {
				this.onComplete();
			}
		} catch (error) {
			console.error('Failed to create parent tag:', error);
			new Notice(`Failed to create parent tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Adds a tag to a file's frontmatter tags array.
 */
async function addTagToFile(plugin: TaggableTagsPlugin, file: TFile, tagToAdd: string): Promise<void> {
	const content = await plugin.app.vault.read(file);
	
	// Check if file has frontmatter
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const match = content.match(frontmatterRegex);
	
	let newContent: string;
	
	if (match) {
		const frontmatter = match[1];
		
		// Check if tags property exists
		const tagsArrayRegex = /^(tags:\s*\[)([^\]]*)(]\s*)$/m;
		const tagsListRegex = /^tags:\s*$/m;
		const tagsArrayMatch = frontmatter.match(tagsArrayRegex);
		const tagsListMatch = frontmatter.match(tagsListRegex);
		
		let newFrontmatter: string;
		
		if (tagsArrayMatch) {
			// Tags in array format: tags: [tag1, tag2]
			const existingTags = tagsArrayMatch[2].trim();
			if (existingTags) {
				newFrontmatter = frontmatter.replace(tagsArrayRegex, `$1${existingTags}, ${tagToAdd}$3`);
			} else {
				newFrontmatter = frontmatter.replace(tagsArrayRegex, `$1${tagToAdd}$3`);
			}
		} else if (tagsListMatch) {
			// Tags in list format, add new item
			const tagsLineIndex = frontmatter.indexOf('tags:');
			const beforeTags = frontmatter.substring(0, tagsLineIndex + 5);
			const afterTags = frontmatter.substring(tagsLineIndex + 5);
			newFrontmatter = `${beforeTags}\n  - ${tagToAdd}${afterTags}`;
		} else {
			// No tags property, add it
			newFrontmatter = `${frontmatter}\ntags:\n  - ${tagToAdd}`;
		}
		
		newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
	} else {
		// File has no frontmatter - add it
		newContent = `---\ntags:\n  - ${tagToAdd}\n---\n${content}`;
	}
	
	if (newContent !== content) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
	}
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces a tag with another tag in a single file.
 * Handles both inline tags (#tag) and frontmatter tags.
 */
async function replaceTagInFile(
	plugin: TaggableTagsPlugin, 
	file: TFile, 
	oldTag: string, 
	newTag: string
): Promise<boolean> {
	const content = await plugin.app.vault.read(file);
	let newContent = content;
	let changed = false;

	// Replace inline tags: #oldTag -> #newTag
	const inlineRegex = new RegExp(`#${escapeRegex(oldTag)}(?![\\w-])`, 'g');
	if (inlineRegex.test(content)) {
		newContent = content.replace(inlineRegex, `#${newTag}`);
		changed = true;
	}

	// Replace frontmatter tags
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
	const frontmatterMatch = newContent.match(frontmatterRegex);
	
	if (frontmatterMatch) {
		const frontmatter = frontmatterMatch[1];
		let newFrontmatter = frontmatter;
		
		// Handle YAML array format: tags: [tag1, tag2]
		const yamlArrayRegex = new RegExp(
			`(tags:\\s*\\[[^\\]]*)\\b${escapeRegex(oldTag)}\\b([^\\]]*\\])`,
			'g'
		);
		if (yamlArrayRegex.test(frontmatter)) {
			newFrontmatter = frontmatter.replace(yamlArrayRegex, `$1${newTag}$2`);
			changed = true;
		}
		
		// Handle YAML list format
		const yamlListRegex = new RegExp(
			`(^\\s*-\\s*)${escapeRegex(oldTag)}(\\s*$)`,
			'gm'
		);
		if (yamlListRegex.test(newFrontmatter)) {
			newFrontmatter = newFrontmatter.replace(yamlListRegex, `$1${newTag}$2`);
			changed = true;
		}

		if (newFrontmatter !== frontmatter) {
			newContent = newContent.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		}
	}

	if (changed && newContent !== content) {
		markPluginInitiatedChange(file.path);
		await plugin.app.vault.modify(file, newContent);
		return true;
	}

	return false;
}

/**
 * Modal for replacing a tag with a new child tag.
 * Creates a new child tag and replaces the original tag in the source file.
 */
class ReplaceWithChildTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private originalTag: string;
	private sourceFile: TFile;
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, originalTag: string, sourceFile: TFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.originalTag = originalTag;
		this.sourceFile = sourceFile;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		contentEl.createEl('h3', { text: `Replace #${this.originalTag} with new child tag` });
		
		const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
		descEl.textContent = `Creates a new tag as a child of #${this.originalTag}, then replaces #${this.originalTag} with the new tag in this file.`;
		descEl.style.marginBottom = '16px';
		
		const inputContainer = contentEl.createEl('div', { cls: 'create-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		const labelEl = inputContainer.createEl('label');
		labelEl.textContent = 'New child tag name';
		labelEl.style.display = 'block';
		labelEl.style.marginBottom = '4px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter tag name...',
			cls: 'create-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performReplace();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'create-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Replace', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performReplace());
		
		// Focus the input
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private async performReplace(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTagName = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTagName = newTagName.startsWith('#') ? newTagName.slice(1) : newTagName;
		
		if (!newTagName) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name
		if (newTagName.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		newTagName = this.plugin.tagIndex.normalizeTag(newTagName);

		// Check if tag already exists
		const existingFile = this.plugin.tagIndex.getTagFile(newTagName);
		if (existingFile) {
			new Notice(`Tag #${newTagName} already exists`);
			return;
		}

		try {
			this.close();
			
			// Create the new child tag file
			const childTagFile = await createTagFile(this.plugin, newTagName);
			if (!childTagFile) {
				new Notice('Failed to create child tag file');
				return;
			}
			
			// Add the original tag as parent to the new child tag
			await addTagToFile(this.plugin, childTagFile, this.originalTag);
			
			// Replace the original tag with the new child tag in the source file
			await replaceTagInFile(this.plugin, this.sourceFile, this.originalTag, newTagName);
			
			// Rebuild the index
			await this.plugin.tagIndex.rebuild();
			
			// Refresh the active view to show the updated content
			refreshActiveView(this.plugin);
			
			new Notice(`Replaced #${this.originalTag} with #${newTagName} (child of #${this.originalTag})`);
		} catch (error) {
			console.error('Failed to replace with child tag:', error);
			new Notice(`Failed to replace tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for replacing a tag with a new parent tag.
 * Creates a new parent tag and replaces the original tag in the source file.
 */
class ReplaceWithParentTagModal extends Modal {
	private plugin: TaggableTagsPlugin;
	private originalTag: string;
	private sourceFile: TFile;
	private inputEl: HTMLInputElement | null = null;

	constructor(plugin: TaggableTagsPlugin, originalTag: string, sourceFile: TFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.originalTag = originalTag;
		this.sourceFile = sourceFile;
	}

	onOpen(): void {
		const { contentEl } = this;
		
		contentEl.createEl('h3', { text: `Replace #${this.originalTag} with new parent tag` });
		
		const descEl = contentEl.createEl('p', { cls: 'setting-item-description' });
		descEl.textContent = `Creates a new tag as a parent of #${this.originalTag}, then replaces #${this.originalTag} with the new tag in this file.`;
		descEl.style.marginBottom = '16px';
		
		const inputContainer = contentEl.createEl('div', { cls: 'create-tag-input-container' });
		inputContainer.style.marginBottom = '16px';
		
		const labelEl = inputContainer.createEl('label');
		labelEl.textContent = 'New parent tag name';
		labelEl.style.display = 'block';
		labelEl.style.marginBottom = '4px';
		
		this.inputEl = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter tag name...',
			cls: 'create-tag-input'
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.padding = '8px';
		
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.performReplace();
			} else if (e.key === 'Escape') {
				this.close();
			}
		});
		
		const buttonContainer = contentEl.createEl('div', { cls: 'create-tag-buttons' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '8px';
		
		const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		
		const createBtn = buttonContainer.createEl('button', { text: 'Replace', cls: 'mod-cta' });
		createBtn.addEventListener('click', () => this.performReplace());
		
		// Focus the input
		setTimeout(() => this.inputEl?.focus(), 10);
	}

	private async performReplace(): Promise<void> {
		if (!this.inputEl) return;
		
		let newTagName = this.inputEl.value.trim();
		
		// Remove # if user included it
		newTagName = newTagName.startsWith('#') ? newTagName.slice(1) : newTagName;
		
		if (!newTagName) {
			new Notice('Tag name cannot be empty');
			return;
		}

		// Validate tag name
		if (newTagName.includes('#')) {
			new Notice('Tag name cannot contain #');
			return;
		}

		newTagName = this.plugin.tagIndex.normalizeTag(newTagName);

		// Check if tag already exists
		const existingFile = this.plugin.tagIndex.getTagFile(newTagName);
		if (existingFile) {
			new Notice(`Tag #${newTagName} already exists`);
			return;
		}

		try {
			this.close();
			
			// Create the new parent tag file
			const parentTagFile = await createTagFile(this.plugin, newTagName);
			if (!parentTagFile) {
				new Notice('Failed to create parent tag file');
				return;
			}
			
			// Get the original tag's file and add the new parent to its tags
			const originalTagFile = this.plugin.tagIndex.getTagFile(this.originalTag);
			if (originalTagFile) {
				await addTagToFile(this.plugin, originalTagFile, newTagName);
			} else {
				// If original tag doesn't have a file, create one first
				const newOriginalFile = await createTagFile(this.plugin, this.originalTag);
				if (newOriginalFile) {
					await addTagToFile(this.plugin, newOriginalFile, newTagName);
				}
			}
			
			// Replace the original tag with the new parent tag in the source file
			await replaceTagInFile(this.plugin, this.sourceFile, this.originalTag, newTagName);
			
			// Rebuild the index
			await this.plugin.tagIndex.rebuild();
			
			// Refresh the active view to show the updated content
			refreshActiveView(this.plugin);
			
			new Notice(`Replaced #${this.originalTag} with #${newTagName} (parent of #${this.originalTag})`);
		} catch (error) {
			console.error('Failed to replace with parent tag:', error);
			new Notice(`Failed to replace tag: ${error}`);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Refreshes the active view to reflect file changes.
 * This is needed after modifying file content programmatically.
 */
export async function refreshActiveView(plugin: TaggableTagsPlugin): Promise<void> {
	const activeLeaf = plugin.app.workspace.activeLeaf;
	if (!activeLeaf?.view) return;
	
	const view = activeLeaf.view;
	const file = (view as any).file as TFile | undefined;
	if (!file) return;
	
	// Try rebuildView if available (internal Obsidian method)
	if (typeof (activeLeaf as any).rebuildView === 'function') {
		await (activeLeaf as any).rebuildView();
		return;
	}
	
	// Fallback: reopen the file in the same leaf (preserves state)
	const eState = activeLeaf.getEphemeralState();
	await activeLeaf.openFile(file, { eState });
}
