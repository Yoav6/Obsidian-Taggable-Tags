import { App, PluginSettingTab, Setting } from 'obsidian';
import type TaggableTagsPlugin from './main';
import { getTagExplorerView } from './ui/tag-explorer-view';
import { syncEntireVault } from './sync/folder-sync';

export type TagClickBehavior = 'replace' | 'add' | 'default';
export type FolderTagBehavior = 'ask' | 'always' | 'never';
export type ExistingFileBehavior = 'ask' | 'auto' | 'off';

export interface TaggableTagsSettings {
	autoCreateFiles: boolean;
	confirmUnusedTagDeletion: boolean;
	forceLowercase: boolean;
	// Tag property settings
	tagPropertyName: string;
	exceptionToPropertyName: string;  // Property name for exception tags (e.g., "exception to")
	syncFileNamesWithTags: boolean;
	// Explorer view settings
	combineIdenticalTags: boolean;
	showUntaggedFiles: boolean;
	groupUntaggedFiles: boolean;  // true = show in "Untagged" group, false = show directly at top level
	// Tag click behavior
	tagClickBehavior: TagClickBehavior;  // What happens when clicking a tag in notes
	// Folder sync settings
	syncFoldersWithTags: boolean;           // Main toggle (off by default)
	autoSyncEntireVault: boolean;           // Continuously sync entire vault (off by default)
	keepOriginalFolderTag: FolderTagBehavior;  // What to do with old folder's tag when moving: ask, always keep, never keep
	tagFilesInDedicatedFolder: boolean;     // Put tag files in a dedicated folder
	tagFilesFolderPath: string;             // Path for dedicated tag files folder (e.g., "_tags")
	excludedTagsFromFolderSync: string[];   // Tags to exclude from sync
	excludedFoldersFromSync: string[];      // Folders to exclude from sync
	// Tag creation settings
	tagTemplateFile: string;                // Path to template file for new tags (empty = use default)
	existingFileBehavior: ExistingFileBehavior;  // What to do when a file with matching name exists
	// Tag registry note settings
	enableTagRegistry: boolean;             // Enable a registry note that lists all tags for autocomplete
	tagRegistryPath: string;                // Path to the tag registry note (e.g., "_tag-registry.md")
}

export const DEFAULT_SETTINGS: TaggableTagsSettings = {
	autoCreateFiles: false,
	confirmUnusedTagDeletion: true,
	forceLowercase: true,
	// Tag property defaults
	tagPropertyName: 'tag',
	exceptionToPropertyName: 'exception to',
	syncFileNamesWithTags: false,
	// Explorer view defaults
	combineIdenticalTags: true,
	showUntaggedFiles: true,
	groupUntaggedFiles: true,
	// Tag click behavior default
	tagClickBehavior: 'replace',
	// Folder sync defaults
	syncFoldersWithTags: false,
	autoSyncEntireVault: false,
	keepOriginalFolderTag: 'ask',
	tagFilesInDedicatedFolder: false,
	tagFilesFolderPath: '_tags',
	excludedTagsFromFolderSync: [],
	excludedFoldersFromSync: [],
	// Tag creation defaults
	tagTemplateFile: '',
	existingFileBehavior: 'ask',
	// Tag registry defaults
	enableTagRegistry: false,
	tagRegistryPath: '_tag-registry.md',
};

export class TaggableTagsSettingTab extends PluginSettingTab {
	plugin: TaggableTagsPlugin;

