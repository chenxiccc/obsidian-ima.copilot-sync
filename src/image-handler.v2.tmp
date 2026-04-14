import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { AttachmentPathMode, LinkFormat } from './settings';

// 匹配 Markdown 图片语法：![alt](https://...) / Match Markdown image syntax
const IMG_URL_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// ─── 附件处理选项 / Attachment processing options ────────────────────────────

export interface AttachmentOptions {
	/** 附件路径模式 / Attachment path mode */
	pathMode: AttachmentPathMode;
	/** subfolder 模式下的子文件夹名 / Subfolder name for subfolder mode */
	subfolderName: string;
	/** 图片链接格式 / Image link format */
	linkFormat: LinkFormat;
	/** 同步根目录（用于 subfolder/samename 模式）/ Sync root dir (for subfolder/samename modes) */
	syncFolder: string;
}

// ─── 图片处理器 / Image handler ──────────────────────────────────────────────

export class ImageHandler {
	constructor(private readonly vault: Vault) {}

	/**
	 * 根据模式解析附件文件夹的实际路径
	 * Resolve the actual attachment folder path based on mode
	 *
	 * @param noteFilePath  笔记在 vault 中的路径（如 ima/note.md）/ Note path in vault
	 * @param opts          附件选项 / Attachment options
	 */
	resolveAttachmentFolder(noteFilePath: string, opts: AttachmentOptions): string {
		const noteDir = noteFilePath.includes('/')
			? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
			: '';
		const noteBasename = noteFilePath
			.replace(/^.*\//, '')   // 去掉目录部分 / Remove directory
			.replace(/\.md$/, '');  // 去掉扩展名 / Remove extension

		switch (opts.pathMode) {
			case 'subfolder':
				// ima目录下固定子文件夹，名称可自定义
				// Fixed subfolder under sync dir, name is customizable
				return normalizePath(`${opts.syncFolder}/${opts.subfolderName || 'attachments'}`);

			case 'obsidian': {
				// 跟随 Obsidian 全局附件路径设置 / Follow Obsidian global attachment path setting
				const setting: string =
					(this.vault as unknown as { getConfig(k: string): string }).getConfig('attachmentFolderPath')
					?? 'attachments';
				if (!setting || setting === '/') return normalizePath('/');
				if (setting.startsWith('./')) {
					// 相对路径：相对于笔记所在文件夹 / Relative to note's folder
					return normalizePath(`${noteDir}/${setting.slice(2)}`);
				}
				// 绝对路径：相对 vault 根 / Absolute from vault root
				return normalizePath(setting);
			}

			case 'samename':
				// ima目录下与笔记同名的文件夹 / Folder named after note under sync dir
				return normalizePath(`${opts.syncFolder}/${noteBasename}`);

			default:
				return normalizePath(`${opts.syncFolder}/attachments`);
		}
	}

	/**
	 * 处理笔记内容：下载所有外链图片，保存到附件文件夹，替换链接
	 * Process note content: download all external images, save to attachment folder, replace links
	 *
	 * @param content       笔记原始内容 / Raw note content
	 * @param noteFilePath  笔记在 vault 中的路径 / Note path in vault
	 * @param opts          附件选项 / Attachment options
	 */
	async processContent(content: string, noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		const matches: Array<{ full: string; alt: string; url: string }> = [];
		let match: RegExpExecArray | null;
		const regex = new RegExp(IMG_URL_REGEX.source, 'g');

		while ((match = regex.exec(content)) !== null) {
			matches.push({
				full: match[0] ?? '',
				alt: match[1] ?? '',
				url: match[2] ?? '',
			});
		}

		if (matches.length === 0) return content;

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath, opts);
		await this.ensureFolder(attachmentFolder);

		for (let i = 0; i < matches.length; i++) {
			const { full, alt, url } = matches[i] ?? { full: '', alt: '', url: '' };
			if (!url) continue;

			try {
				const filename = this.urlToFilename(url, i);
				const destPath = normalizePath(`${attachmentFolder}/${filename}`);

				// 已存在则跳过下载 / Skip download if file already exists
				const exists = await this.vault.adapter.exists(destPath);
				if (!exists) {
					await this.downloadImage(url, destPath);
				}

				const link = this.formatLink(filename, destPath, noteFilePath, alt, opts.linkFormat);
				content = content.replace(full, link);
			} catch {
				// 下载失败时保留原始链接，不中断整体同步
				// Keep original link on download failure, don't interrupt overall sync
				console.warn(`IMA Sync: 图片下载失败，跳过 / Image download failed, skipping: ${url}`);
			}
		}

		return content;
	}

	/**
	 * 下载单张图片，保存到附件文件夹，返回格式化链接
	 * Download a single image, save to attachment folder, return formatted link
	 */
	async downloadAndLink(url: string, noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath, opts);
		await this.ensureFolder(attachmentFolder);

		const filename = this.urlToFilename(url, 0);
		const destPath = normalizePath(`${attachmentFolder}/${filename}`);

