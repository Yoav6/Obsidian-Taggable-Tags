import type TaggableTagsPlugin from '../main';
import type { MigrationSettings } from '../commands/migrate-vault';
import { VaultModel } from './vault-model';
import {
	addOp,
	createEmptyPlan,
	type MigrationPlan,
} from './plan';
import {
	buildResolvedConflictMap,
	getResolvedTagName,
	parentTagForSource,
	type ConflictResolution,
	type NamingConflict,
	type ResolvedConflictMap,
	type TagSource,
	sourceId,
} from './conflict-detector';
import {
	collectSafeParentTags,
	filterSafeParentTags,
	wouldParentCreateCycle,
} from '../utils/cycle-prevention';
import { joinTagNameSegments, toComparisonKey } from '../utils/tag-naming';

export interface PlannerInput {
	settings: MigrationSettings;
	resolvedConflicts: Map<NamingConflict, ConflictResolution[]> | null;
}

/**
 * Build a complete migration plan against an in-memory vault model.
 */
export function buildMigrationPlan(
	plugin: TaggableTagsPlugin,
	input: PlannerInput
): MigrationPlan {
	const model = VaultModel.fromVault(plugin, input.settings.excludedFolders);
	const plan = createEmptyPlan();
	const resolved = input.resolvedConflicts
		? buildResolvedConflictMap(input.resolvedConflicts)
		: buildResolvedConflictMap(new Map());

	if (input.resolvedConflicts) {
		planConflictOps(plugin, model, plan, input.resolvedConflicts, resolved);
	}

	if (input.settings.flattenNestedTags) {
		planFlattenOps(plugin, model, plan, resolved);
	}

	planFolderTagNotes(plugin, model, plan, resolved);
	planFolderTagsOnFiles(plugin, model, plan);
	if (input.settings.removeRedundantParentTags) {
		planRedundantTagRemoval(plugin, model, plan);
	}
	planRemainingTagNotes(plugin, model, plan);

	plan.emptyFolders = model.getEmptyFolders().map(f => f.path);
	return plan;
}

