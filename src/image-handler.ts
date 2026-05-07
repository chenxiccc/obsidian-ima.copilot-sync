import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { LinkFormat } from './settings';
import {
	CHROME_UA,
	sanitizeFilename,
	sanitizeTitle,
	resolveAttachmentFolder,
	calcRelativePath,
	ensureFolder,
	exceedsSizeLimit,
	extractNoteDir,
	resolveLinkFormat,
	extractExtFromUrl,
	guessFileExtension,
} from './path-utils';

// 匹配 Markdown 图片语法：![alt](https://...) / Match Markdown image syntax
const IMG_URL_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// ─── 图片命名上下文 / Image naming context ───────────────────────────────────

/** 图片命名上下文，避免逐层传递多个参数 / Image naming context to avoid parameter sprawl */
export interface ImageNamingContext {
	/** 笔记标题（用于文件名前缀）/ Note title (for filename prefix) */
	titleBase?: string;
	/** 自增索引（可变引用）/ Auto-increment index (mutable reference) */
	imgIndex: { value: number };
	/** 时间戳 / Timestamp */
	timestamp: number;
}

/** 创建默认图片命名上下文 / Create default image naming context */
export function createNamingContext(titleBase?: string): ImageNamingContext {
	return { titleBase, imgIndex: { value: 1 }, timestamp: Date.now() };
}

// ─── 附件处理选项 / Attachment processing options ────────────────────────────

export interface AttachmentOptions {
	/** 图片链接格式 / Image link format */
	linkFormat: LinkFormat;
	/** 同步根目录（用于 subfolder/samename 模式）/ Sync root dir (for subfolder/samename modes) */
	syncFolder: string;
	/** 是否下载附件 / Whether to download attachments */
	downloadAttachments: boolean;
	/** 附件大小上限字节数（0 = 不限制）/ Attachment size limit in bytes (0 = no limit) */
	attachmentSizeLimitBytes: number;
	/** 知识库名称（用于附件子目录）/ KB name (for attachment subdirectory) */
	kbName?: string;
	/** 知识库分类（个人知识库/共享知识库/订阅和公共知识库）/ KB category */
	kbCategory?: string;
}

// ─── 图片处理器 / Image handler ──────────────────────────────────────────────

export class ImageHandler {
	constructor(private readonly vault: Vault) {}

	/**
	 * 根据模式解析附件文件夹的实际路径
	 * Resolve the actual attachment folder path based on mode
	 */
	resolveAttachmentFolder(noteFilePath: string, opts: AttachmentOptions): string {
		return resolveAttachmentFolder(opts);
	}

	/**
	 * 处理笔记内容：下载所有外链图片，保存到附件文件夹，替换链接
	 * Process note content: download all external images, save to attachment folder, replace links
	 */
	async processContent(content: string, noteFilePath: string, opts: AttachmentOptions, titleBase?: string): Promise<string> {
		if (!opts.downloadAttachments) return content;

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
		await ensureFolder(this.vault, attachmentFolder);

			const naming = createNamingContext(titleBase);

		for (let i = 0; i < matches.length; i++) {
			const { full, alt, url } = matches[i] ?? { full: '', alt: '', url: '' };
			if (!url) continue;

			try {
				if (opts.attachmentSizeLimitBytes > 0) {
					const exceeded = await exceedsSizeLimit(url, opts.attachmentSizeLimitBytes);
					if (exceeded) {
						console.debug(`IMA Sync: 图片超过大小限制，保留原链接 / Image exceeds size limit, keeping link: ${url}`);
						continue;
					}
				}

				const filename = this.urlToFilename(url, naming);
				naming.imgIndex.value++;
				const destPath = normalizePath(`${attachmentFolder}/${filename}`);

				const exists = await this.vault.adapter.exists(destPath);
				if (!exists) {
					await this.downloadImage(url, destPath);
				}

				const link = this.formatLink(filename, destPath, noteFilePath, alt, opts.linkFormat);
				content = content.replace(full, link);
			} catch {
				console.warn(`IMA Sync: 图片下载失败，跳过 / Image download failed, skipping: ${url}`);
			}
		}

		return content;
	}

