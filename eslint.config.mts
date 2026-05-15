import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// 关闭 sentence case 规则——插件 UI 含大量专有名词（API/ID/ima）和中文，不适用英文 sentence case
			// Disable sentence case — plugin UI has proper nouns (API/ID/ima) and Chinese text
			"obsidianmd/ui/sentence-case": "off",
			// 桌面端 Electron 环境下需通过 require('https') 进行反盗链图片下载回退，移动端不会触发此路径
			// Node.js https fallback for anti-hotlink image download in desktop Electron; never triggered on mobile
			"import/no-nodejs-modules": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