function planConflictOps(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	resolutions: Map<NamingConflict, ConflictResolution[]>,
	resolved: ResolvedConflictMap
): void {
	for (const [conflict, conflictResolutions] of resolutions) {
		const keeper = conflictResolutions.find(r => r.kind === 'keep' || r.keepsOriginalName);

		for (const resolution of conflictResolutions) {
			if (resolution.kind === 'keep' || resolution.keepsOriginalName) continue;

			const source = resolution.source;

			if (resolution.kind === 'merge' && resolution.mergeInto && keeper) {
				const survivor = getResolvedTagName(plugin, keeper.source, keeper, conflict.name);
				const removed = getResolvedTagName(plugin, source, resolution, conflict.name);
				if (!model.tagsMatch(survivor, removed)) {
					emitMerge(model, plan, survivor, removed, 'Conflict merge');
				}
				continue;
			}

			if (resolution.kind === 'merge') continue;

			if (resolution.kind === 'delete') {
				planDeleteResolution(plugin, model, plan, resolution, resolved);
				continue;
			}

			if (resolution.kind === 'rename') {
				const newName = plugin.tagIndex.toDisplayName(
					plugin.tagIndex.normalizeTag(resolution.newName)
				);
				const canonical = plugin.tagIndex.normalizeTag(resolution.newName);
				const contextParent = parentTagForSource(plugin, source);

				if (source.type === 'folder' && source.folder) {
					const oldPath = source.folder.path;
					if (resolved.excludedPaths.has(oldPath)) continue;
					const newPath = model.renameFolder(oldPath, newName);
					if (newPath) {
						addOp(plan, {
							kind: 'rename-folder',
							from: oldPath,
							to: newPath,
							reason: `Resolve conflict for #${conflict.name}`,
						});
						const matchingInModel = model.findMatchingFileInFolder(newPath, source.name);
						if (matchingInModel) {
							const displayBasename = plugin.tagIndex.toDisplayName(canonical);
							let filePath = matchingInModel.path;
							if (matchingInModel.basename !== displayBasename) {
								const fromFilePath = matchingInModel.path;
								const renamedPath = model.renameFile(fromFilePath, displayBasename);
								if (renamedPath) {
									addOp(plan, {
										kind: 'rename-file',
										from: fromFilePath,
										to: renamedPath,
										reason: `Rename matching note with folder`,
									});
									filePath = renamedPath;
								}
							}
							if (matchingInModel.tagName) {
								model.setFileTagNote(filePath, canonical, []);
							}
						}
						if (resolution.keeperIsParent && keeper) {
							applyKeeperAsParent(
								plugin,
								model,
								plan,
								conflict.name,
								canonical,
								newPath,
								keeper.source.name,
								contextParentForFolder(plugin, newPath)
							);
						}
					}
				} else if (source.type === 'existing-tag' && source.existingTagFile) {
					const oldPath = source.existingTagFile.path;
					if (resolved.deletedFilePaths.has(oldPath)) continue;
					const newFilePath = model.renameFile(
						oldPath,
						plugin.tagIndex.toDisplayName(canonical)
					);
					if (newFilePath) {
						addOp(plan, {
							kind: 'rename-file',
							from: oldPath,
							to: newFilePath,
							reason: `Resolve conflict for #${conflict.name}`,
						});
						const parents = resolution.keeperIsParent && keeper
							? collectSafeParentTags(
								plugin,
								canonical,
								contextParent,
								[keeper.source.name, ...(contextParent ? [contextParent] : [])]
							)
							: model.getParentTags(canonical);
						model.setFileTagNote(newFilePath, canonical, parents);
						if (resolution.keeperIsParent && keeper && parents.length > 0) {
							addOp(plan, {
								kind: 'set-tag-parents',
								path: newFilePath,
								tag: canonical,
								parents,
								reason: `Add keeper as parent for #${conflict.name}`,
							});
						}
					}
				} else if (source.type === 'matching-note' && source.matchingNote) {
					const oldPath = source.matchingNote.path;
					if (resolved.deletedFilePaths.has(oldPath)) continue;
					const newFilePath = model.renameFile(
						oldPath,
						plugin.tagIndex.toDisplayName(canonical)
					);
					if (newFilePath) {
						addOp(plan, {
							kind: 'rename-file',
							from: oldPath,
							to: newFilePath,
							reason: `Resolve misplaced matching note`,
						});
					}
				}
				// nested-tag renames are applied during flatten via bySourceId
			}
		}
	}
}

function planDeleteResolution(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	resolution: ConflictResolution,
	resolved: ResolvedConflictMap
): void {
	const source = resolution.source;

	if (source.type === 'folder' && source.folder) {
		const path = source.folder.path;
		if (resolved.excludedPaths.has(path)) return;
		if (model.deleteFolder(path)) {
			addOp(plan, {
				kind: 'delete-folder',
				path,
				reason: `Delete conflicting folder #${source.name}`,
			});
			resolved.excludedPaths.add(path);
		}
		return;
	}

	if (source.type === 'existing-tag' && source.existingTagFile) {
		const path = source.existingTagFile.path;
		if (resolved.deletedFilePaths.has(path)) return;
		if (model.deleteFile(path)) {
			addOp(plan, {
				kind: 'delete-file',
				path,
				reason: `Delete conflicting tag file #${source.name}`,
			});
			resolved.deletedFilePaths.add(path);
		}
		return;
	}

	if (source.type === 'matching-note' && source.matchingNote) {
		const path = source.matchingNote.path;
		if (resolved.deletedFilePaths.has(path)) return;
		if (model.deleteFile(path)) {
			addOp(plan, {
				kind: 'delete-file',
				path,
				reason: `Delete conflicting matching note #${source.name}`,
			});
			resolved.deletedFilePaths.add(path);
		}
		return;
	}

	if (source.type === 'nested-tag' && source.nestedTagPath) {
		planNestedTagDelete(plugin, model, plan, source);
	}
}

function planNestedTagDelete(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	source: TagSource
): void {
	if (source.type !== 'nested-tag' || !source.nestedTagPath) return;
	const prefix = source.nestedTagPath;
	const nested = model.findNestedTags();
	for (const info of nested) {
		const matches =
			info.fullTag === prefix ||
			info.fullTag.startsWith(prefix + '/') ||
			info.rawFullTag === prefix ||
			info.rawFullTag.startsWith(prefix + '/');
		if (!matches) continue;

		for (const filePath of info.files) {
			const file = model.getFile(filePath);
			if (!file || file.excluded) continue;
			addOp(plan, {
				kind: 'edit-file-tags',
				path: filePath,
				add: [],
				remove: [info.rawFullTag],
				rewrite: [],
				reason: `Delete nested tag #${prefix}`,
			});
			model.editFileTags(filePath, [], [info.rawFullTag], []);
		}
	}
}