	/**
	 * 解析 Markdown 内容中所有本地图片的 vault 路径
	 * Parse all local image vault paths from Markdown content
	 */
	extractLocalImagePaths(content: string, noteFilePath: string, opts: AttachmentOptions): string[] {
		const paths: string[] = [];

		const folder = this.resolveAttachmentFolder(noteFilePath, opts);
		const wikilinkRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = wikilinkRegex.exec(content)) !== null) {
			const raw = (m[1] ?? '').trim();
			if (!raw) continue;
			paths.push(normalizePath(`${folder}/${raw}`));
		}

		// 解析 Markdown 格式本地图片：![alt](path)，跳过外链
		// Parse Markdown format local images: ![alt](path), skip external links
		const noteDir = extractNoteDir(noteFilePath);
		const mdLocalRegex = /!\[[^\]]*\]\((?!https?:\/\/)([^)\s]+)\)/g;
		while ((m = mdLocalRegex.exec(content)) !== null) {
			const encoded = (m[1] ?? '').trim();
			if (!encoded) continue;
			const decoded = encoded.split('/').map(seg => decodeURIComponent(seg)).join('/');
			paths.push(normalizePath(noteDir ? `${noteDir}/${decoded}` : decoded));
		}

		return paths;
	}

	/**
	 * 下载单张图片，保存到附件文件夹，返回格式化链接
	 * Download a single image, save to attachment folder, return formatted link
	 */
	async downloadAndLink(url: string, noteFilePath: string, opts: AttachmentOptions, naming?: ImageNamingContext): Promise<string> {
		if (!opts.downloadAttachments) return `![image](${url})`;

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath, opts);
		await ensureFolder(this.vault, attachmentFolder);

		const ctx = naming ?? createNamingContext();
		const filename = this.urlToFilename(url, ctx);
		ctx.imgIndex.value++;
		const destPath = normalizePath(`${attachmentFolder}/${filename}`);

		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadImage(url, destPath);
		}

		return this.formatLink(filename, destPath, noteFilePath, '', opts.linkFormat);
	}

	/** 生成图片引用链接（wiki 或标准 Markdown）/ Generate image reference link */
	private formatLink(
		filename: string,
		destPath: string,
		noteFilePath: string,
		alt: string,
		format: LinkFormat,
	): string {
		const resolved = resolveLinkFormat(this.vault, format);

		if (resolved === 'wikilink') {
			return alt ? `![[${filename}|${alt}]]` : `![[${filename}]]`;
		}

		const noteDir = extractNoteDir(noteFilePath);
		const relPath = calcRelativePath(noteDir, destPath);
		const encoded = relPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
		return `![${alt}](${encoded})`;
	}

	/** 从 URL 生成合法文件名：titleBase-timestamp-N.ext / Generate valid filename from URL: titleBase-timestamp-N.ext */
	private urlToFilename(url: string, naming: ImageNamingContext): string {
		const ext = extractExtFromUrl(url) || guessFileExtension(url) || '.png';
		const safeTitle = sanitizeTitle(naming.titleBase, 'img');
		return `${safeTitle}-${naming.timestamp}-${naming.imgIndex.value}${ext}`;
	}

	/** 下载图片并写入 vault / Download image and write to vault */
	private async downloadImage(url: string, destPath: string): Promise<void> {
		console.debug(`IMA Sync: 开始下载图片 / Downloading image: ${url.substring(0, 100)}...`);
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: {
				// 伪造浏览器 User-Agent 以规避部分 CDN 限制
				// Fake browser User-Agent to bypass some CDN restrictions
				'User-Agent': CHROME_UA,
			},
			throw: false,
		});

		console.debug(`IMA Sync: 图片下载响应 / Image download response: HTTP ${response.status} for ${destPath}`);

		if (response.status >= 400) {
			const bodySnippet = response.text?.substring(0, 500) ?? '';
			console.error(`IMA Sync: 图片下载失败 / Image download failed: HTTP ${response.status}, body: ${bodySnippet}`);
			throw new Error(`HTTP ${response.status}`);
		}

		await this.vault.adapter.writeBinary(destPath, response.arrayBuffer);
		console.debug(`IMA Sync: 图片已保存 / Image saved: ${destPath}`);
	}
}
