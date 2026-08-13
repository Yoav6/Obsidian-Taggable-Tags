import { App, PluginSettingTab, TFile } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type TaggableTagsPlugin from './main';
import { getTagExplorerView } from './ui/tag-explorer-view';
import { syncEntireVault } from './sync/folder-sync';
import { sanitizeTagSpaceSeparatorInput } from './utils/tag-naming';
import { refreshGraphLeaves } from './graph/graph-patch';

export type TagClickBehavior = 'replace' | 'add' | 'default';
export type FolderTagBehavior = 'ask' | 'always' | 'never';
export type ExistingFileBehavior = 'ask' | 'auto' | 'off';
export type EmptyFolderBehavior = 'delete' | 'create-tag' | 'ask' | 'nothing';
export type AttachmentGrouping = 'no' | 'yes' | 'split';
export type AttachmentAlongside = 'no' | 'addition' | 'instead';

export interface TaggableTagsSettings {
	autoCreateFiles: boolean;
	confirmUnusedTagDeletion: boolean;
	/** Character that replaces spaces in tag property / applied tags (default '_'). */
	tagSpaceSeparator: string;
	/** When true, tag note and tag folder names use spaces instead of the tag separator. */
	replaceSeparatorsWithSpaces: boolean;
	// Tag property settings
	tagPropertyName: string;
	exceptionToPropertyName: string;  // Property name for exception tags (e.g., "exception to")
	syncFileNamesWithTags: boolean;
	// Explorer view settings
	combineIdenticalTags: boolean;
	showUntaggedFiles: boolean;
	groupUntaggedFiles: boolean;  // true = show in "Untagged" group, false = show directly at top level
	// Attachment settings
	displayAttachments: boolean;              // Master toggle for showing attachments in the explorer
	attachmentGrouping: AttachmentGrouping;   // How attachments are grouped: inline, under "Attachments", or split by referenced/unreferenced
	attachmentsAlongside: AttachmentAlongside; // Where referenced attachments appear relative to their referencing note
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
	removeRedundantParentTags: boolean;     // Auto-remove parent tags when child tag is present
	emptyFolderBehavior: EmptyFolderBehavior;  // What to do with empty folders after sync
	// Tag creation settings
	tagTemplateFile: string;                // Path to template file for new tags (empty = use default)
	existingFileBehavior: ExistingFileBehavior;  // What to do when a file with matching name exists
	// Tag registry note settings
	enableTagRegistry: boolean;             // Enable a registry note that lists all tags for autocomplete
	tagRegistryPath: string;                // Path to the tag registry note (e.g., "_tag-registry.md")
	/** Merge tag nodes into tag notes and show hierarchy in the core graph view. */
	graphCompatEnabled: boolean;
}

export const DEFAULT_SETTINGS: TaggableTagsSettings = {
	autoCreateFiles: false,
	confirmUnusedTagDeletion: true,
	tagSpaceSeparator: '_',
	replaceSeparatorsWithSpaces: true,
	// Tag property defaults
	tagPropertyName: 'tag',
	exceptionToPropertyName: 'exception to',
	syncFileNamesWithTags: false,
	// Explorer view defaults
	combineIdenticalTags: true,
	showUntaggedFiles: true,
	groupUntaggedFiles: true,
	// Attachment defaults
	displayAttachments: true,
	attachmentGrouping: 'split',
	attachmentsAlongside: 'instead',
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
	removeRedundantParentTags: true,
	emptyFolderBehavior: 'nothing',
	// Tag creation defaults
	tagTemplateFile: '',
	existingFileBehavior: 'ask',
	// Tag registry defaults
	enableTagRegistry: false,
	tagRegistryPath: '_tag-registry.md',
	graphCompatEnabled: true,
};

export class TaggableTagsSettingTab extends PluginSettingTab {
	plugin: TaggableTagsPlugin;