function applyKeeperAsParent(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	conflictName: string,
	canonical: string,
	folderPath: string,
	keeperName: string,
	contextParent: string | null
): void {
	const parents = collectSafeParentTags(
		plugin,
		canonical,
		contextParent,
		[keeperName, ...(contextParent ? [contextParent] : [])]
	);
	const tagPath = tagNotePathForFolder(plugin, folderPath, canonical);
	if (!model.getTagFile(canonical)) {
		const matchingInFolder = model.findNamedFileInFolder(folderPath, canonical)
			?? model.findMatchingFileInFolder(folderPath, canonical)
			?? model.getFile(tagPath);
		emitTagNote(
			plugin,
			model,
			plan,
			matchingInFolder?.path ?? tagPath,
			canonical,
			parents,
			`Add keeper as parent for #${conflictName}`
		);
	} else {
		addOp(plan, {
			kind: 'set-tag-parents',
			path: model.getTagFile(canonical)!,
			tag: canonical,
			parents,
			reason: `Add keeper as parent for #${conflictName}`,
		});
		model.setTagParents(canonical, parents);
	}
}

function contextParentForFolder(plugin: TaggableTagsPlugin, folderPath: string): string | null {
	const parts = folderPath.split('/').filter(Boolean);
	if (parts.length < 2) return null;
	const parentPath = parts.slice(0, -1).join('/');
	return modelTagFromFolderPath(plugin, parentPath);
}

function modelTagFromFolderPath(plugin: TaggableTagsPlugin, folderPath: string): string | null {
	if (!folderPath) return null;
	const parts = folderPath.split('/').filter(Boolean);
	return plugin.tagIndex.normalizeTag(parts[parts.length - 1]);
}

function emitMerge(
	model: VaultModel,
	plan: MigrationPlan,
	survivor: string,
	removed: string,
	reason: string
): void {
	addOp(plan, { kind: 'merge-tags', survivor, removed, reason });
	model.mergeTags(survivor, removed);
}

interface FlattenMapping {
	/** pair key tag::parent -> resolved canonical name */
	resolvedByPair: Map<string, string>;
	/** nested full tag -> leaf replacement */
	leafReplacements: Map<string, { from: string; to: string }>;
}

