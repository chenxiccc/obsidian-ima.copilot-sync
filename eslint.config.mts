import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Node.js 运行时全局变量（Buffer/require 等），类型由 @types/node 提供
				// Node.js runtime globals (Buffer/require etc.), typed by @types/node
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'eslint.config.js',
						'manifest.json',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
		rules: {
			// file-downloader.ts 防盜鏈兜底需要 Node.js https 模塊 / Anti-hotlink fallback requires Node.js https module
			'import/no-nodejs-modules': ['error', { allow: ['https', 'http'] }],
		},
	},
	...obsidianmd.configs.recommended,
	// ima.copilot 是品牌名（IMA 缩写），保留原大小写不套 sentence-case 的首字母大写规范；
	// 用 ignoreRegex 整串豁免含 ima.copilot 的文案（大小写无关）
	// ima.copilot is a brand name (IMA acronym); keep its casing instead of sentence-case's
	// title-case rule; use ignoreRegex to exempt strings containing ima.copilot (case-insensitive)
	{
		files: ['**/*.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': [
				'warn',
				{ enforceCamelCaseLower: true, ignoreRegex: ['[Ii][Mm][Aa]\\.copilot'] },
			],
		},
	},
	// settings.ts 含大量品牌名与技术术语（IMA / API Key / Client ID / HTTPS 等），
	// 不适用 sentence-case 的自然语言大小写规范，按文件关闭（参考 Share-to-Save 项目做法）
	// settings.ts contains brand names and technical terms (IMA / API Key / Client ID / HTTPS etc.)
	// that don't fit sentence-case's natural-language casing; disable per-file (cf. Share-to-Save)
	{
		files: ['src/settings.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'eslint.config.js',
		'version-bump.mjs',
		'versions.json',
		'main.js',
	]),
);
