import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { LinkFormat } from './settings';
import type { FileDownloader } from './file-downloader';
import {
	escapePathForMarkdown,
	sanitizeFilename,
	buildStableFilename,
	resolveAttachmentFolder,
	calcRelativePath,
	ensureFolder,
	exceedsSizeLimit,
	extractNoteDir,
	resolveLinkFormat,
	extractExtFromUrl,
	guessFileExtension,
	isDownloadableFileUrl,
	DOWNLOADABLE_FILE_EXTENSIONS,
} from './path-utils';

// 匹配 Markdown 图片语法：![alt](https://...) / Match Markdown image syntax
const IMG_URL_REGEX = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
// 匹配 Markdown 普通链接语法：[text](https://...) / Match Markdown plain link syntax
const FILE_URL_REGEX = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;

// ─── 图片命名上下文 / Image naming context ───────────────────────────────────

/** 图片命名上下文，避免逐层传递多个参数 / Image naming context to avoid parameter sprawl */
export interface ImageNamingContext {
	/** 笔记标题（用于文件名前缀）/ Note title (for filename prefix) */
	titleBase?: string;

}

/** 创建默认图片命名上下文 / Create default image naming context */
export function createNamingContext(titleBase?: string): ImageNamingContext {
	return { titleBase };
}

// ─── 附件处理选项 / Attachment processing options ────────────────────────────

export interface AttachmentOptions {
	/** 图片链接格式 / Image link format */
	linkFormat: LinkFormat;
	/** 同步根目录（用于 subfolder/samename 模式）/ Sync root dir (for subfolder/samename modes) */
	syncFolder: string;
	/** 是否下载图片 / Whether to download images */
	downloadImages: boolean;
	/** 图片大小上限字节数（0 = 不限制）/ Image size limit in bytes (0 = no limit) */
	imageSizeLimitBytes: number;
	/** 是否下载文件 / Whether to download files */
	downloadFiles: boolean;
	/** 文件大小上限字节数（0 = 不限制）/ File size limit in bytes (0 = no limit) */
	fileSizeLimitBytes: number;
	/** 知识库名称（用于附件子目录）/ KB name (for attachment subdirectory) */
	kbName?: string;
	/** 知识库分类（个人知识库/共享知识库/订阅和公共知识库）/ KB category */
	kbCategory?: string;
	/** 防盗链图片下载增强（Node.js https 回退，仅桌面端）/ Anti-hotlink enhanced (Node.js https fallback, desktop only) */
	antiHotlinkEnhanced: boolean;
}

// ─── 图片处理器 / Image handler ──────────────────────────────────────────────

export class ImageHandler {
	constructor(
		private readonly vault: Vault,
		private readonly fileDownloader?: FileDownloader,
	) {}

	/**
	 * 根据模式解析附件文件夹的实际路径
	 * Resolve the actual attachment folder path based on mode
	 */
	resolveAttachmentFolder(noteFilePath: string, opts: AttachmentOptions): string {
		return resolveAttachmentFolder(opts);
	}

	/**
	 * 处理笔记内容：下载所有外链图片和文件附件，保存到附件文件夹，替换链接
	 * Process note content: download all external images and file attachments, save to attachment folder, replace links
	 */
	async processContent(content: string, noteFilePath: string, opts: AttachmentOptions, titleBase?: string): Promise<string> {
		if (!opts.downloadImages && !opts.downloadFiles) return content;

		// ── 第一遍：处理图片 / First pass: process images ──
		if (opts.downloadImages) {
			content = await this.processImages(content, noteFilePath, opts, titleBase);
		}

		// ── 第二遍：处理文件链接 / Second pass: process file links ──
		if (opts.downloadFiles && this.fileDownloader) {
			content = await this.processFileLinks(content, noteFilePath, opts, titleBase);
		}

		return content;
	}

