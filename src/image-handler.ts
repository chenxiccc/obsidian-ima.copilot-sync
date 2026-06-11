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
	 * 处理外链图片：两阶段下载（并发下载到内存 → 顺序保存去重）
	 * Process external images: two-phase download (concurrent to memory → sequential save with dedup)
	 *
	 * 参考 Share to Save image-handler.ts:264-341 的 processMatches 两阶段模式
	 * Based on Share to Save image-handler.ts:264-341 two-phase processMatches pattern
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

		// Phase 1: 并发下载到内存（最多 3 并发，单个失败不阻塞其他）
		// Phase 1: concurrent download to memory (max 3 concurrent, single failure doesn't block others)
		type DownloadResult = { full: string; alt: string; url: string; buffer: ArrayBuffer; contentType: string } | { full: string; alt: string; url: string; buffer: null };
		const downloadResults = await this.withConcurrencyLimit(matches, 3, async (m) => {
			try {
				// 大小限制检查在下载前 / Size limit check before download
				if (opts.imageSizeLimitBytes > 0) {
					const exceeded = await exceedsSizeLimit(m.url, opts.imageSizeLimitBytes);
					if (exceeded) {
						console.debug(`ima.copilot Sync: 图片超过大小限制，保留原链接 / Image exceeds size limit, keeping link: ${m.url}`);
						return { full: m.full, alt: m.alt, url: m.url, buffer: null };
					}
				}

				if (!this.fileDownloader) {
					throw new Error('FileDownloader 不可用 / FileDownloader unavailable');
				}
				const { buffer, contentType } = await this.fileDownloader.downloadToBuffer(
					m.url, /* extraHeaders */ undefined, opts.antiHotlinkEnhanced,
				);
				return { full: m.full, alt: m.alt, url: m.url, buffer, contentType };
			} catch (err) {
				console.warn(`ima.copilot Sync: 图片下载失败 / Image download failed: ${m.url}`, err);
				return { full: m.full, alt: m.alt, url: m.url, buffer: null };
			}
		}) as DownloadResult[];

		// Phase 2: 顺序应用（确定文件名 → 去重 → 保存 → 替换，必须顺序执行保证 dedup 正确）
		// Phase 2: sequential apply (determine filename → dedup → save → replace, must be sequential)
		const dedupMap = new Map<string, string>(); // contentHash → wikilink

		for (const result of downloadResults) {
			if (!result.buffer) continue;
			const { full, alt, url, buffer, contentType } = result;

			// 2a. 按 contentType 确定文件名（Content-Type 可能修正 URL 扩展名误判）
			// Determine filename with contentType (Content-Type may correct URL extension misdetection)
			const filename = this.urlToFilename(url, naming, contentType);
			const destPath = normalizePath(`${attachmentFolder}/${sanitizeFilename(filename)}`);

			// 2b. 内容哈希去重：同批次相同内容复用第一个 wikilink
			// Content hash dedup: same content within batch reuses first wikilink
			const contentHash = this.computeContentHash(buffer);
			const existingWikilink = dedupMap.get(contentHash);
			if (existingWikilink) {
				content = content.replace(full, existingWikilink);
				continue;
			}
			const wikilink = this.formatLink(filename, destPath, noteFilePath, alt, opts.linkFormat);
			dedupMap.set(contentHash, wikilink);

			// 2c. 已存在且内容相同则跳过文件写入 / Skip file write if exists with same content
			if (await this.existsWithSameContent(destPath, buffer)) {
				content = content.replace(full, wikilink);
				continue;
			}

			// 2d. 保存二进制文件并替换链接 / Save binary file and replace link
			await this.vault.adapter.writeBinary(destPath, buffer);
			content = content.replace(full, wikilink);
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
		if (!opts.downloadImages || !this.fileDownloader) return `![image](${url})`;

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath);
		await ensureFolder(this.vault, attachmentFolder);

		const ctx = naming ?? createNamingContext();

		// 下载到内存获取 Content-Type，用于修正扩展名
		// Download to memory to get Content-Type for extension correction
		try {
			const { buffer, contentType } = await this.fileDownloader.downloadToBuffer(
				url, /* extraHeaders */ undefined, opts.antiHotlinkEnhanced,
			);
			const filename = this.urlToFilename(url, ctx, contentType);
			const destPath = normalizePath(`${attachmentFolder}/${sanitizeFilename(filename)}`);

			// 去重检查 / Dedup check
			if (!await this.existsWithSameContent(destPath, buffer)) {
				await this.vault.adapter.writeBinary(destPath, buffer);
			}

			return this.formatLink(filename, destPath, noteFilePath, '', opts.linkFormat);
		} catch {
			console.warn(`ima.copilot Sync: 图片下载失败 / Image download failed: ${url}`);
			return `![image](${url})`;
		}
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
	private urlToFilename(url: string, naming: ImageNamingContext, contentType?: string): string {
		return buildStableFilename(url, { titleBase: naming.titleBase, fallbackName: 'img', fallbackExt: '.png', contentType });
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

	// ─── 并发控制 / Concurrency Control ─────────────────────────────────────────

	/**
	 * 并发控制工具：最多 limit 个并发执行异步任务，单个失败不影响其他
	 * Concurrency limiter: execute async tasks with max `limit` concurrency; single failure doesn't abort others
	 *
	 * 参考 Share to Save image-handler.ts:237-259
	 */
	private async withConcurrencyLimit<T, R>(
		items: T[],
		limit: number,
		fn: (item: T) => Promise<R>,
	): Promise<(R | null)[]> {
		const results = new Array<R | null>(items.length);
		let index = 0;

		const worker = async (): Promise<void> => {
			while (index < items.length) {
				const i = index++;
				try {
					results[i] = await fn(items[i]!);
				} catch {
					results[i] = null;
				}
			}
		};

		const workerCount = Math.min(limit, items.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	// ─── 内容哈希去重 / Content Hash Dedup ─────────────────────────────────────

	/**
	 * 计算二进制内容的快速哈希（用于批处理内去重）
	 * Compute fast hash of binary content (for batch dedup)
	 *
	 * 使用 buffer 长度 + 首尾各 64 字节构成指纹，足以在实践范围内唯一标识图片
	 * Uses buffer length + first/last 64 bytes as fingerprint, sufficient for image dedup in practice
	 *
	 * 参考 Share to Save image-handler.ts:427-432
	 */
	private computeContentHash(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		const len = bytes.length;
		const head = bytes.subarray(0, 64).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
		const tail = bytes.subarray(-64).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
		return `${len}:${head}:${tail}`;
	}

	/**
	 * 去重检查：文件已存在且内容相同则跳过
	 * Dedup check: skip if file exists with same content
	 *
	 * 参考 Share to Save image-handler.ts:438-455
	 */
	private async existsWithSameContent(path: string, buffer: ArrayBuffer): Promise<boolean> {
		try {
			const exists = await this.vault.adapter.exists(path);
			if (!exists) return false;

			const existingArrayBuffer = await this.vault.adapter.readBinary(path);
			const existing = new Uint8Array(existingArrayBuffer);
			const incoming = new Uint8Array(buffer);
			if (existing.length !== incoming.length) return false;

			// 逐字节比较 / Byte-by-byte comparison
			for (let i = 0; i < existing.length; i++) {
				if (existing[i] !== incoming[i]) return false;
			}
			return true;
		} catch {
			return false;
		}
	}
}
