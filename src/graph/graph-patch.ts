import type TaggableTagsPlugin from '../main';
import { readGraphFilterOptions } from './graph-filter-state';
import { transformGraphData } from './graph-transform';
import type { GraphLeaf, GraphRenderer, RendererData } from './types';

const GRAPH_VIEW_TYPES = ['graph', 'localgraph'] as const;

function isGraphLeaf(leaf: unknown): leaf is GraphLeaf {
	if (!leaf || typeof leaf !== 'object') return false;
	const view = (leaf as { view?: { unload?: unknown } }).view;
	return !!view && typeof view === 'object' && typeof view.unload === 'function';
}

function getGraphLeaves(plugin: TaggableTagsPlugin): GraphLeaf[] {
	const leaves: GraphLeaf[] = [];
	for (const type of GRAPH_VIEW_TYPES) {
		for (const leaf of plugin.app.workspace.getLeavesOfType(type)) {
			if (isGraphLeaf(leaf)) {
				leaves.push(leaf);
			}
		}
	}
	return leaves;
}

function featureDetectRenderer(renderer: unknown): renderer is GraphRenderer {
	return (
		!!renderer &&
		typeof renderer === 'object' &&
		typeof (renderer as GraphRenderer).setData === 'function'
	);
}

function patchLeaf(plugin: TaggableTagsPlugin, leaf: GraphLeaf): boolean {
	const renderer = leaf.view.renderer;
	if (!featureDetectRenderer(renderer)) {
		return false;
	}

	if (renderer.originalSetData !== undefined) {
		return false; // already patched
	}

	renderer.originalSetData = renderer.setData.bind(renderer);
	renderer.setData = (data: RendererData) => {
		try {
			const options = readGraphFilterOptions(leaf);
			const transformed = transformGraphData(
				plugin,
				data,
				options,
				renderer.colors
			);
			return renderer.originalSetData!(transformed);
		} catch (e) {
			console.error('Taggable Tags: graph transform failed', e);
			return renderer.originalSetData!(data);
		}
	};

	try {
		leaf.view.unload();
		leaf.view.load();
	} catch (e) {
		console.error('Taggable Tags: failed to reload graph leaf after patch', e);
	}

	return true;
}

function unpatchLeaf(leaf: GraphLeaf): void {
	const renderer = leaf.view.renderer;
	if (!featureDetectRenderer(renderer) || !renderer.originalSetData) {
		return;
	}

	renderer.setData = renderer.originalSetData;
	delete renderer.originalSetData;

	try {
		leaf.view.unload();
		leaf.view.load();
	} catch (e) {
		console.error('Taggable Tags: failed to reload graph leaf after unpatch', e);
	}
}

/**
 * Force open graph leaves to rebuild with current settings (re-trigger setData).
 */
export function refreshGraphLeaves(plugin: TaggableTagsPlugin): void {
	for (const leaf of getGraphLeaves(plugin)) {
		const engine = leaf.view.dataEngine ?? leaf.view.engine;
		if (engine && typeof engine.render === 'function') {
			try {
				engine.render();
				continue;
			} catch {
				// fall through to unload/load
			}
		}
		try {
			leaf.view.unload();
			leaf.view.load();
		} catch {
			// ignore
		}
	}
}

/**
 * Patch graph / localgraph leaves. Safe to call repeatedly.
 * Registry hiding always applies; full compat respects settings.graphCompatEnabled.
 */
export function setupGraphCompat(plugin: TaggableTagsPlugin): void {
	const patchAll = () => {
		for (const leaf of getGraphLeaves(plugin)) {
			patchLeaf(plugin, leaf);
		}
	};

	patchAll();

	plugin.registerEvent(
		plugin.app.workspace.on('layout-change', () => {
			patchAll();
		})
	);

	plugin.registerEvent(
		plugin.app.workspace.on('active-leaf-change', (leaf) => {
			if (leaf && isGraphLeaf(leaf)) {
				patchLeaf(plugin, leaf);
			}
		})
	);
}

export function teardownGraphCompat(plugin: TaggableTagsPlugin): void {
	for (const leaf of getGraphLeaves(plugin)) {
		unpatchLeaf(leaf);
	}
}
