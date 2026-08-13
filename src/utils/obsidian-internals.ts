import { Menu, MenuItem, TFile, WorkspaceLeaf } from 'obsidian';
import type { App } from 'obsidian';

export interface MenuItemWithSubmenu extends MenuItem {
	setSubmenu(): Menu;
}

export function asSubmenuItem(item: MenuItem): MenuItemWithSubmenu {
	return item as MenuItemWithSubmenu;
}

interface CommandsApi {
	executeCommandById(id: string): boolean;
}

export function executeCommandById(app: App, id: string): boolean {
	const commands = (app as App & { commands?: CommandsApi }).commands;
	return commands?.executeCommandById(id) ?? false;
}

interface GlobalSearchInstance {
	openGlobalSearch(query: string): void;
}

export function openGlobalSearch(app: App, query: string): void {
	const internalPlugins = (app as App & {
		internalPlugins?: {
			getPluginById: (id: string) => { instance?: GlobalSearchInstance } | undefined;
		};
	}).internalPlugins;
	internalPlugins?.getPluginById('global-search')?.instance?.openGlobalSearch(query);
}

export async function rebuildLeafView(leaf: WorkspaceLeaf): Promise<boolean> {
	const withRebuild = leaf as WorkspaceLeaf & { rebuildView?: () => Promise<void> | void };
	if (typeof withRebuild.rebuildView === 'function') {
		await withRebuild.rebuildView();
		return true;
	}
	return false;
}

interface ViewWithFile {
	file?: TFile;
	contentEl?: HTMLElement;
}

export function getViewFile(view: unknown): TFile | undefined {
	if (!view || typeof view !== 'object') {
		return undefined;
	}
	const file = (view as ViewWithFile).file;
	return file instanceof TFile ? file : undefined;
}

export function getViewContentEl(view: unknown): HTMLElement | undefined {
	if (!view || typeof view !== 'object') {
		return undefined;
	}
	return (view as ViewWithFile).contentEl;
}

interface MenuItemInternal {
	titleEl?: HTMLElement;
	title?: string;
}

export function getMenuItems(menu: Menu): MenuItemInternal[] | undefined {
	const raw = (menu as Menu & { items?: unknown }).items;
	if (!Array.isArray(raw)) {
		return undefined;
	}
	return raw as MenuItemInternal[];
}

export function queryHtmlElement(root: ParentNode, selector: string): HTMLElement | null {
	const el = root.querySelector(selector);
	return el instanceof HTMLElement ? el : null;
}
