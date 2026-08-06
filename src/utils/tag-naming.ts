import type { TaggableTagsSettings } from '../settings';

const DEFAULT_SPACE_SEPARATOR = '_';

/**
 * Resolve the configured space→separator character.
 * Falls back to '_' if empty, multi-char, whitespace, or '#'.
 */
export function resolveTagSpaceSeparator(settings: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>): string {
	const sep = settings.tagSpaceSeparator;
	if (!sep || sep.length !== 1 || /\s/.test(sep) || sep === '#') {
		return DEFAULT_SPACE_SEPARATOR;
	}
	return sep;
}

/**
 * Validate a free-text separator from settings UI.
 * Returns the character to store, or '_' if invalid.
 */
export function sanitizeTagSpaceSeparatorInput(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return DEFAULT_SPACE_SEPARATOR;
	}
	// Use first character only
	const ch = trimmed[0];
	if (/\s/.test(ch) || ch === '#') {
		return DEFAULT_SPACE_SEPARATOR;
	}
	return ch;
}

/**
 * Whether user-facing tag name input is valid (spaces allowed; # not allowed).
 */
export function isValidTagNameInput(raw: string): boolean {
	const name = raw.startsWith('#') ? raw.slice(1) : raw;
	return name.trim().length > 0 && !name.includes('#');
}

/**
 * Word-break characters treated as equivalent when canonicalizing / comparing tags.
 * Includes the configured space separator plus the common legacy separators.
 */
function wordBreakSeparators(
	settings?: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): Set<string> {
	const seps = new Set(['-', '_', ' ']);
	if (settings) {
		seps.add(resolveTagSpaceSeparator(settings));
	} else {
		seps.add(DEFAULT_SPACE_SEPARATOR);
	}
	return seps;
}

/**
 * Split a tag name into word segments on any equivalent separator (-, _, space, configured).
 * Preserves case; empty segments from consecutive separators are dropped.
 */
export function splitTagNameSegments(
	raw: string,
	settings?: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): string[] {
	let name = raw.startsWith('#') ? raw.slice(1) : raw;
	name = name.trim();
	if (!name) return [];

	const seps = wordBreakSeparators(settings);
	const segments: string[] = [];
	let current = '';
	for (const ch of name) {
		if (seps.has(ch)) {
			if (current.length > 0) {
				segments.push(current);
				current = '';
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) {
		segments.push(current);
	}
	return segments;
}

/**
 * Canonical tag form for properties and applied tags:
 * strip #, trim, treat '-', '_', spaces, and the configured separator as equivalent
 * word breaks, rejoin with the configured separator, preserve case.
 *
 * Examples (separator `_`): `Voting-Theory` → `Voting_Theory`, `Land Value Tax` → `Land_Value_Tax`.
 */
export function toCanonicalTagName(
	raw: string,
	settings: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): string {
	const sep = resolveTagSpaceSeparator(settings);
	return splitTagNameSegments(raw, settings).join(sep);
}

/**
 * Join tag name segments with the configured space separator.
 * Each segment is canonicalized first (e.g. ["Quotes", "Sociognosticism"] → "Quotes_Sociognosticism").
 */
export function joinTagNameSegments(
	segments: string[],
	settings: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): string {
	const sep = resolveTagSpaceSeparator(settings);
	return segments
		.map(s => toCanonicalTagName(s, settings))
		.filter(s => s.length > 0)
		.join(sep);
}

/**
 * Display name for tag notes and tag folders (basename / folder segment).
 * When replaceSeparatorsWithSpaces is on, all equivalent separators become spaces.
 * When off, uses the same canonical form as tags (configured separator).
 * Always applies filesystem sanitization for illegal characters.
 */
export function toDisplayName(
	raw: string,
	settings: Pick<TaggableTagsSettings, 'tagSpaceSeparator' | 'replaceSeparatorsWithSpaces'>
): string {
	const segments = splitTagNameSegments(raw, settings);
	const name = settings.replaceSeparatorsWithSpaces
		? segments.join(' ')
		: segments.join(resolveTagSpaceSeparator(settings));

	return sanitizeForFilesystem(name);
}

/**
 * Comparison key: case-insensitive; configured separator, '-', '_', and spaces are equivalent word breaks.
 */
export function toComparisonKey(
	name: string,
	settings?: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): string {
	return splitTagNameSegments(name, settings)
		.map(s => s.toLowerCase())
		.join(' ');
}

/**
 * Check if two names refer to the same tag / note / folder for matching purposes.
 */
export function namesMatch(
	a: string,
	b: string,
	settings?: Pick<TaggableTagsSettings, 'tagSpaceSeparator'>
): boolean {
	return toComparisonKey(a, settings) === toComparisonKey(b, settings);
}

/**
 * Sanitize a name for use as a filename / folder segment.
 * Handles characters that aren't allowed on common filesystems.
 */
export function sanitizeForFilesystem(name: string): string {
	return name
		.replace(/\//g, '--slash--')
		.replace(/\\/g, '--backslash--')
		.replace(/:/g, '--colon--')
		.replace(/\*/g, '--star--')
		.replace(/\?/g, '--question--')
		.replace(/"/g, '--quote--')
		.replace(/</g, '--lt--')
		.replace(/>/g, '--gt--')
		.replace(/\|/g, '--pipe--');
}

/**
 * Reverse filesystem sanitization.
 */
export function unsanitizeFromFilesystem(filename: string): string {
	return filename
		.replace(/--slash--/g, '/')
		.replace(/--backslash--/g, '\\')
		.replace(/--colon--/g, ':')
		.replace(/--star--/g, '*')
		.replace(/--question--/g, '?')
		.replace(/--quote--/g, '"')
		.replace(/--lt--/g, '<')
		.replace(/--gt--/g, '>')
		.replace(/--pipe--/g, '|');
}