function planFlattenOps(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	resolved: ResolvedConflictMap
): void {
	const nested = model.findNestedTags();
	if (nested.length === 0) return;

	const mapping: FlattenMapping = {
		resolvedByPair: new Map(),
		leafReplacements: new Map(),
	};

	const pairKey = (tag: string, parent: string | null) =>
		toComparisonKey(tag, plugin.settings) + '::' + (parent ? toComparisonKey(parent, plugin.settings) : '');

	const allLevels: Array<{ tag: string; parent: string | null; grandparent: string | null }> = [];
	const seen = new Set<string>();

	for (const info of nested) {
		for (let i = 0; i < info.levels.length; i++) {
			const tag = info.levels[i];
			const parent = i > 0 ? info.levels[i - 1] : null;
			const grandparent = i > 1 ? info.levels[i - 2] : null;
			const key = pairKey(tag, parent);
			if (!seen.has(key)) {
				seen.add(key);
				allLevels.push({ tag, parent, grandparent });
			}
		}
	}

	// Topo order by parent pair
	const processed = new Set<string>();
	const ordered: typeof allLevels = [];
	for (const entry of allLevels.filter(e => e.parent === null)) {
		ordered.push(entry);
		processed.add(pairKey(entry.tag, entry.parent));
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of allLevels) {
			const key = pairKey(entry.tag, entry.parent);
			if (processed.has(key) || entry.parent === null) continue;
			const parentPairKey = pairKey(entry.parent, entry.grandparent);
			if (processed.has(parentPairKey)) {
				ordered.push(entry);
				processed.add(key);
				changed = true;
			}
		}
	}
	for (const entry of allLevels) {
		const key = pairKey(entry.tag, entry.parent);
		if (!processed.has(key)) {
			ordered.push(entry);
			processed.add(key);
		}
	}

	for (const entry of ordered) {
		const nestedResolution = findNestedLevelResolution(resolved, entry.tag, entry.parent);
		if (nestedResolution?.kind === 'delete') {
			continue;
		}

		const effectiveParent = entry.parent
			? mapping.resolvedByPair.get(pairKey(entry.parent, entry.grandparent)) ?? entry.parent
			: null;

		let canonical: string;
		let parents: string[];
		if (nestedResolution?.kind === 'rename') {
			canonical = plugin.tagIndex.normalizeTag(nestedResolution.newName);
			if (nestedResolution.keeperIsParent) {
				const keeperResolution = findKeeperForNestedResolution(resolved, nestedResolution);
				parents = keeperResolution
					? collectSafeParentTags(
						plugin,
						canonical,
						effectiveParent,
						[keeperResolution.source.name, ...(effectiveParent ? [effectiveParent] : [])]
					)
					: filterSafeParentTags(
						plugin,
						canonical,
						resolveFlattenName(plugin, model, entry.tag, effectiveParent).parents
					);
			} else {
				parents = resolveFlattenName(plugin, model, entry.tag, effectiveParent).parents;
			}
		} else {
			({ canonical, parents } = resolveFlattenName(plugin, model, entry.tag, effectiveParent));
		}
		mapping.resolvedByPair.set(pairKey(entry.tag, entry.parent), canonical);

		if (!model.getTagFile(canonical)) {
			const tagPath = placeTagNote(plugin, model, canonical, effectiveParent);
			const safeParents = filterSafeParentTags(plugin, canonical, parents);
			emitTagNote(
				plugin,
				model,
				plan,
				tagPath,
				canonical,
				safeParents,
				`Flatten nested tag level #${entry.tag}`
			);
		} else if (parents.length > 0) {
			const path = model.getTagFile(canonical)!;
			addOp(plan, {
				kind: 'set-tag-parents',
				path,
				tag: canonical,
				parents: filterSafeParentTags(plugin, canonical, parents),
				reason: `Flatten parent for #${canonical}`,
			});
			model.setTagParents(canonical, parents);
		}
	}

	for (const info of nested) {
		const leafParent = info.levels.length >= 2 ? info.levels[info.levels.length - 2] : null;
		const replacement =
			mapping.resolvedByPair.get(
				pairKey(info.levels[info.levels.length - 1], leafParent)
			) ?? info.levels[info.levels.length - 1];
		mapping.leafReplacements.set(info.fullTag, {
			from: info.rawFullTag,
			to: replacement,
		});
	}

	for (const info of nested) {
		const replacement = mapping.leafReplacements.get(info.fullTag);
		if (!replacement) continue;
		for (const filePath of info.files) {
			const file = model.getFile(filePath);
			if (!file || file.excluded) continue;
			addOp(plan, {
				kind: 'edit-file-tags',
				path: filePath,
				add: [],
				remove: [],
				rewrite: [{ from: replacement.from, to: replacement.to }],
				reason: `Flatten #${info.fullTag}`,
			});
			model.editFileTags(filePath, [], [], [{ from: replacement.from, to: replacement.to }]);
		}
	}
}

function resolveFlattenName(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	tagName: string,
	parentTag: string | null
): { canonical: string; parents: string[] } {
	const normalized = plugin.tagIndex.normalizeTag(tagName);
	if (!parentTag || wouldParentCreateCycle(plugin, normalized, parentTag)) {
		return { canonical: normalized, parents: [] };
	}

	const safeParent = plugin.tagIndex.normalizeTag(parentTag);
	if (needsDisambiguation(plugin, model, normalized, safeParent)) {
		const compound = joinTagNameSegments([normalized, safeParent], plugin.settings);
		return {
			canonical: compound,
			parents: collectSafeParentTags(plugin, compound, safeParent, [normalized]),
		};
	}

	return {
		canonical: normalized,
		parents: collectSafeParentTags(plugin, normalized, safeParent, []),
	};
}

