import { TFile } from 'obsidian';
import type TaggableTagsPlugin from '../main';

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
	
	// Simple YAML parsing for our use case
	const frontmatter: Record<string, unknown> = {};
	const lines = frontmatterStr.split('\n');
	let currentKey: string | null = null;
	let currentArray: string[] | null = null;
	
	for (const line of lines) {
		// Check for array item
		if (line.match(/^\s+-\s+/)) {
			if (currentArray !== null) {
				const value = line.replace(/^\s+-\s+/, '').trim();
				currentArray.push(value);
			}
			continue;
		}
		
		// Check for key: value
		const keyValueMatch = line.match(/^(\S+):\s*(.*)$/);
		if (keyValueMatch) {
			// Save previous array if any
			if (currentKey && currentArray !== null) {
				frontmatter[currentKey] = currentArray;
			}
			
			currentKey = keyValueMatch[1];
			const value = keyValueMatch[2].trim();
			
			// Check if it's an empty array or start of array
			if (value === '[]') {
				frontmatter[currentKey] = [];
				currentArray = null;
			} else if (value === '') {
				// Could be start of array
				currentArray = [];
			} else {
				frontmatter[currentKey] = value;
				currentArray = null;
			}
		}
	}
	
	// Save last array if any
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

/**
 * Generate content for a new tag file.
 * If a template file is configured and exists, uses it as a base.
 * Required properties (tag, tags, exception to) are added at the top if missing.
 */
export async function generateTagFileContent(
	plugin: TaggableTagsPlugin,
	tagName: string,
	parentTag?: string | null
): Promise<string> {
	const propName = plugin.settings.tagPropertyName;
	const exceptionPropName = plugin.settings.exceptionToPropertyName;
	const templatePath = plugin.settings.tagTemplateFile;
	
	// Check if template file is configured and exists
	if (templatePath) {
		const templateFile = plugin.app.vault.getAbstractFileByPath(templatePath);
		if (templateFile instanceof TFile) {
			try {
				const templateContent = await plugin.app.vault.read(templateFile);
				return processTemplate(templateContent, tagName, parentTag, propName, exceptionPropName);
			} catch (error) {
				// Template read failed, fall through to default
				console.warn('Failed to read tag template file:', error);
			}
		}
	}
	
	// Default content (no template)
	return generateDefaultContent(tagName, parentTag, propName, exceptionPropName);
}

/**
 * Process a template file content, adding required properties if missing.
 */
function processTemplate(
	templateContent: string,
	tagName: string,
	parentTag: string | null | undefined,
	propName: string,
	exceptionPropName: string
): string {
	const { frontmatter, body } = parseFrontmatter(templateContent);
	
	// Build the required properties that should be at the top
	const requiredProps: Record<string, unknown> = {};
	
	// Tag property (always set to the new tag name)
	requiredProps[propName] = tagName;
	
	// Tags property (add parent if provided, or empty array)
	if (parentTag) {
		requiredProps['tags'] = [parentTag];
	} else if (!frontmatter || !('tags' in frontmatter)) {
		requiredProps['tags'] = [];
	}
	
	// Exception to property (keep from template or add empty)
	if (!frontmatter || !(exceptionPropName in frontmatter)) {
		requiredProps[exceptionPropName] = [];
	}
	
	// Merge: required props first, then template props (excluding ones we're overriding)
	const mergedFrontmatter: Record<string, unknown> = { ...requiredProps };
	
	if (frontmatter) {
		for (const [key, value] of Object.entries(frontmatter)) {
			// Don't override the tag property (it must be the new tag name)
			if (key === propName) continue;
			// Don't override tags if we set a parent
			if (key === 'tags' && parentTag) continue;
			// Add other properties
			if (!(key in mergedFrontmatter)) {
				mergedFrontmatter[key] = value;
			}
		}
	}
	
	// Rebuild the content
	const newFrontmatter = serializeFrontmatter(mergedFrontmatter);
	return `---\n${newFrontmatter}\n---\n${body}`;
}

/**
 * Generate default tag file content (when no template is used).
 */
function generateDefaultContent(
	tagName: string,
	parentTag: string | null | undefined,
	propName: string,
	exceptionPropName: string
): string {
	let content = `---\n${propName}: ${tagName}\n`;
	
	if (parentTag) {
		content += `tags:\n  - ${parentTag}\n`;
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
 * @param plugin The plugin instance
 * @param file The file to modify
 * @param tagName The tag name to set
 * @param parentTag Optional parent tag to add to the tags array
 */
export async function addTagPropertiesToFile(
	plugin: TaggableTagsPlugin,
	file: TFile,
	tagName: string,
	parentTag?: string | null
): Promise<void> {
	const propName = plugin.settings.tagPropertyName;
	const exceptionPropName = plugin.settings.exceptionToPropertyName;
	
	const content = await plugin.app.vault.read(file);
	const { frontmatter, body } = parseFrontmatter(content);
	
	// Build the required properties
	const requiredProps: Record<string, unknown> = {};
	requiredProps[propName] = tagName;
	
	// Handle tags array - may need to add parent tag
	if (!frontmatter || !('tags' in frontmatter)) {
		requiredProps['tags'] = parentTag ? [parentTag] : [];
	} else if (parentTag) {
		// Existing tags array - add parent if not already present
		const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
		const normalizedParent = plugin.settings.forceLowercase ? parentTag.toLowerCase() : parentTag;
		const hasParent = existingTags.some((t: unknown) => {
			if (typeof t !== 'string') return false;
			const normalizedT = plugin.settings.forceLowercase ? t.toLowerCase() : t;
			return normalizedT === normalizedParent;
		});
		if (!hasParent) {
			requiredProps['tags'] = [parentTag, ...existingTags];
		}
	}
	
	if (!frontmatter || !(exceptionPropName in frontmatter)) {
		requiredProps[exceptionPropName] = [];
	}
	
	// Merge: required props first, then existing props
	const mergedFrontmatter: Record<string, unknown> = { ...requiredProps };
	
	if (frontmatter) {
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!(key in mergedFrontmatter)) {
				mergedFrontmatter[key] = value;
			}
		}
	}
	
	// Rebuild and save
	const newFrontmatter = serializeFrontmatter(mergedFrontmatter);
	const newContent = `---\n${newFrontmatter}\n---\n${body}`;
	
	await plugin.app.vault.modify(file, newContent);
}