		// 已存在则跳过下载 / Skip download if file already exists
		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadImage(url, destPath);
		}

		return this.formatLink(filename, destPath, noteFilePath, '', opts.linkFormat);
	}

	/**
	 * 生成图片引用链接（wiki 或标准 Markdown）
	 * Generate image reference link (wiki or standard Markdown)
	 */
	private formatLink(
		filename: string,
		destPath: string,
		noteFilePath: string,
		alt: string,
		format: LinkFormat,
	): string {
		// 解析 auto 格式 / Resolve auto format
		let resolved = format;
		if (format === 'auto') {
			const useMarkdown = (this.vault as unknown as { getConfig(k: string): boolean })
				.getConfig('useMarkdownLinks') ?? false;
			resolved = useMarkdown ? 'markdown' : 'wikilink';
		}

		if (resolved === 'wikilink') {
			// Obsidian wiki 格式，只用文件名，Obsidian 自动解析
			// Obsidian wiki format, filename only, Obsidian resolves automatically
			return alt ? `![[${filename}|${alt}]]` : `![[${filename}]]`;
		}

		// 标准 Markdown 格式，计算相对路径 / Standard Markdown, calculate relative path
		const noteDir = noteFilePath.includes('/')
			? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
			: '';
		const relPath = this.calcRelativePath(noteDir, destPath);
		// 路径中空格等特殊字符需要编码 / Encode special characters in path segments
		const encoded = relPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
		return `![${alt}](${encoded})`;
	}

	/**
	 * 计算从 fromDir 到 toPath 的相对路径
	 * Calculate relative path from fromDir to toPath
	 */
	private calcRelativePath(fromDir: string, toPath: string): string {
		const fromParts = fromDir ? fromDir.split('/') : [];
		const toParts = toPath.split('/');

		let common = 0;
		while (
			common < fromParts.length &&
			common < toParts.length &&
			fromParts[common] === toParts[common]
		) {
			common++;
		}

		const ups = Array(fromParts.length - common).fill('..');
		const downs = toParts.slice(common);
		return [...ups, ...downs].join('/') || '.';
	}

	/** 从 URL 生成合法文件名 / Generate valid filename from URL */
	private urlToFilename(url: string, index: number): string {
		try {
			const urlObj = new URL(url);
			const lastSegment = urlObj.pathname.split('/').pop() ?? '';
			const cleanSegment = lastSegment.split('?')[0] ?? '';

			if (cleanSegment && cleanSegment.includes('.')) {
				return this.sanitizeFilename(cleanSegment);
			}

			const ext = this.guessExtFromUrl(url);
			return `img_${this.hashUrl(url)}${ext}`;
		} catch {
			return `img_${index}.png`;
		}
	}

	/** 从 URL 猜测图片扩展名 / Guess image extension from URL */
	private guessExtFromUrl(url: string): string {
		const lower = url.toLowerCase();
		if (lower.includes('.jpg') || lower.includes('.jpeg')) return '.jpg';
		if (lower.includes('.png')) return '.png';
		if (lower.includes('.gif')) return '.gif';
		if (lower.includes('.webp')) return '.webp';
		return '.png';
	}

	/** 简单哈希函数用于生成唯一文件名 / Simple hash for unique filename */
	private hashUrl(url: string): string {
		let hash = 0;
		for (let i = 0; i < url.length; i++) {
			const char = url.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // 转为 32 位整数 / Convert to 32bit int
		}
		return Math.abs(hash).toString(16);
	}

	/** 清理文件名中的非法字符 / Sanitize illegal characters in filename */
	private sanitizeFilename(name: string): string {
		return name.replace(/[/\\:*?"<>|]/g, '_').trim();
	}

	/** 下载图片并写入 vault / Download image and write to vault */
	private async downloadImage(url: string, destPath: string): Promise<void> {
		console.log(`IMA Sync: 开始下载图片 / Downloading image: ${url.substring(0, 100)}...`);
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: {
				// 伪造浏览器 User-Agent 以规避部分 CDN 限制
				// Fake browser User-Agent to bypass some CDN restrictions
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
			},
			throw: false,
		});

		console.log(`IMA Sync: 图片下载响应 / Image download response: HTTP ${response.status} for ${destPath}`);

		if (response.status >= 400) {
			// 记录响应头和正文（最多 500 字符）以辅助诊断
			// Log response headers and body (up to 500 chars) to help diagnose
			const bodySnippet = response.text?.substring(0, 500) ?? '';
			console.error(`IMA Sync: 图片下载失败 / Image download failed: HTTP ${response.status}, body: ${bodySnippet}`);
			throw new Error(`HTTP ${response.status}`);
		}

		// 写入二进制文件 / Write binary file
		await this.vault.adapter.writeBinary(destPath, response.arrayBuffer);
		console.log(`IMA Sync: 图片已保存 / Image saved: ${destPath}`);
	}

	/** 确保文件夹存在（逐级创建）/ Ensure folder exists (create recursively) */
	private async ensureFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		const exists = await this.vault.adapter.exists(normalized);
		if (!exists) {
			await this.vault.createFolder(normalized);
		}
	}
}
