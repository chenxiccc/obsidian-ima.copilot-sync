// @joplin/turndown-plugin-gfm 无自带类型声明, 此处声明模块 / No bundled types for @joplin/turndown-plugin-gfm, declare module here
// 照搬自 Share to Save: src/gfm-plugin.d.ts / Ported from Share to Save: src/gfm-plugin.d.ts
declare module '@joplin/turndown-plugin-gfm' {
	import type TurndownService from 'turndown';
	export function gfm(service: TurndownService): void;
	export function tables(service: TurndownService): void;
	export function strikethrough(service: TurndownService): void;
	export function taskListItems(service: TurndownService): void;
	export function highlightedCodeBlock(service: TurndownService): void;
}
