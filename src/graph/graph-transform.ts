import { normalizePath } from 'obsidian';
import type TaggableTagsPlugin from '../main';
import type {
	GraphColor,
	GraphFilterOptions,
	GraphNode,
	GraphRendererColors,
	RendererData,
} from './types';

function emptyNode(type = ''): GraphNode {
	return { type, links: {} };
}

function stripHash(tagId: string): string {
	return tagId.startsWith('#') ? tagId.slice(1) : tagId;
}

function withHash(tag: string): string {
	return tag.startsWith('#') ? tag : `#${tag}`;
}

function deleteNodeAndLinks(nodes: Record<string, GraphNode>, nodeId: string): void {
	delete nodes[nodeId];
	for (const node of Object.values(nodes)) {
		if (node.links[nodeId]) {
			delete node.links[nodeId];
		}
	}
}

function recountLinks(data: RendererData): void {
	let count = 0;
	for (const node of Object.values(data.nodes)) {
		count += Object.keys(node.links).length;
	}
	data.numLinks = count;
}

/**
 * Same orphan rule as Obsidian core: a node is kept if it has an outbound link
 * to another present node, or is targeted by another node's link.
 */
function removeOrphans(nodes: Record<string, GraphNode>): void {
	const inbound = new Set<string>();
	for (const [id, node] of Object.entries(nodes)) {
		for (const target of Object.keys(node.links)) {
			if (target !== id) {
				inbound.add(target);
			}
		}
	}

	for (const id of Object.keys(nodes)) {
		const node = nodes[id];
		let hasOutbound = false;
		for (const target of Object.keys(node.links)) {
			if (target !== id && nodes[target]) {
				hasOutbound = true;
				break;
			}
		}
		if (!hasOutbound && !inbound.has(id)) {
			delete nodes[id];
		}
	}
}

/**
 * Build maps from comparison-friendly tag forms to tag-note file paths,
 * and from file path to canonical tag name.
 */
function buildTagLookups(plugin: TaggableTagsPlugin): {
	resolveTagNodeId: (nodeId: string) => string | null;
} {
	const index = plugin.tagIndex;
	const tagToPath = new Map<string, string>();

	for (const tag of index.getAllTags()) {
		const file = index.getTagFile(tag);
		if (!file) continue;
		const path = file.path;
		tagToPath.set(tag.toLowerCase(), path);
		tagToPath.set(withHash(tag).toLowerCase(), path);
	}

	const resolveTagNodeId = (nodeId: string): string | null => {
		const stripped = stripHash(nodeId);
		const byLower = tagToPath.get(nodeId.toLowerCase()) ?? tagToPath.get(stripped.toLowerCase());
		if (byLower) return byLower;

		for (const tag of index.getAllTags()) {
			if (index.tagsMatch(stripped, tag) || index.tagsMatch(nodeId, tag)) {
				const file = index.getTagFile(tag);
				return file?.path ?? null;
			}
		}
		return null;
	};

	return { resolveTagNodeId };
}

function colorTagNoteNodes(
	plugin: TaggableTagsPlugin,
	nodes: Record<string, GraphNode>,
	fillTag: GraphColor | undefined
): void {
	if (!fillTag) return;
	for (const id of Object.keys(nodes)) {
		const file = plugin.app.vault.getAbstractFileByPath(id);
		if (!file || !('extension' in file)) continue;
		if (plugin.tagIndex.isTagFile(file as import('obsidian').TFile)) {
			nodes[id].color = fillTag;
			if (nodes[id].type === 'tag') {
				nodes[id].type = '';
			}
		}
	}
}

/**
 * Resolve a tag to a graph node id preferring an existing tag-note path, else #tag.
 */
function resolveTagGraphId(
	plugin: TaggableTagsPlugin,
	tag: string,
	nodes: Record<string, GraphNode>,
	resolveTagNodeId: (nodeId: string) => string | null
): string {
	const path = resolveTagNodeId(withHash(tag));
	if (path) {
		if (!nodes[path]) {
			nodes[path] = emptyNode('');
		}
		return path;
	}

	const hashId = withHash(plugin.tagIndex.normalizeTag(tag));
	for (const id of Object.keys(nodes)) {
		if (nodes[id].type === 'tag' && plugin.tagIndex.tagsMatch(stripHash(id), tag)) {
			return id;
		}
	}
	if (!nodes[hashId]) {
		nodes[hashId] = emptyNode('tag');
	}
	return hashId;
}