function needsDisambiguation(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	tagName: string,
	parentTag: string
): boolean {
	const existing = model.getTagFile(tagName);
	if (existing) {
		const file = model.getFile(existing);
		if (file?.parentPath) {
			const parentFolders = model.findFoldersWithLeafTag(parentTag);
			for (const pf of parentFolders) {
				if (model.isFolderUnder(file.parentPath, pf.path)) return false;
			}
		}
		return true;
	}

	const parentFolders = model.findFoldersWithLeafTag(parentTag);
	const peers = model.findFoldersWithLeafTag(tagName);
	for (const folder of peers) {
		const underParent = parentFolders.some(pf => model.isFolderUnder(folder.path, pf.path));
		if (!underParent) return true;
	}
	return false;
}

function placeTagNote(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	tagName: string,
	parentTag: string | null
): string {
	const displayName = plugin.tagIndex.toDisplayName(tagName);

	if (parentTag) {
		const parentFolders = model.findFoldersWithLeafTag(parentTag);
		parentFolders.sort((a, b) => model.folderDepth(a.path) - model.folderDepth(b.path));
		for (const pf of parentFolders) {
			const matching = model.findNamedFileInFolder(pf.path, tagName)
				?? model.findMatchingFileInFolder(pf.path, tagName);
			if (matching) return matching.path;
			const childFolder = [...model.folders.values()].find(
				f => f.parentPath === pf.path && plugin.tagIndex.tagsMatch(f.name, tagName)
			);
			if (childFolder) {
				const inChild = model.findNamedFileInFolder(childFolder.path, tagName)
					?? model.findNamedFileInFolder(childFolder.path, childFolder.name)
					?? model.getFile(`${childFolder.path}/${childFolder.name}.md`);
				if (inChild) return inChild.path;
				return `${childFolder.path}/${childFolder.name}.md`;
			}
		}
	}

	const vaultWide = model.findFoldersWithLeafTag(tagName);
	if (vaultWide.length === 1) {
		const f = vaultWide[0];
		const matching = model.findNamedFileInFolder(f.path, tagName)
			?? model.findNamedFileInFolder(f.path, f.name)
			?? model.findMatchingFileInFolder(f.path, tagName)
			?? model.getFile(`${f.path}/${f.name}.md`);
		if (matching) return matching.path;
		return `${f.path}/${f.name}.md`;
	}

	return `${displayName}.md`;
}

function computeKeepers(plugin: TaggableTagsPlugin, model: VaultModel): Map<string, string | null> {
	const claimants = new Map<string, Array<{ path: string; depth: number }>>();

	for (const folder of model.folders.values()) {
		if (folder.excluded) continue;
		const tag = model.getTagFromFolderPath(folder.path);
		if (!tag) continue;
		const key = toComparisonKey(tag, plugin.settings);
		if (!claimants.has(key)) claimants.set(key, []);
		claimants.get(key)!.push({ path: folder.path, depth: model.folderDepth(folder.path) });
	}

	const keepers = new Map<string, string | null>();
	for (const [key, folders] of claimants) {
		folders.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
		keepers.set(key, folders[0]?.path ?? null);
	}
	return keepers;
}

function planFolderTagNotes(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	resolved: ResolvedConflictMap
): void {
	const keepers = computeKeepers(plugin, model);

	for (const folder of [...model.folders.values()].sort(
		(a, b) => model.folderDepth(a.path) - model.folderDepth(b.path)
	)) {
		if (folder.excluded || resolved.excludedPaths.has(folder.path)) continue;

		const tagName = model.getTagFromFolderPath(folder.path);
		if (!tagName) continue;

		const key = toComparisonKey(tagName, plugin.settings);
		const keeperPath = keepers.get(key);
		const isKeeper = keeperPath === folder.path;

		const collisionParents = resolved.collisionParentsByFolderPath.get(folder.path) ?? [];
		const parentFolder = folder.parentPath ? model.getFolder(folder.parentPath) : undefined;
		const parentTag = parentFolder ? model.getTagFromFolderPath(parentFolder.path) : null;
		const safeParents = collectSafeParentTags(plugin, tagName, parentTag, collisionParents);

		const existingPath = model.getTagFile(tagName);
		const ownedHere = existingPath && model.getFile(existingPath)?.parentPath === folder.path;

		if (!ownedHere && (!existingPath || isKeeper)) {
			const displayName = plugin.tagIndex.toDisplayName(tagName);
			const assumedPath = `${folder.path}/${displayName}.md`;
			const matching = model.findNamedFileInFolder(folder.path, tagName)
				?? model.findNamedFileInFolder(folder.path, folder.name)
				?? model.findMatchingFileInFolder(folder.path, tagName)
				?? model.getFile(assumedPath);
			if (matching?.tagName && model.tagsMatch(matching.tagName, tagName)) {
				ensureFolderParents(plugin, model, plan, folder.path, tagName, matching.path, safeParents);
			} else {
				emitTagNote(
					plugin,
					model,
					plan,
					matching?.path ?? assumedPath,
					tagName,
					safeParents,
					`Tag note for folder ${folder.path}`
				);
			}
		} else if (ownedHere && existingPath) {
			ensureFolderParents(plugin, model, plan, folder.path, tagName, existingPath, safeParents);
		}
	}
}

