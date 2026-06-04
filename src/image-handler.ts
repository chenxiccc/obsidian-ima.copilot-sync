import { Vault, normalizePath } from 'obsidian';
import type { FileDownloader } from './file-downloader';
import type { AttachmentOptions, ImageNamingContext, LinkFormat } from './path-utils';
import {
	createNamingContext,
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
	resolveAttachmentFolder(noteFilePath: string): string {
		return resolveAttachmentFolder(noteFilePath);
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

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath);
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

		const folder = this.resolveAttachmentFolder(noteFilePath);
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
		const folder = this.resolveAttachmentFolder(noteFilePath);

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

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath);
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

	/** 下载图片并写入 vault — 委托 FileDownloader 统一处理防盗链 / Download image and write to vault — delegate to FileDownloader for unified anti-hotlink */
	private async downloadImage(url: string, destPath: string, antiHotlinkEnhanced = false): Promise<void> {
		// 委托 FileDownloader 统一处理（requestUrl → Node.js https 兜底），避免重复防盗链逻辑
		// Delegate to FileDownloader for unified handling (requestUrl → Node.js https fallback), avoid duplicating anti-hotlink logic
		await this.fileDownloader!.downloadWithAntiHotlink(url, destPath, /* headers */ undefined, antiHotlinkEnhanced);
	}
}