/**
 * Local graph expands from the file path only, before our setData patch.
 * Notes that link to #tag (not the tag note) are missing. Re-attach the tag's
 * direct relations from TagIndex when the centered file is a tag note.
 */
function expandLocalTagNoteRelations(
	plugin: TaggableTagsPlugin,
	nodes: Record<string, GraphNode>,
	localFile: string,
	resolveTagNodeId: (nodeId: string) => string | null
): void {
	const file = plugin.app.vault.getAbstractFileByPath(localFile);
	if (!file || !('extension' in file)) return;
	const tfile = file as import('obsidian').TFile;
	if (!plugin.tagIndex.isTagFile(tfile)) return;

	const tag =
		plugin.tagIndex.getTagForFilePath(localFile) ??
		plugin.tagIndex.fileToTagName(tfile);
	if (!tag) return;

	if (!nodes[localFile]) {
		nodes[localFile] = emptyNode('');
	}

	// Files tagged with this tag → same as note → #tag edges in the global graph
	for (const tagged of plugin.tagIndex.getFilesWithTag(tag)) {
		if (tagged.path === localFile) continue;
		if (plugin.tagIndex.isTagRegistryNote(tagged)) continue;
		if (!nodes[tagged.path]) {
			nodes[tagged.path] = emptyNode('');
		}
		nodes[tagged.path].links[localFile] = true;
	}

	// Parent tags (tag note frontmatter)
	for (const parent of plugin.tagIndex.getParentTags(tag)) {
		const parentId = resolveTagGraphId(plugin, parent, nodes, resolveTagNodeId);
		if (parentId === localFile) continue;
		nodes[localFile].links[parentId] = true;
	}

	// Child tags
	for (const child of plugin.tagIndex.getChildTags(tag)) {
		const childId = resolveTagGraphId(plugin, child, nodes, resolveTagNodeId);
		if (childId === localFile) continue;
		if (!nodes[childId]) {
			nodes[childId] = emptyNode(childId.startsWith('#') ? 'tag' : '');
		}
		nodes[childId].links[localFile] = true;
	}

	// Ensure the #tag node itself collapses into the center on the next pass
	const hashId = withHash(tag);
	if (nodes[hashId] && hashId !== localFile) {
		// leave for collapseTagNodes
	} else if (!nodes[hashId]) {
		// Optional: no separate tag node needed; relations already point at localFile
	}
}

function hideRegistryNode(plugin: TaggableTagsPlugin, nodes: Record<string, GraphNode>): void {
	const registryPath = normalizePath(plugin.settings.tagRegistryPath || '');
	if (registryPath && nodes[registryPath]) {
		deleteNodeAndLinks(nodes, registryPath);
	}

	for (const id of Object.keys(nodes)) {
		const file = plugin.app.vault.getAbstractFileByPath(id);
		if (file && 'extension' in file && plugin.tagIndex.isTagRegistryNote(file as import('obsidian').TFile)) {
			deleteNodeAndLinks(nodes, id);
		}
	}
}

function collapseTagNodes(
	nodes: Record<string, GraphNode>,
	resolveTagNodeId: (nodeId: string) => string | null,
	fillTag: GraphColor | undefined
): Set<string> {
	const collapsedPaths = new Set<string>();
	const tagIds = Object.keys(nodes).filter((id) => nodes[id].type === 'tag');

	for (const tagId of tagIds) {
		const filePath = resolveTagNodeId(tagId);
		if (!filePath) continue;

		if (!nodes[filePath]) {
			nodes[filePath] = emptyNode('');
		}

		const fileNode = nodes[filePath];
		const tagNode = nodes[tagId];

		// Merge outbound links from tag node onto file node
		for (const [target, val] of Object.entries(tagNode.links)) {
			if (target === tagId || target === filePath) continue;
			fileNode.links[target] = val;
		}

		// Rewrite inbound links from tag id to file path
		for (const [id, node] of Object.entries(nodes)) {
			if (id === tagId) continue;
			if (node.links[tagId]) {
				delete node.links[tagId];
				if (id !== filePath) {
					node.links[filePath] = true;
				}
			}
		}

		delete nodes[tagId];
		delete fileNode.links[filePath];
		delete fileNode.links[tagId];

		if (fillTag) {
			fileNode.color = fillTag;
		}
		// Keep as file node so click opens the note (not tag search).
		// Preserve "focused" so the local-graph center keeps its focus color.
		if (fileNode.type === 'tag') {
			fileNode.type = '';
		}

		collapsedPaths.add(filePath);
	}

	return collapsedPaths;
}

