import { TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import { filterSafeParentTags } from './cycle-prevention';

/**
 * Parse YAML frontmatter from file content.
 * Returns the frontmatter object and the body content.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
	const frontmatterRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
	const match = content.match(frontmatterRegex);
	
	if (!match) {
		return { frontmatter: null, body: content };
	}
	
	const frontmatterStr = match[1];
	const body = match[2];
	
	const frontmatter: Record<string, unknown> = {};
	const lines = frontmatterStr.split('\n');
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;
	
	for (const line of lines) {
		if (line.match(/^\s+-\s+/)) {
			if (currentArray !== null) {
				const value = line.replace(/^\s+-\s+/, '').trim();
				currentArray.push(value);
			}
			continue;
		}
		
		const keyValueMatch = line.match(/^(\S+):\s*(.*)$/);
		if (keyValueMatch) {
			if (currentKey && currentArray !== null) {
				frontmatter[currentKey] = currentArray;
			}
			
			currentKey = keyValueMatch[1];
			const value = keyValueMatch[2].trim();
			
			if (value === '[]') {
				frontmatter[currentKey] = [];
				currentArray = null;
			} else if (value === '') {
				currentArray = [];
			} else {
				frontmatter[currentKey] = value;
				currentArray = null;
			}
		}
	}
	
	if (currentKey && currentArray !== null) {
		frontmatter[currentKey] = currentArray;
	}
	
	return { frontmatter, body };
}

/**
 * Serialize frontmatter object back to YAML string.
 */
function serializeFrontmatter(frontmatter: Record<string, unknown>): string {
	const lines: string[] = [];
	
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${key}: []`);
			} else {
				lines.push(`${key}:`);
				for (const item of value) {
					lines.push(`  - ${item}`);
				}
			}
		} else {
			lines.push(`${key}: ${value}`);
		}
	}
	
	return lines.join('\n');
}

/** Normalize optional single parent or parent list into a string array. */
function normalizeParentTags(
	parentTagOrTags?: string | string[] | null
): string[] {
	if (!parentTagOrTags) return [];
	if (Array.isArray(parentTagOrTags)) {
		return parentTagOrTags.filter((t): t is string => typeof t === 'string' && t.length > 0);
	}
	return [parentTagOrTags];
}

/**
 * Generate content for a new tag file.
 * If a template file is configured and exists, uses it as a base.
 * Required properties (tag, tags, exception to) are added at the top if missing.
 *
 * @param parentTagOrTags Optional parent tag, or multiple parents for dual-parent tags
 */
export async function generateTagFileContent(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTagOrTags?: string | string[] | null
): Promise<string> {
	const parents = filterSafeParentTags(plugin, tagName, normalizeParentTags(parentTagOrTags));
	const propName = plugin.settings.tagPropertyName;
	const exceptionPropName = plugin.settings.exceptionToPropertyName;
	const templatePath = plugin.settings.tagTemplateFile;
	
	if (templatePath) {
		const templateFile = plugin.app.vault.getAbstractFileByPath(templatePath);
		if (templateFile instanceof TFile) {
			try {
				const templateContent = await plugin.app.vault.read(templateFile);
				return processTemplate(templateContent, tagName, parents, propName, exceptionPropName);
			} catch (error) {
				console.warn('Failed to read tag template file:', error);
			}
		}
	}
	
	return generateDefaultContent(tagName, parents, propName, exceptionPropName);
}

function processTemplate(
	templateContent: string,
	tagName: string,
	parentTags: string[],
	propName: string,
	exceptionPropName: string
): string {
	const { frontmatter, body } = parseFrontmatter(templateContent);
	
	const requiredProps: Record<string, unknown> = {};
	requiredProps[propName] = tagName;
	// Intended hierarchy parents only (already filtered by caller)
	requiredProps['tags'] = [...parentTags];
	
	if (!frontmatter || !(exceptionPropName in frontmatter)) {
		requiredProps[exceptionPropName] = [];
	}
	
	const mergedFrontmatter: Record<string, unknown> = { ...requiredProps };
	
	if (frontmatter) {
		for (const [key, value] of Object.entries(frontmatter)) {
			if (key === propName) continue;
			if (key === 'tags') continue;
			if (!(key in mergedFrontmatter)) {
				mergedFrontmatter[key] = value;
			}
		}
	}
	
	const newFrontmatter = serializeFrontmatter(mergedFrontmatter);
	return `---\n${newFrontmatter}\n---\n${body}`;
}

function generateDefaultContent(
	tagName: string,
	parentTags: string[],
	propName: string,
	exceptionPropName: string
): string {
	let content = `---\n${propName}: ${tagName}\n`;
	
	if (parentTags.length > 0) {
		content += `tags:\n`;
		for (const parent of parentTags) {
			content += `  - ${parent}\n`;
		}
	} else {
		content += `tags: []\n`;
	}
	
	content += `${exceptionPropName}: []\n`;
	content += `---\n`;
	
	return content;
}

/**
 * Add required tag properties to an existing file's frontmatter.
 * Used when converting an existing file to a tag file.
 *
 * Hierarchy parents come only from the caller-supplied list (after cycle filters).
 * Leftover content tags on the note are not preserved as parents — that caused
 * cycles like Courts ↔ Courts_Law after flatten left the compound on the note.
 *
 * @param parentTagOrTags Optional parent tag, or multiple parents for dual-parent tags
 */
export async function addTagPropertiesToFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagName: string,
	parentTagOrTags?: string | string[] | null
): Promise<void> {
	const parents = filterSafeParentTags(plugin, tagName, normalizeParentTags(parentTagOrTags));
	const propName = plugin.settings.tagPropertyName;
	const exceptionPropName = plugin.settings.exceptionToPropertyName;
	
	const content = await plugin.app.vault.read(file);
	const { frontmatter, body } = parseFrontmatter(content);
	
	const requiredProps: Record<string, unknown> = {};
	requiredProps[propName] = tagName;
	// Intended parents only — never merge prior tags: entries as hierarchy parents
	requiredProps['tags'] = [...parents];
	
	if (!frontmatter || !(exceptionPropName in frontmatter)) {
		requiredProps[exceptionPropName] = [];
	}
	
	const mergedFrontmatter: Record<string, unknown> = { ...requiredProps };
	
	if (frontmatter) {
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!(key in mergedFrontmatter)) {
				mergedFrontmatter[key] = value;
			}
		}
	}
	
	const newFrontmatter = serializeFrontmatter(mergedFrontmatter);
	const newContent = `---\n${newFrontmatter}\n---\n${body}`;
	
	await plugin.app.vault.modify(file, newContent);
}