	/**
	 * 处理外链图片：下载到附件文件夹，替换为本地链接
	 * Process external images: download to attachment folder, replace with local links
	 */
	private async processImages(content: string, noteFilePath: string, opts: AttachmentOptions, titleBase?: string): Promise<string> {
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
				if (opts.imageSizeLimitBytes > 0) {
					const exceeded = await exceedsSizeLimit(url, opts.imageSizeLimitBytes);
					if (exceeded) {
						console.debug(`ima.copilot Sync: 图片超过大小限制，保留原链接 / Image exceeds size limit, keeping link: ${url}`);
						continue;
					}
				}

				const filename = this.urlToFilename(url, naming);
				const destPath = normalizePath(`${attachmentFolder}/${filename}`);

				const exists = await this.vault.adapter.exists(destPath);
				if (!exists) {
					await this.downloadImage(url, destPath, opts.antiHotlinkEnhanced);
				}

				const link = this.formatLink(filename, destPath, noteFilePath, alt, opts.linkFormat);
				content = content.replace(full, link);
			} catch {
				console.warn(`ima.copilot Sync: 图片下载失败，跳过 / Image download failed, skipping: ${url}`);
			}
		}

		return content;
	}

	/**
	 * 处理外链文件附件：下载到附件文件夹，替换为本地链接
	 * Process external file links: download to attachment folder, replace with local links
	 */
	private async processFileLinks(content: string, noteFilePath: string, opts: AttachmentOptions, titleBase?: string): Promise<string> {
		const matches: Array<{ full: string; text: string; url: string }> = [];
		let match: RegExpExecArray | null;
		const regex = new RegExp(FILE_URL_REGEX.source, 'g');

		while ((match = regex.exec(content)) !== null) {
			matches.push({
				full: match[0] ?? '',
				text: match[1] ?? '',
				url: match[2] ?? '',
			});
		}

		if (matches.length === 0) return content;

		const naming = createNamingContext(titleBase);

		for (let i = 0; i < matches.length; i++) {
			const { full, text, url } = matches[i] ?? { full: '', text: '', url: '' };
			if (!url) continue;

			if (!isDownloadableFileUrl(url)) continue;

			try {
				const filename = this.deriveFileFilename(text, url, naming);
	
				const result = await this.fileDownloader!.downloadFile({
					url,
					filename,
					noteFilePath,
					opts,
					isImage: false,
					antiHotlinkEnhanced: opts.antiHotlinkEnhanced,
				});

				if (result.linkText) {
					content = content.replace(full, result.linkText);
				}
			} catch {
				console.warn(`ima.copilot Sync: 文件下载失败，跳过 / File download failed, skipping: ${url}`);
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
	 * 解析 Markdown 内容中所有本地文件附件的 vault 路径
	 * Parse all local file attachment vault paths from Markdown content
	 */
	extractLocalFilePaths(content: string, noteFilePath: string, opts: AttachmentOptions): string[] {
		const paths: string[] = [];
		const folder = this.resolveAttachmentFolder(noteFilePath, opts);

		// 解析 wikilink 格式：[[file.docx]]（非嵌入）/ Parse wikilink format: [[file.docx]] (non-embed)
		const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = wikilinkRegex.exec(content)) !== null) {
			const raw = (m[1] ?? '').trim();
			if (!raw) continue;
			const ext = raw.substring(raw.lastIndexOf('.')).toLowerCase();
			if (ext && DOWNLOADABLE_FILE_EXTENSIONS.has(ext)) {
				paths.push(normalizePath(`${folder}/${raw}`));
			}
		}

		// 解析 Markdown 格式本地链接：[text](path)，跳过外链
		// Parse Markdown format local links: [text](path), skip external links
		const noteDir = extractNoteDir(noteFilePath);
		const mdLocalRegex = /\[[^\]]*\]\((?!https?:\/\/)([^)\s]+)\)/g;
		while ((m = mdLocalRegex.exec(content)) !== null) {
			const encoded = (m[1] ?? '').trim();
			if (!encoded) continue;
			const decoded = encoded.split('/').map(seg => decodeURIComponent(seg)).join('/');
			const ext = decoded.substring(decoded.lastIndexOf('.')).toLowerCase();
			if (ext && DOWNLOADABLE_FILE_EXTENSIONS.has(ext)) {
				paths.push(normalizePath(noteDir ? `${noteDir}/${decoded}` : decoded));
			}
		}

		return paths;
	}

	/**
	 * 下载单张图片，保存到附件文件夹，返回格式化链接
	 * Download a single image, save to attachment folder, return formatted link
	 */
	async downloadAndLink(url: string, noteFilePath: string, opts: AttachmentOptions, naming?: ImageNamingContext): Promise<string> {
		if (!opts.downloadImages) return `![image](${url})`;

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath, opts);
		await ensureFolder(this.vault, attachmentFolder);

		const ctx = naming ?? createNamingContext();
		const filename = this.urlToFilename(url, ctx);
		const destPath = normalizePath(`${attachmentFolder}/${filename}`);

		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadImage(url, destPath, opts.antiHotlinkEnhanced);
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
		return `![${alt}](${escapePathForMarkdown(relPath)})`;
	}

	/** 调用 path-utils 的 buildStableFilename 生成稳定文件名 / Delegates to buildStableFilename */
	private urlToFilename(url: string, naming: ImageNamingContext): string {
		return buildStableFilename(url, { titleBase: naming.titleBase, fallbackName: 'img', fallbackExt: '.png' });
	}

	/**
	 * 从链接文本或 URL 推断文件附件文件名
	 * Derive filename for file attachment from link text or URL
	 */
	private deriveFileFilename(linkText: string, url: string, naming: ImageNamingContext): string {
		if (linkText && (extractExtFromUrl(`https://example.com/${linkText}`) || guessFileExtension(linkText))) {
			return sanitizeFilename(linkText);
		}
		return this.urlToFilename(url, naming);
	}

	/** 下载图片并写入 vault / Download image and write to vault */
	private async downloadImage(url: string, destPath: string, antiHotlinkEnhanced = false): Promise<void> {
		console.debug(`ima.copilot Sync: 开始下载图片 / Downloading image: ${url.substring(0, 100)}...`);

		// 先尝试 requestUrl / Try requestUrl first
		try {
			await this.downloadViaRequestUrl(url, destPath);
			return;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`ima.copilot Sync: requestUrl 图片下载失败 / requestUrl image download failed: ${msg}`);
		}

		// 防盗链增强回退：Node.js https.get（仅桌面端）
		// Anti-hotlink enhanced fallback: Node.js https.get (desktop only)
		if (!antiHotlinkEnhanced || !this.fileDownloader) {
			throw new Error('图片下载失败 / Image download failed');
		}

		const headers: Record<string, string> = {
			'User-Agent': navigator.userAgent,
			'Accept': '*/*',
		};

		try {
			await this.fileDownloader.downloadViaNodeHttps(url, destPath, headers);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`图片下载失败（Node.js 回退）/ Image download failed (Node.js fallback): ${msg}`);
		}
	}

	/** 通过 requestUrl 下载图片 / Download image via requestUrl */
	private async downloadViaRequestUrl(url: string, destPath: string): Promise<void> {
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: {
				'User-Agent': navigator.userAgent,
			},
			throw: false,
		});

		console.debug(`ima.copilot Sync: 图片下载响应 / Image download response: HTTP ${response.status} for ${destPath}`);

		if (response.status >= 400) {
			const bodySnippet = response.text?.substring(0, 500) ?? '';
			console.error(`ima.copilot Sync: 图片下载失败 / Image download failed: HTTP ${response.status}, body: ${bodySnippet}`);
			throw new Error(`HTTP ${response.status}`);
		}

		await this.vault.adapter.writeBinary(destPath, response.arrayBuffer);
		console.debug(`ima.copilot Sync: 图片已保存 / Image saved: ${destPath}`);
	}
}