/**
 * For tags that have no tag note, add parent→child edges between remaining tag nodes.
 */
function addNarrowHierarchyEdges(
	plugin: TaggableTagsPlugin,
	nodes: Record<string, GraphNode>,
	resolveTagNodeId: (nodeId: string) => string | null
): void {
	const index = plugin.tagIndex;

	const findTagNodeId = (tag: string): string | null => {
		const path = resolveTagNodeId(withHash(tag));
		if (path && nodes[path]) return path;

		const candidates = [withHash(tag), tag, withHash(tag).toLowerCase()];
		for (const id of Object.keys(nodes)) {
			if (nodes[id].type !== 'tag') continue;
			const stripped = stripHash(id);
			if (index.tagsMatch(stripped, tag)) return id;
		}
		for (const c of candidates) {
			if (nodes[c]) return c;
		}
		return null;
	};

	for (const tag of index.getAllTags()) {
		// Only for tags without a tag file still represented as tag nodes,
		// OR to connect parent/child when parent has no file.
		const parents = index.getParentTags(tag);
		if (parents.length === 0) continue;

		const childId = findTagNodeId(tag);
		if (!childId || !nodes[childId]) continue;

		for (const parent of parents) {
			const parentId = findTagNodeId(parent);
			if (!parentId || !nodes[parentId] || parentId === childId) continue;
			nodes[childId].links[parentId] = true;
		}
	}
}

function hideTagNoteNodes(plugin: TaggableTagsPlugin, nodes: Record<string, GraphNode>): void {
	for (const id of Object.keys(nodes)) {
		const file = plugin.app.vault.getAbstractFileByPath(id);
		if (!file || !('extension' in file)) continue;
		const tfile = file as import('obsidian').TFile;
		if (plugin.tagIndex.isTagFile(tfile)) {
			deleteNodeAndLinks(nodes, id);
		}
	}
}

function reinjectTagNotes(
	plugin: TaggableTagsPlugin,
	nodes: Record<string, GraphNode>
): void {
	for (const tag of plugin.tagIndex.getAllTags()) {
		const file = plugin.tagIndex.getTagFile(tag);
		if (!file) continue;
		if (!nodes[file.path]) {
			nodes[file.path] = emptyNode('');
		}
	}
}

/**
 * Transform graph renderer data for Taggable Tags compatibility.
 * Always hides the tag registry node. Full merge/hierarchy only when graphCompatEnabled.
 */
export function transformGraphData(
	plugin: TaggableTagsPlugin,
	data: RendererData,
	filterOptions: GraphFilterOptions,
	colors?: GraphRendererColors
): RendererData {
	if (!data || typeof data !== 'object' || !data.nodes || typeof data.nodes !== 'object') {
		return data;
	}

	// Work on a shallow clone of the nodes map so we don't surprise callers mid-iterate
	const nodes: Record<string, GraphNode> = { ...data.nodes };
	for (const id of Object.keys(nodes)) {
		const n = nodes[id];
		nodes[id] = {
			type: n.type,
			links: { ...(n.links || {}) },
			color: n.color,
		};
	}
	data = { numLinks: data.numLinks, nodes };

	hideRegistryNode(plugin, nodes);

	if (!plugin.settings.graphCompatEnabled) {
		recountLinks(data);
		return data;
	}

	const showTags = filterOptions.showTags !== false;
	const showOrphans = filterOptions.showOrphans !== false;
	const localFile =
		typeof filterOptions.localFile === 'string' && filterOptions.localFile
			? filterOptions.localFile
			: null;
	const { resolveTagNodeId } = buildTagLookups(plugin);

	// Local graph is filtered to neighbors of the file path before setData.
	// Expand tag-note centers with TagIndex relations (files using the tag, parents, children).
	if (showTags && localFile) {
		expandLocalTagNoteRelations(plugin, nodes, localFile, resolveTagNodeId);
	}

	if (!showOrphans) {
		reinjectTagNotes(plugin, nodes);
	}

	if (showTags) {
		collapseTagNodes(nodes, resolveTagNodeId, colors?.fillTag);
		addNarrowHierarchyEdges(plugin, nodes, resolveTagNodeId);
		colorTagNoteNodes(plugin, nodes, colors?.fillTag);
	}

	if (!showOrphans) {
		removeOrphans(nodes);
	}

	if (!showTags) {
		hideTagNoteNodes(plugin, nodes);
	}

	recountLinks(data);
	return data;
}
