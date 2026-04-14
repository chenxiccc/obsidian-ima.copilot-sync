import { requestUrl, Vault, normalizePath } from 'obsidian';

// 匹配 Markdown 图片语法：![alt](https://...) / Match Markdown image syntax
const IMG_URL_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// ─── 图片处理器 / Image handler ──────────────────────────────────────────────

export class ImageHandler {
	constructor(private readonly vault: Vault) {}

	/**
	 * 处理笔记内容：下载所有外链图片，保存到 attachments 文件夹，替换链接为 Obsidian wiki 格式
	 * Process note content: download all external images, save to attachments folder,
	 * replace links with Obsidian wiki format
	 *
	 * @param content           笔记原始内容 / Raw note content
	 * @param attachmentFolder  附件文件夹路径（相对 vault 根）/ Attachment folder path (relative to vault root)
	 * @returns 替换后的内容 / Processed content
	 */
	async processContent(content: string, attachmentFolder: string): Promise<string> {
		// 收集所有图片 URL / Collect all image URLs
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

		// 确保附件文件夹存在 / Ensure attachment folder exists
		await this.ensureFolder(attachmentFolder);

		// 逐个下载并替换 / Download and replace one by one
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

				// 替换为 Obsidian wiki 格式，只用文件名（Obsidian 自动解析）
				// Replace with Obsidian wiki format, filename only (Obsidian resolves automatically)
				const wikiLink = alt ? `![[${filename}|${alt}]]` : `![[${filename}]]`;
				content = content.replace(full, wikiLink);
			} catch {
				// 下载失败时保留原始链接，不中断整体同步
				// Keep original link on download failure, don't interrupt overall sync
				console.warn(`IMA Sync: 图片下载失败，跳过 / Image download failed, skipping: ${url}`);
			}
		}

		return content;
	}

	/**
	 * 下载单张图片并返回 Obsidian wiki 链接
	 * 若本地文件已存在则直接复用，不重复下载
	 * Download a single image and return Obsidian wiki link.
	 * Reuses existing local file if already downloaded.
	 */
	async downloadAndLink(url: string, attachmentFolder: string): Promise<string> {
		await this.ensureFolder(attachmentFolder);
		const filename = this.urlToFilename(url, 0);
		const destPath = normalizePath(`${attachmentFolder}/${filename}`);

		// 已存在则跳过下载 / Skip download if file already exists
		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadImage(url, destPath);
		}

		return `![[${filename}]]`;
	}

	/** 从 URL 生成合法文件名 / Generate valid filename from URL */
	private urlToFilename(url: string, index: number): string {
		try {
			const urlObj = new URL(url);
			// 取 pathname 最后一段 / Get last segment of pathname
			const pathname = urlObj.pathname;
			const lastSegment = pathname.split('/').pop() ?? '';
			// 去掉查询参数可能混入的内容 / Remove any query params mixed in
			const cleanSegment = lastSegment.split('?')[0] ?? '';

			if (cleanSegment && cleanSegment.includes('.')) {
				return this.sanitizeFilename(cleanSegment);
			}

			// 无法从 URL 提取时用哈希命名 / Use hash when can't extract from URL
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
