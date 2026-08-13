export type PlanOp =
	| { kind: 'rename-folder'; from: string; to: string; reason: string }
	| { kind: 'rename-file'; from: string; to: string; reason: string }
	| { kind: 'delete-folder'; path: string; reason: string }
	| { kind: 'delete-file'; path: string; reason: string }
	| { kind: 'create-tag-note'; path: string; tag: string; parents: string[]; reason: string }
	| { kind: 'adopt-note-as-tag'; path: string; tag: string; parents: string[]; reason: string }
	| { kind: 'set-tag-parents'; path: string; tag: string; parents: string[]; reason: string }
	| {
			kind: 'edit-file-tags';
			path: string;
			add: string[];
			remove: string[];
			rewrite: Array<{ from: string; to: string }>;
			reason: string;
	  }
	| { kind: 'merge-tags'; survivor: string; removed: string; reason: string };

export interface MigrationPlan {
	ops: PlanOp[];
	emptyFolders: string[];
}

export function createEmptyPlan(): MigrationPlan {
	return { ops: [], emptyFolders: [] };
}

export function addOp(plan: MigrationPlan, op: PlanOp): void {
	plan.ops.push(op);
}

export function countOps(plan: MigrationPlan): number {
	return plan.ops.length;
}

export function groupOpsByKind(plan: MigrationPlan): Map<PlanOp['kind'], PlanOp[]> {
	const groups = new Map<PlanOp['kind'], PlanOp[]>();
	for (const op of plan.ops) {
		if (!groups.has(op.kind)) {
			groups.set(op.kind, []);
		}
		groups.get(op.kind)!.push(op);
	}
	return groups;
}

export function planSummary(plan: MigrationPlan): { total: number; byKind: Record<string, number> } {
	const byKind: Record<string, number> = {};
	for (const op of plan.ops) {
		byKind[op.kind] = (byKind[op.kind] ?? 0) + 1;
	}
	return { total: plan.ops.length, byKind };
}

const KIND_LABELS: Record<PlanOp['kind'], string> = {
	'rename-folder': 'Folder renames',
	'rename-file': 'File renames',
	'delete-folder': 'Folders to delete',
	'delete-file': 'Files to delete',
	'create-tag-note': 'Tag notes to create',
	'adopt-note-as-tag': 'Notes to adopt as tag notes',
	'set-tag-parents': 'Tag parent updates',
	'edit-file-tags': 'Tag edits in files',
	'merge-tags': 'Tag merges',
};

export function kindLabel(kind: PlanOp['kind']): string {
	return KIND_LABELS[kind] ?? kind;
}

export function describeOp(op: PlanOp): { primary: string; secondary: string } {
	switch (op.kind) {
		case 'rename-folder':
			return { primary: op.from, secondary: `→ ${op.to}` };
		case 'rename-file':
			return { primary: op.from, secondary: `→ ${op.to}` };
		case 'delete-folder':
			return { primary: op.path, secondary: 'delete folder' };
		case 'delete-file':
			return { primary: op.path, secondary: 'delete file' };
		case 'create-tag-note':
			return {
				primary: `#${op.tag}`,
				secondary: `create at ${op.path}${op.parents.length ? ` (parents: ${op.parents.map(p => '#' + p).join(', ')})` : ''}`,
			};
		case 'adopt-note-as-tag':
			return {
				primary: `#${op.tag}`,
				secondary: `adopt ${op.path}${op.parents.length ? ` (parents: ${op.parents.map(p => '#' + p).join(', ')})` : ''}`,
			};
		case 'set-tag-parents':
			return {
				primary: op.path,
				secondary: `#${op.tag} parents → ${op.parents.map(p => '#' + p).join(', ') || '(none)'}`,
			};
		case 'edit-file-tags': {
			const parts: string[] = [];
			if (op.rewrite.length) {
				parts.push(op.rewrite.map(r => `#${r.from} → #${r.to}`).join(', '));
			}
			if (op.add.length) parts.push(`+ ${op.add.map(t => '#' + t).join(', ')}`);
			if (op.remove.length) parts.push(`- ${op.remove.map(t => '#' + t).join(', ')}`);
			return { primary: op.path, secondary: parts.join('; ') || op.reason };
		}
		case 'merge-tags':
			return { primary: `#${op.removed}`, secondary: `merge into #${op.survivor}` };
	}
}

export function serializePlanToNote(plan: MigrationPlan): string {
	const lines: string[] = ['# Migration plan', '', `Generated: ${new Date().toLocaleString()}`, ''];
	const groups = groupOpsByKind(plan);

	for (const [kind, ops] of groups) {
		lines.push(`## ${kindLabel(kind)} (${ops.length})`, '');
		for (const op of ops) {
			const { primary, secondary } = describeOp(op);
			lines.push(`- **${primary}**: ${secondary}`);
		}
		lines.push('');
	}

	if (plan.emptyFolders.length > 0) {
		lines.push(`## Empty folders (${plan.emptyFolders.length})`, '');
		for (const path of plan.emptyFolders) {
			lines.push(`- ${path}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}
