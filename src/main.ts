import { Plugin, TFile, Menu, Notice, normalizePath } from 'obsidian';
import { TaggableTagsSettings, DEFAULT_SETTINGS, TaggableTagsSettingTab } from './settings';
import { TagIndex } from './sync/tag-index';
import { setupAutoCreate } from './sync/auto-create';
import { setupFileRenameSync } from './sync/file-rename-sync';
import { setupUnusedTagHandler } from './sync/unused-tag-handler';
import { setupFolderSync } from './sync/folder-sync';
import { setupHoverPreview } from './ui/hover-preview';
import { registerTagExplorerView, TAG_EXPLORER_VIEW_TYPE } from './ui/tag-explorer-view';
import { setupTagClickNavigation } from './ui/tag-click-navigation';
import { showRearrangeTagsModal } from './ui/rearrange-tags-modal';
import { flattenNestedTags } from './commands/flatten-nested-tags';
import { flattenFileStructure } from './commands/flatten-file-structure';
import { migrateVault } from './commands/migrate-vault';
import { findCircularTags } from './commands/find-circular-tags';
import { refreshTagIndex } from './commands/refresh-tag-index';
import { sanitizeTagSpaceSeparatorInput } from './utils/tag-naming';
import { setupGraphCompat, teardownGraphCompat } from './graph/graph-patch';

export default class TaggableTagsPlugin extends Plugin {
	settings: TaggableTagsSettings;
	tagIndex: TagIndex;

	async onload() {
		await this.loadSettings();

		// Initialize tag index
		this.tagIndex = new TagIndex(this.app, this.settings);

		// Register the tag explorer view
		registerTagExplorerView(this);

		// Register commands
		this.addCommand({
			id: 'rearrange-tag-order',
			name: 'Rearrange tag order in current note',
			callback: () => showRearrangeTagsModal(this),
		});

		this.addCommand({
			id: 'flatten-nested-tags',
			name: 'Utility: flatten nested tags (vault-wide)',
			callback: () => flattenNestedTags(this),
		});

		this.addCommand({
			id: 'flatten-file-structure',
			name: 'Utility: flatten file structure (vault-wide)',
			callback: () => flattenFileStructure(this),
		});

		this.addCommand({
			id: 'migrate-vault',
			name: 'Migrate vault to Taggable Tags',
			callback: () => migrateVault(this),
		});

		this.addCommand({
			id: 'find-circular-tags',
			name: 'Utility: find circular tag relationships',
			callback: () => findCircularTags(this),
		});

		this.addCommand({
			id: 'refresh-tag-index',
			name: 'Utility: refresh tag index and explorer',
			callback: () => refreshTagIndex(this),
		});
		
		// Wait for layout to be ready before initializing
		this.app.workspace.onLayoutReady(async () => {
			await this.tagIndex.rebuild();
			await this.updateTagRegistry();
			
			// Set up sync features
			setupAutoCreate(this);
			setupFileRenameSync(this);
			setupUnusedTagHandler(this);
			setupFolderSync(this);
			
			// Set up UI features
			setupHoverPreview(this);
			setupTagClickNavigation(this);
			setupGraphCompat(this);
		});

		// Add settings tab
		this.addSettingTab(new TaggableTagsSettingTab(this.app, this));

		// Register file menu item for "Convert to tag note"
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				
				// Check if file already has the tag property
				const existingTagValue = this.tagIndex.getTagPropertyValue(file);
				if (existingTagValue) return; // Already a tag note
				
				menu.addItem((item) => {
					item.setTitle('Convert to tag note')
						.setIcon('tag')
						.onClick(async () => {
							await this.convertToTagNote(file);
						});
				});
			})
		);
	}

	/**
	 * Convert a regular note to a tag note by adding the tag property
	 */
	private async convertToTagNote(file: TFile): Promise<void> {
		// Infer tag name from file name (spaces → configured separator, case preserved)
		const tagName = this.tagIndex.normalizeTag(
			this.tagIndex.unsanitizeTagName(file.basename)
		);
		const propName = this.settings.tagPropertyName;
		const content = await this.app.vault.read(file);
		
		// Check if file has frontmatter
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		
		let newContent: string;
		if (match) {
			// Add tag property to existing frontmatter
			const frontmatter = match[1];
			const newFrontmatter = `${propName}: ${tagName}\n${frontmatter}`;
			newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
		} else {
			// Create new frontmatter with tag property
			newContent = `---\n${propName}: ${tagName}\ntags: []\n---\n\n${content}`;
		}
		
		await this.app.vault.modify(file, newContent);
		await this.tagIndex.rebuild();
		
		new Notice(`Converted "${file.basename}" to tag note #${tagName}`);
	}

	onunload() {
		teardownGraphCompat(this);
		// Detach any tag explorer views
		this.app.workspace.detachLeavesOfType(TAG_EXPLORER_VIEW_TYPE);
	}

	/**
	 * Update the tag registry note with all tags from tag files.
	 * This makes tags appear in Obsidian's autocomplete even if not used in any note.
	 */
	async updateTagRegistry(): Promise<void> {
		if (!this.settings.enableTagRegistry) {
			return;
		}

		const registryPath = normalizePath(this.settings.tagRegistryPath);
		
		// Get all tags from the index (includes all tags that have tag files)
		const allTags = this.tagIndex.getAllTags();
		
		// Sort tags alphabetically
		allTags.sort();
		
		// Build the registry note content
		const tagsYaml = allTags.length > 0 
			? allTags.map(t => `  - ${t}`).join('\n')
			: '';
		
		const content = `---
tags:
${tagsYaml}
---

# Tag registry

This note is automatically maintained by the Taggable Tags plugin. Its purpose is to make all tags from tag files appear in Obsidian's tag autocomplete suggestions, even if those tags aren't used in any other note yet.

This note isn't meant to be edited manually, any changes will be overwritten.

You can disable this feature in the plugin settings.

Note that since this file isn't supposed to be viewed, the view isn't refreshed when changes are made to it, so you might not see them even though they were made and everything is working as intended.
`;

		// Check if the file exists
		const existingFile = this.app.vault.getAbstractFileByPath(registryPath);
		
		if (existingFile instanceof TFile) {
			// Update existing file
			await this.app.vault.modify(existingFile, content);
		} else {
			// Create new file (ensure parent folder exists)
			const folderPath = registryPath.substring(0, registryPath.lastIndexOf('/'));
			if (folderPath) {
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder) {
					await this.app.vault.createFolder(folderPath);
				}
			}
			await this.app.vault.create(registryPath, content);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Migrate / sanitize naming settings; drop removed forceLowercase if present
		const raw = this.settings as TaggableTagsSettings & { forceLowercase?: boolean };
		delete raw.forceLowercase;
		this.settings.tagSpaceSeparator = sanitizeTagSpaceSeparatorInput(
			this.settings.tagSpaceSeparator ?? '_'
		);
		if (typeof this.settings.replaceSeparatorsWithSpaces !== 'boolean') {
			this.settings.replaceSeparatorsWithSpaces = true;
		}
		if (typeof this.settings.graphCompatEnabled !== 'boolean') {
			this.settings.graphCompatEnabled = true;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