	constructor(app: App, plugin: TaggableTagsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Tag creation',
				items: [
					{
						name: 'Auto-create tag notes',
						desc: 'Automatically create tag note files when new tags are used.',
						control: { type: 'toggle', key: 'autoCreateFiles' },
					},
					{
						name: 'Tag template file',
						desc: 'Path to a file to use as a template for new tag files. Leave empty for default content. The template\'s content will be used, and required properties (tag, tags, exception to) will be added if missing.',
						control: {
							type: 'file',
							key: 'tagTemplateFile',
							placeholder: 'e.g., _templates/tag-template.md',
							filter: (file: TFile) => file.extension === 'md',
						},
					},
					{
						name: 'Use existing files as tags',
						desc: 'When creating a tag, if a file with a matching name exists (ignoring case and separators), offer to use it as the tag file.',
						control: {
							type: 'dropdown',
							key: 'existingFileBehavior',
							options: {
								ask: 'Ask each time',
								auto: 'Automatically use existing file',
								off: 'Always create new file',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Tag names',
				items: [
					{
						name: 'Space character in tags',
						desc: 'Character used to replace spaces in tag names (property and applied tags). Default is _. Comparisons are always case-insensitive.',
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('_')
								.setValue(this.plugin.settings.tagSpaceSeparator)
								.onChange(async (value) => {
									this.plugin.settings.tagSpaceSeparator = sanitizeTagSpaceSeparatorInput(value);
									await this.plugin.saveSettings();
								}));
						},
					},
					{
						name: 'Replace separator characters with spaces in tag note and tag folder names',
						desc: 'When on, note and folder names use spaces instead of the tag space character (e.g. Arts_and_crafts → arts and crafts). When off, notes and folders use the same separator as tags.',
						control: { type: 'toggle', key: 'replaceSeparatorsWithSpaces' },
					},
					{
						name: 'Sync file names with tag names',
						desc: 'When enabled, renaming a tag file will update its tag property, and changing the tag property will rename the file. Respects the separator→spaces setting for note names.',
						control: { type: 'toggle', key: 'syncFileNamesWithTags' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Tag file detection',
				items: [
					{
						name: 'Tag property name',
						desc: 'The frontmatter property that identifies a file as a tag file. The property value determines which tag the file represents.',
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('tag')
								.setValue(this.plugin.settings.tagPropertyName)
								.onChange(async (value) => {
									this.plugin.settings.tagPropertyName = value || 'tag';
									await this.plugin.saveSettings();
									await this.plugin.tagIndex.rebuild();
									this.refreshExplorerView();
								}));
						},
					},
					{
						name: 'Exception property name',
						desc: 'The frontmatter property that defines which tags this tag is an exception to. Use wikilinks to reference tags (e.g., [[history]]) or "all" for exclusive tags.',
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('exception to')
								.setValue(this.plugin.settings.exceptionToPropertyName)
								.onChange(async (value) => {
									this.plugin.settings.exceptionToPropertyName = value || 'exception to';
									await this.plugin.saveSettings();
									await this.plugin.tagIndex.rebuild();
									this.refreshExplorerView();
								}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Tag explorer',
				items: [
					{
						name: 'Combine identical tags in navigation',
						desc: 'Tags with exactly the same children (child tags and files) are shown as a single combined item (e.g., "history + fiction").',
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.combineIdenticalTags)
								.onChange(async (value) => {
									this.plugin.settings.combineIdenticalTags = value;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
								}));
						},
					},
					{
						name: 'Show untagged files',
						desc: 'Display files that have no tags in the explorer view.',
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.showUntaggedFiles)
								.onChange(async (value) => {
									this.plugin.settings.showUntaggedFiles = value;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
									this.refreshDomState();
								}));
						},
					},
					{
						name: 'Group untagged files',
						desc: 'Show untagged files in a collapsible "untagged" group. When off, files appear directly at the bottom of the list.',
						visible: () => this.plugin.settings.showUntaggedFiles,
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.groupUntaggedFiles)
								.onChange(async (value) => {
									this.plugin.settings.groupUntaggedFiles = value;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
								}));
						},
					},
					{
						name: 'Display attachments',
						desc: 'Show non-markdown files (attachments) in the explorer view.',
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.displayAttachments)
								.onChange(async (value) => {
									this.plugin.settings.displayAttachments = value;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
									this.refreshDomState();
								}));
						},
					},
					{
						name: 'Group attachments',
						desc: 'Show attachments in a collapsible "attachments" group. "split" divides the group into "referenced" and "unreferenced" subgroups.',
						visible: () => this.plugin.settings.displayAttachments,
						render: (setting) => {
							setting.addDropdown(dropdown => dropdown
								.addOption('no', 'No (show directly)')
								.addOption('yes', 'Yes')
								.addOption('split', 'Yes, split between referenced and unreferenced')
								.setValue(this.plugin.settings.attachmentGrouping)
								.onChange(async (value) => {
									this.plugin.settings.attachmentGrouping = value as AttachmentGrouping;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
								}));
						},
					},
					{
						name: 'Display referenced attachments alongside referencing note',
						desc: 'Show attachments next to the notes that reference them, in addition to or instead of the vault root.',
						visible: () => this.plugin.settings.displayAttachments,
						render: (setting) => {
							setting.addDropdown(dropdown => dropdown
								.addOption('no', 'No')
								.addOption('addition', 'Yes, in addition to vault root')
								.addOption('instead', 'Yes, instead of vault root')
								.setValue(this.plugin.settings.attachmentsAlongside)
								.onChange(async (value) => {
									this.plugin.settings.attachmentsAlongside = value as AttachmentAlongside;
									await this.plugin.saveSettings();
									this.refreshExplorerView();
								}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Folder synchronization',
				items: [
					{
						name: 'Sync folders with tag structure',
						desc: 'Mirror the tag hierarchy as a folder structure. Files are placed in folders based on their first tag.',
						control: { type: 'toggle', key: 'syncFoldersWithTags' },
					},
					{
						name: 'Auto-sync entire vault',
						desc: 'Continuously ensure all files are in the correct folders based on their tags. Turn on temporarily to sync existing files, then turn off to only sync on changes.',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.autoSyncEntireVault)
								.onChange(async (value) => {
									this.plugin.settings.autoSyncEntireVault = value;
									await this.plugin.saveSettings();
									if (value) {
										await syncEntireVault(this.plugin);
									}
								}));
						},
					},
					{
						name: 'Keep original folder tag when moving files',
						desc: 'When moving a file to a new folder, what to do with the tag from the original folder.',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						control: {
							type: 'dropdown',
							key: 'keepOriginalFolderTag',
							options: {
								ask: 'Ask each time',
								always: 'Always keep',
								never: 'Never keep (remove)',
							},
						},
					},
					{
						name: 'Place tag files in dedicated folder',
						desc: 'Store all tag definition files in a single folder instead of distributing them across the tag hierarchy.',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						control: { type: 'toggle', key: 'tagFilesInDedicatedFolder' },
					},
					{
						name: 'Tag files folder path',
						desc: 'Folder path for tag files (e.g., "_tags").',
						visible: () => this.plugin.settings.syncFoldersWithTags && this.plugin.settings.tagFilesInDedicatedFolder,
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('_tags')
								.setValue(this.plugin.settings.tagFilesFolderPath)
								.onChange(async (value) => {
									this.plugin.settings.tagFilesFolderPath = value || '_tags';
									await this.plugin.saveSettings();
								}));
						},
					},
					{
						name: 'Excluded tags',
						desc: 'Comma-separated list of tags to exclude from folder sync (e.g., "todo, done, status").',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('todo, done, status')
								.setValue(this.plugin.settings.excludedTagsFromFolderSync.join(', '))
								.onChange(async (value) => {
									this.plugin.settings.excludedTagsFromFolderSync = value
										.split(',')
										.map(t => t.trim())
										.filter(t => t.length > 0);
									await this.plugin.saveSettings();
								}));
						},
					},
					{
						name: 'Excluded folders',
						desc: 'Comma-separated list of folder paths to exclude from folder sync (e.g., "templates, attachments").',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('templates, attachments')
								.setValue(this.plugin.settings.excludedFoldersFromSync.join(', '))
								.onChange(async (value) => {
									this.plugin.settings.excludedFoldersFromSync = value
										.split(',')
										.map(f => f.trim())
										.filter(f => f.length > 0);
									await this.plugin.saveSettings();
								}));
						},
					},
					{
						name: 'Empty folder behavior',
						desc: 'What to do with folders that become empty after files are moved during sync.',
						visible: () => this.plugin.settings.syncFoldersWithTags,
						control: {
							type: 'dropdown',
							key: 'emptyFolderBehavior',
							options: {
								nothing: 'Do nothing',
								delete: 'Delete empty folders',
								'create-tag': 'Create tag note for empty folders',
								ask: 'Ask each time',
							},
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Tag registry',
				items: [
					{
						name: 'Enable tag registry note',
						desc: createFragment((frag) => {
							frag.appendText('Maintain a hidden note that lists all tags from tag files in its frontmatter. ');
							frag.appendText('This makes tags appear in Obsidian\'s autocomplete suggestions even if they aren\'t used in any note yet.');
						}),
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.enableTagRegistry)
								.onChange(async (value) => {
									this.plugin.settings.enableTagRegistry = value;
									await this.plugin.saveSettings();
									if (value) {
										await this.plugin.updateTagRegistry();
									}
									refreshGraphLeaves(this.plugin);
									this.refreshDomState();
								}));
						},
					},
					{
						name: 'Registry note path',
						desc: 'Path to the tag registry note (e.g., "_tag-registry.md"). The note will be created automatically.',
						visible: () => this.plugin.settings.enableTagRegistry,
						render: (setting) => {
							setting.addText(text => text
								.setPlaceholder('_tag-registry.md')
								.setValue(this.plugin.settings.tagRegistryPath)
								.onChange(async (value) => {
									this.plugin.settings.tagRegistryPath = value || '_tag-registry.md';
									await this.plugin.saveSettings();
									await this.plugin.updateTagRegistry();
									refreshGraphLeaves(this.plugin);
								}));
						},
					},
				],
			},
			{
				type: 'group',
				heading: 'Misc',
				items: [
					{
						name: 'Remove redundant tags',
						desc: 'Automatically remove redundant tags: parent tags when a child is present (e.g., remove "cooking" if "recipes" exists and is a child of cooking), and self-tags from tag files (e.g., remove #music from music.md).',
						control: { type: 'toggle', key: 'removeRedundantParentTags' },
					},
					{
						name: 'Tag click action',
						desc: 'What happens when you click a tag in a note (in properties or body).',
						control: {
							type: 'dropdown',
							key: 'tagClickBehavior',
							options: {
								replace: 'Filter in explorer (replace current filters)',
								add: 'Filter in explorer (add to current filters)',
								default: 'Default Obsidian behavior (open search)',
							},
						},
					},
					{
						name: 'Suggest deletion when tag becomes unused',
						desc: 'Show a modal when a tag is no longer used anywhere.',
						control: { type: 'toggle', key: 'confirmUnusedTagDeletion' },
					},
					{
						name: 'Graph view compatibility',
						desc: 'Merge tag nodes into their tag notes in Obsidian\'s graph view, show tag hierarchy edges, and style tag notes with the theme\'s tag color. The tag registry note is always hidden from the graph. Uses internal Obsidian apis and may need updates after Obsidian upgrades.',
						render: (setting) => {
							setting.addToggle(toggle => toggle
								.setValue(this.plugin.settings.graphCompatEnabled)
								.onChange(async (value) => {
									this.plugin.settings.graphCompatEnabled = value;
									await this.plugin.saveSettings();
									refreshGraphLeaves(this.plugin);
								}));
						},
					},
				],
			},
		];
	}

	/**
	 * Refresh the tag explorer view if it's open
	 */
	private refreshExplorerView(): void {
		const explorerView = getTagExplorerView(this.plugin);
		if (explorerView) {
			void explorerView.refresh();
		}
	}
}