/**
 * A tag note can already exist here before this phase runs — flatten creates one
 * for every nested tag level, and a top level like `#Media/Music` yields no parent
 * even when the Media folder itself sits inside another folder. Folder nesting
 * still determines the hierarchy, so fold those parents into whatever is there.
 */
function ensureFolderParents(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	folderPath: string,
	tagName: string,
	tagNotePath: string,
	safeParents: string[]
): void {
	if (safeParents.length === 0) return;

	const current = model.getParentTags(tagName);
	const missing = safeParents.filter(
		candidate =>
			!current.some(existing => model.tagsMatch(existing, candidate)) &&
			!isAncestorInModel(plugin, model, tagName, candidate)
	);
	if (missing.length === 0) return;

	const merged = filterSafeParentTags(plugin, tagName, [...current, ...missing]);
	addOp(plan, {
		kind: 'set-tag-parents',
		path: tagNotePath,
		tag: tagName,
		parents: merged,
		reason: `Folder parent for ${folderPath}`,
	});
	model.setTagParents(tagName, merged);
}

function planFolderTagsOnFiles(plugin: TaggableTagsPlugin, model: VaultModel, plan: MigrationPlan): void {
	for (const file of model.files.values()) {
		if (file.excluded || file.isTagRegistry || file.tagName) continue;
		if (!file.parentPath) continue;

		const folderTag = model.getTagFromFolderPath(file.parentPath);
		if (!folderTag) continue;

		const hasTag = file.tags.some(t => model.tagsMatch(t, folderTag))
			|| file.inlineTags.some(t => model.tagsMatch(t, folderTag));
		if (!hasTag) {
			addOp(plan, {
				kind: 'edit-file-tags',
				path: file.path,
				add: [folderTag],
				remove: [],
				rewrite: [],
				reason: `Add folder tag for ${file.parentPath}`,
			});
			model.editFileTags(file.path, [folderTag], [], []);
		}
	}
}

function planRedundantTagRemoval(plugin: TaggableTagsPlugin, model: VaultModel, plan: MigrationPlan): void {
	for (const file of model.files.values()) {
		if (file.excluded || file.isTagRegistry) continue;

		const tags = model.getAllTagsFromFile(file.path);
		const toRemove: string[] = [];

		const tagName = file.tagName;
		if (tagName) {
			// On a tag note the tags list *is* the parent list, so every entry looks
			// redundant to the ancestor check below. Only the self tag comes off —
			// flatten adds one whenever the note carried its own nested tag.
			if (tags.some(t => model.tagsMatch(t, tagName))) {
				toRemove.push(tagName);
			}
		} else if (tags.length >= 2) {
			for (const tag of tags) {
				for (const other of tags) {
					if (model.tagsMatch(tag, other)) continue;
					if (isAncestorInModel(plugin, model, tag, other)) {
						if (!toRemove.some(r => model.tagsMatch(r, tag))) {
							toRemove.push(tag);
						}
						break;
					}
				}
			}
		}

		if (toRemove.length > 0) {
			addOp(plan, {
				kind: 'edit-file-tags',
				path: file.path,
				add: [],
				remove: toRemove,
				rewrite: [],
				reason: 'Remove redundant tags',
			});
			model.editFileTags(file.path, [], toRemove, []);
		}
	}
}

