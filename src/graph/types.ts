import type { WorkspaceLeaf } from 'obsidian';

/** Theme-resolved graph color from renderer.colors.* */
export type GraphColor = {
	a: number;
	rgb: number;
};

export type GraphNode = {
	type: string;
	links: Record<string, boolean>;
	color?: GraphColor | null;
};

export type RendererData = {
	numLinks: number;
	nodes: Record<string, GraphNode>;
};

export type GraphRendererColors = {
	fillTag?: GraphColor;
	[key: string]: GraphColor | undefined;
};

export type GraphRenderer = {
	setData: (data: RendererData) => void;
	originalSetData?: (data: RendererData) => void;
	colors?: GraphRendererColors;
};

export type GraphFilterOptions = {
	showTags?: boolean;
	showOrphans?: boolean;
	/** Set on local graph: path of the centered file. */
	localFile?: string | null;
	[key: string]: unknown;
};

export type GraphEngine = {
	options?: GraphFilterOptions;
	render?: () => void;
};

export type GraphView = {
	renderer?: GraphRenderer;
	dataEngine?: GraphEngine;
	engine?: GraphEngine;
	unload: () => void;
	load: () => void;
	getViewType?: () => string;
};

export type GraphLeaf = WorkspaceLeaf & {
	view: GraphView;
};
