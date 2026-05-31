import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				// Electron/Node.js 运行时全局变量 / Electron/Node.js runtime globals
				Buffer: 'readonly',
				require: 'readonly',
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
