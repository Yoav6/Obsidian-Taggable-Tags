import type { TagSource } from '../migration/conflict-detector';

/**
 * Append slash-separated path segments so nesting order stays left-to-right
 * while each segment still renders in its natural text direction.
 */
export function appendIsolatedPathSegments(container: HTMLElement, path: string): void {
	const parts = path.split('/');
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) {
			container.createSpan({ text: '/' });
		}
		container.createEl('bdi', { text: parts[i] });
	}
}

/**
 * Render a conflict source label with bidi-isolated path segments.
 */
export function appendSourceDescription(container: HTMLElement, source: TagSource): HTMLElement {
	const el = container.createSpan({ cls: 'taggable-tags-conflict-path' });

	switch (source.type) {
		case 'folder':
			el.createSpan({ text: 'Folder: ' });
			appendIsolatedPathSegments(el, source.folder?.path || 'unknown');
			break;
		case 'existing-tag':
			el.createSpan({ text: 'Tag file: ' });
			appendIsolatedPathSegments(el, source.existingTagFile?.path || 'unknown');
			break;
		case 'matching-note':
			el.createSpan({ text: 'Matching note: ' });
			appendIsolatedPathSegments(el, source.matchingNote?.path || 'unknown');
			break;
		case 'nested-tag':
			el.createSpan({ text: 'Nested tag: #' });
			appendIsolatedPathSegments(el, source.nestedTagPath || 'unknown');
			break;
		default:
			el.setText('Unknown source');
	}

	return el;
}