	constructor(app: App, plugin: TaggableTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Tag creation settings (at the top)
		containerEl.createEl('h3', { text: 'Tag creation' });

		new Setting(containerEl)
			.setName('Auto-create tag notes')
			.setDesc('Automatically create tag note files when new tags are used.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoCreateFiles)
				.onChange(async (value) => {
					this.plugin.settings.autoCreateFiles = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Tag template file')
			.setDesc('Path to a file to use as a template for new tag files. Leave empty for default content. The template\'s content will be used, and required properties (tag, tags, exception to) will be added if missing.')
			.addText(text => text
				.setPlaceholder('e.g., _templates/tag-template.md')
				.setValue(this.plugin.settings.tagTemplateFile)
				.onChange(async (value) => {
					this.plugin.settings.tagTemplateFile = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Use existing files as tags')
			.setDesc('When creating a tag, if a file with a matching name exists (ignoring case and -/_), offer to use it as the tag file.')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask each time')
				.addOption('auto', 'Automatically use existing file')
				.addOption('off', 'Always create new file')
				.setValue(this.plugin.settings.existingFileBehavior)
				.onChange(async (value) => {
					this.plugin.settings.existingFileBehavior = value as 'ask' | 'auto' | 'off';
					await this.plugin.saveSettings();
				}));

		// Tag names settings
		containerEl.createEl('h3', { text: 'Tag names' });

		new Setting(containerEl)
			.setName('Force lowercase tags')
			.setDesc('Automatically convert all tags to lowercase for consistency.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.forceLowercase)
				.onChange(async (value) => {
					this.plugin.settings.forceLowercase = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync file names with tag names')
			.setDesc('When enabled, renaming a tag file will update its tag property, and changing the tag property will rename the file.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncFileNamesWithTags)
				.onChange(async (value) => {
					this.plugin.settings.syncFileNamesWithTags = value;
					await this.plugin.saveSettings();
				}));

		// Tag file detection settings
		containerEl.createEl('h3', { text: 'Tag file detection' });

		new Setting(containerEl)
			.setName('Tag property name')
			.setDesc('The frontmatter property that identifies a file as a tag file. The property value determines which tag the file represents.')
			.addText(text => text
				.setPlaceholder('tag')
				.setValue(this.plugin.settings.tagPropertyName)
				.onChange(async (value) => {
					this.plugin.settings.tagPropertyName = value || 'tag';
					await this.plugin.saveSettings();
					await this.plugin.tagIndex.rebuild();
					this.refreshExplorerView();
				}));

		new Setting(containerEl)
			.setName('Exception property name')
			.setDesc('The frontmatter property that defines which tags this tag is an exception to. Use wikilinks to reference tags (e.g., [[history]]) or "all" for exclusive tags.')
			.addText(text => text
				.setPlaceholder('exception to')
				.setValue(this.plugin.settings.exceptionToPropertyName)
				.onChange(async (value) => {
					this.plugin.settings.exceptionToPropertyName = value || 'exception to';
					await this.plugin.saveSettings();
					await this.plugin.tagIndex.rebuild();
					this.refreshExplorerView();
				}));

		// Explorer view settings
		containerEl.createEl('h3', { text: 'Tag explorer' });

		new Setting(containerEl)
			.setName('Combine identical tags in navigation')
			.setDesc('Tags with exactly the same children (child tags and files) are shown as a single combined item (e.g., "history + fiction").')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.combineIdenticalTags)
				.onChange(async (value) => {
					this.plugin.settings.combineIdenticalTags = value;
					await this.plugin.saveSettings();
					this.refreshExplorerView();
				}));

		new Setting(containerEl)
			.setName('Show untagged files')
			.setDesc('Display files that have no tags in the explorer view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showUntaggedFiles)
				.onChange(async (value) => {
					this.plugin.settings.showUntaggedFiles = value;
					await this.plugin.saveSettings();
					this.refreshExplorerView();
					this.display(); // Refresh to show/hide related settings
				}));

		if (this.plugin.settings.showUntaggedFiles) {
			new Setting(containerEl)
				.setName('Group untagged files')
				.setDesc('Show untagged files in a collapsible "Untagged" group. When off, files appear directly at the bottom of the list.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.groupUntaggedFiles)
					.onChange(async (value) => {
						this.plugin.settings.groupUntaggedFiles = value;
						await this.plugin.saveSettings();
						this.refreshExplorerView();
					}));
		}

		// Folder synchronization settings
		containerEl.createEl('h3', { text: 'Folder synchronization' });

		new Setting(containerEl)
			.setName('Sync folders with tag structure')
			.setDesc('Mirror the tag hierarchy as a folder structure. Files are placed in folders based on their first tag.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncFoldersWithTags)
				.onChange(async (value) => {
					this.plugin.settings.syncFoldersWithTags = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide related settings
				}));

		if (this.plugin.settings.syncFoldersWithTags) {
			new Setting(containerEl)
				.setName('Auto-sync entire vault')
				.setDesc('Continuously ensure all files are in the correct folders based on their tags. Turn on temporarily to sync existing files, then turn off to only sync on changes.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.autoSyncEntireVault)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEntireVault = value;
						await this.plugin.saveSettings();
						// Trigger immediate sync when enabled
						if (value) {
							await syncEntireVault(this.plugin);
						}
					}));

			new Setting(containerEl)
				.setName('Keep original folder tag when moving files')
				.setDesc('When moving a file to a new folder, what to do with the tag from the original folder.')
				.addDropdown(dropdown => dropdown
					.addOption('ask', 'Ask each time')
					.addOption('always', 'Always keep')
					.addOption('never', 'Never keep (remove)')
					.setValue(this.plugin.settings.keepOriginalFolderTag)
					.onChange(async (value) => {
						this.plugin.settings.keepOriginalFolderTag = value as 'ask' | 'always' | 'never';
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Place tag files in dedicated folder')
				.setDesc('Store all tag definition files in a single folder instead of distributing them across the tag hierarchy.')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.tagFilesInDedicatedFolder)
					.onChange(async (value) => {
						this.plugin.settings.tagFilesInDedicatedFolder = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show/hide folder path setting
					}));

			if (this.plugin.settings.tagFilesInDedicatedFolder) {
				new Setting(containerEl)
					.setName('Tag files folder path')
					.setDesc('Folder path for tag files (e.g., "_tags").')
					.addText(text => text
						.setPlaceholder('_tags')
						.setValue(this.plugin.settings.tagFilesFolderPath)
						.onChange(async (value) => {
							this.plugin.settings.tagFilesFolderPath = value || '_tags';
							await this.plugin.saveSettings();
						}));
			}

			new Setting(containerEl)
				.setName('Excluded tags')
				.setDesc('Comma-separated list of tags to exclude from folder sync (e.g., "todo, done, status").')
				.addText(text => text
					.setPlaceholder('todo, done, status')
					.setValue(this.plugin.settings.excludedTagsFromFolderSync.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.excludedTagsFromFolderSync = value
							.split(',')
							.map(t => t.trim())
							.filter(t => t.length > 0);
						await this.plugin.saveSettings();
					}));

			new Setting(containerEl)
				.setName('Excluded folders')
				.setDesc('Comma-separated list of folder paths to exclude from folder sync (e.g., "templates, attachments").')
				.addText(text => text
					.setPlaceholder('templates, attachments')
					.setValue(this.plugin.settings.excludedFoldersFromSync.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.excludedFoldersFromSync = value
							.split(',')
							.map(f => f.trim())
							.filter(f => f.length > 0);
						await this.plugin.saveSettings();
					}));
		}

		// Tag registry settings
		containerEl.createEl('h3', { text: 'Tag registry' });

		const registryDesc = document.createDocumentFragment();
		registryDesc.appendText('Maintain a hidden note that lists all tags from tag files in its frontmatter. ');
		registryDesc.appendText('This makes tags appear in Obsidian\'s autocomplete suggestions even if they aren\'t used in any note yet.');

		new Setting(containerEl)
			.setName('Enable tag registry note')
			.setDesc(registryDesc)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableTagRegistry)
				.onChange(async (value) => {
					this.plugin.settings.enableTagRegistry = value;
					await this.plugin.saveSettings();
					if (value) {
						await this.plugin.updateTagRegistry();
					}
					this.display(); // Refresh to show/hide path setting
				}));

		if (this.plugin.settings.enableTagRegistry) {
			new Setting(containerEl)
				.setName('Registry note path')
				.setDesc('Path to the tag registry note (e.g., "_tag-registry.md"). The note will be created automatically.')
				.addText(text => text
					.setPlaceholder('_tag-registry.md')
					.setValue(this.plugin.settings.tagRegistryPath)
					.onChange(async (value) => {
						this.plugin.settings.tagRegistryPath = value || '_tag-registry.md';
						await this.plugin.saveSettings();
						await this.plugin.updateTagRegistry();
					}));
		}

		// Misc settings (at the bottom)
		containerEl.createEl('h3', { text: 'Misc' });

		new Setting(containerEl)
			.setName('Tag click action')
			.setDesc('What happens when you click a tag in a note (in properties or body).')
			.addDropdown(dropdown => dropdown
				.addOption('replace', 'Filter in explorer (replace current filters)')
				.addOption('add', 'Filter in explorer (add to current filters)')
				.addOption('default', 'Default Obsidian behavior (open search)')
				.setValue(this.plugin.settings.tagClickBehavior)
				.onChange(async (value) => {
					this.plugin.settings.tagClickBehavior = value as 'replace' | 'add' | 'default';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Suggest deletion when tag becomes unused')
			.setDesc('Show a modal when a tag is no longer used anywhere.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.confirmUnusedTagDeletion)
				.onChange(async (value) => {
					this.plugin.settings.confirmUnusedTagDeletion = value;
					await this.plugin.saveSettings();
				}));
	}

	/**
	 * Refresh the tag explorer view if it's open
	 */
	private refreshExplorerView(): void {
		const explorerView = getTagExplorerView(this.plugin);
		if (explorerView) {
			explorerView.refresh();
		}
	}
}
