import type { App, CachedMetadata, TFile } from 'obsidian';

/**
 * Narrow Obsidian's loosely typed frontmatter object to a string-keyed record.
 */
export function frontmatterRecord(
	cache: CachedMetadata | null | undefined
): Record<string, unknown> | null {
	const fm: unknown = cache?.frontmatter;
	if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
		return null;
	}
	return fm as Record<string, unknown>;
}

export function readStringArray(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	return [];
}

export function readFrontmatterTags(
	cache: CachedMetadata | null | undefined
): string[] {
	const fm = frontmatterRecord(cache);
	if (!fm) {
		return [];
	}
	return readStringArray(fm['tags']);
}

export function readFrontmatterString(
	cache: CachedMetadata | null | undefined,
	key: string
): string | null {
	const fm = frontmatterRecord(cache);
	if (!fm) {
		return null;
	}
	const value = fm[key];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Run processFrontMatter after narrowing the payload from unknown.
 */
export async function processFrontmatterRecord(
	app: App,
	file: TFile,
	updater: (fm: Record<string, unknown>) => void
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (raw: unknown) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return;
		}
		updater(raw as Record<string, unknown>);
	});
}
