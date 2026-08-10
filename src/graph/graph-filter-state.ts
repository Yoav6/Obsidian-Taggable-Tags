import type { GraphFilterOptions, GraphLeaf } from './types';

/**
 * Read showTags / showOrphans from a graph or localgraph leaf.
 * Global graph uses dataEngine; local graph uses engine.
 */
export function readGraphFilterOptions(leaf: GraphLeaf): GraphFilterOptions {
	const view = leaf.view;
	const options = view.dataEngine?.options ?? view.engine?.options;
	if (!options || typeof options !== 'object') {
		return { showTags: true, showOrphans: true };
	}
	return {
		showTags: options.showTags !== false,
		showOrphans: options.showOrphans !== false,
	};
}