function isAncestorInModel(plugin: TaggableTagsPlugin, model: VaultModel, ancestor: string, descendant: string): boolean {
	const visited = new Set<string>();
	const queue = [descendant];
	while (queue.length > 0) {
		const current = queue.pop()!;
		const key = toComparisonKey(current, plugin.settings);
		if (visited.has(key)) break;
		visited.add(key);
		for (const parent of model.getParentTags(current)) {
			if (model.tagsMatch(parent, ancestor)) return true;
			queue.push(parent);
		}
	}
	return false;
}

function planRemainingTagNotes(plugin: TaggableTagsPlugin, model: VaultModel, plan: MigrationPlan): void {
	for (const tag of model.getTagsWithoutFiles()) {
		if (tag.includes('/')) continue;
		const displayName = plugin.tagIndex.toDisplayName(tag);
		const path = `${displayName}.md`;
		if (model.getFile(path)) {
			const matching = model.findMatchingNonTagFile(tag, { parentPath: '', directChildOnly: true });
			if (matching) {
				addOp(plan, {
					kind: 'adopt-note-as-tag',
					path: matching.path,
					tag,
					parents: [],
					reason: 'Remaining tag without tag note',
				});
				model.setFileTagNote(matching.path, tag, []);
				continue;
			}
		}
		if (!model.getFile(path)) {
			addOp(plan, {
				kind: 'create-tag-note',
				path,
				tag,
				parents: [],
				reason: 'Remaining tag without tag note',
			});
			model.createTagNote(path, tag, []);
		}
	}
}

function planProducesFile(plan: MigrationPlan, path: string): boolean {
	for (const op of plan.ops) {
		if (op.kind === 'create-tag-note' && op.path === path) return true;
		if (op.kind === 'adopt-note-as-tag' && op.path === path) return true;
		if (op.kind === 'rename-file' && op.to === path) return true;
	}
	return false;
}

/**
 * Create or adopt a tag note at `path`. Never emits create if that path is already
 * a file in the model or will be after an earlier plan op (conflict matching-note rename).
 */
function emitTagNote(
	plugin: TaggableTagsPlugin,
	model: VaultModel,
	plan: MigrationPlan,
	path: string,
	tag: string,
	parents: string[],
	reason: string
): void {
	const existing = model.getFile(path);
	if (existing?.tagName && model.tagsMatch(existing.tagName, tag)) {
		return;
	}
	if (existing?.tagName) {
		return;
	}
	if (existing) {
		addOp(plan, { kind: 'adopt-note-as-tag', path, tag, parents, reason });
		model.setFileTagNote(path, tag, parents);
		return;
	}
	if (planProducesFile(plan, path)) {
		addOp(plan, { kind: 'adopt-note-as-tag', path, tag, parents, reason });
		model.createTagNote(path, tag, parents);
		return;
	}
	addOp(plan, { kind: 'create-tag-note', path, tag, parents, reason });
	model.createTagNote(path, tag, parents);
}

function tagNotePathForFolder(plugin: TaggableTagsPlugin, folderPath: string, tagName: string): string {
	const displayName = plugin.tagIndex.toDisplayName(tagName);
	return `${folderPath}/${displayName}.md`;
}

function findNestedLevelResolution(
	resolved: ResolvedConflictMap,
	tag: string,
	parent: string | null
): ConflictResolution | undefined {
	for (const resolution of resolved.bySourceId.values()) {
		const source = resolution.source;
		if (source.type !== 'nested-tag' || !source.nestedTagPath || source.nestedLevelIndex === undefined) {
			continue;
		}
		const parts = source.nestedTagPath.split('/').filter(Boolean);
		const levelTag = parts[source.nestedLevelIndex];
		const levelParent = source.nestedLevelIndex > 0 ? parts[source.nestedLevelIndex - 1] : null;
		if (levelTag !== tag) continue;
		if ((levelParent ?? null) !== (parent ?? null)) continue;
		return resolution;
	}
	return undefined;
}

function findKeeperForNestedResolution(
	resolved: ResolvedConflictMap,
	nestedResolution: ConflictResolution
): ConflictResolution | undefined {
	return resolved.keeperBySourceId.get(sourceId(nestedResolution.source));
}
