import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { AttachmentOptions } from './path-utils';
import {
	CHROME_UA,
	escapePathForMarkdown,
	sanitizeFilename,
	resolveAttachmentFolder,
	calcRelativePath,
	ensureFolder,
	exceedsSizeLimit,
	extractNoteDir,
	resolveLinkFormat,
} from './path-utils';

// ─── 通用文件下载器（支持反盗链）/ Generic file downloader (with anti-hotlink support) ──

/** 下载结果 / Download result */
export interface DownloadResult {
	/** 文件在 vault 中的路径 / File path in vault */
	localPath: string;
	/** Markdown 链接文本 / Markdown link text */
	linkText: string;
}

export class FileDownloader {
	constructor(private readonly vault: Vault) {}

	/**
	 * 下载文件到 vault 附件目录（支持反盗链请求头）
	 * Download file to vault attachment dir (with anti-hotlink request headers)
	 */
	async downloadFile(params: {
		/** 下载 URL / Download URL */
		url: string;
		/** get_media_info 返回的请求头 / Headers returned by get_media_info */
		headers?: Record<string, string>;
		/** 目标文件名（含扩展名）/ Target filename (with extension) */
		filename: string;
		/** 当前笔记在 vault 中的路径 / Current note path in vault */
		noteFilePath: string;
		/** 附件选项 / Attachment options */
		opts: AttachmentOptions;
		/** 是否为图片（图片用图片链接语法）/ Whether the file is an image (use image link syntax) */
		isImage?: boolean;
		/** 防盗链增强（Node.js https 回退）/ Anti-hotlink enhanced (Node.js https fallback) */
		antiHotlinkEnhanced?: boolean;
	}): Promise<DownloadResult> {
		const { url, headers, filename, noteFilePath, opts, isImage = false, antiHotlinkEnhanced = false } = params;

		// 大小限制检查 / Size limit check
		const sizeLimitBytes = isImage ? opts.imageSizeLimitBytes : opts.fileSizeLimitBytes;
		if (sizeLimitBytes > 0) {
			const exceeded = await exceedsSizeLimit(url, sizeLimitBytes, headers);
			if (exceeded) {
				console.debug(`ima.copilot Sync: 附件超过大小限制，保留原链接 / Attachment exceeds size limit, keeping link: ${url}`);
				const linkText = isImage ? `![${filename}](${url})` : `[${filename}](${url})`;
				return { localPath: '', linkText };
			}
		}

		const attachmentFolder = resolveAttachmentFolder(opts);
		await ensureFolder(this.vault, attachmentFolder);

		const sanitized = sanitizeFilename(filename);
		const destPath = normalizePath(`${attachmentFolder}/${sanitized}`);

		// 已存在则跳过下载 / Skip download if file already exists
		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadWithAntiHotlink(url, destPath, headers, antiHotlinkEnhanced);
		}

		const linkText = isImage
			? this.formatImageLink(sanitized, destPath, noteFilePath, opts)
			: this.formatFileLink(sanitized, destPath, noteFilePath, opts);

		return { localPath: destPath, linkText };
	}

	/**
	 * 带反盗链的下载：先尝试 requestUrl，失败后尝试 Node.js https.get（仅桌面端）
	 * Download with anti-hotlink: try requestUrl first, then Node.js https.get fallback (desktop only)
	 */
	public async downloadWithAntiHotlink(
		url: string,
		destPath: string,
		extraHeaders?: Record<string, string>,
		antiHotlinkEnhanced = false,
	): Promise<void> {
		// 基础请求头：requestUrl 不支持自定义 UA/Referer（会被 Chromium 安全策略剥离），仅 Node.js 路径可传递
		// Base headers: requestUrl cannot send custom UA/Referer (stripped by Chromium security policy), only Node.js path can deliver them
		const baseHeaders: Record<string, string> = {
			'Accept': '*/*',
			...extraHeaders,
		};

		try {
			await this.downloadViaRequestUrl(url, destPath, baseHeaders);
			return;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`ima.copilot Sync: requestUrl 下载失败 / requestUrl download failed: ${msg}`);
		}

		// 仅当防盗链增强开启时使用 Node.js https 回退（仅桌面端可用）
		// Only use Node.js https fallback when anti-hotlink is enhanced (desktop only)
		if (!antiHotlinkEnhanced) {
			throw new Error(`文件下载失败 / File download failed: requestUrl failed and anti-hotlink enhanced is disabled`);
		}

		// Node.js https.get 可可靠发送自定义 UA/Referer，设置 Chrome UA 以绕过防盗链
		// Node.js https.get can reliably send custom UA/Referer, set Chrome UA for anti-hotlink
		const nodeHeaders: Record<string, string> = {
			'User-Agent': CHROME_UA,
			...baseHeaders,
		};
		// 微信 CDN 图片需要 Referer 绕过防盗链（参考 Share to Save image-handler.ts:292-299）
		// WeChat CDN images need Referer to bypass hotlink protection (ref: Share to Save image-handler.ts:292-299)
		if (/qpic\.cn/.test(url) && !nodeHeaders['Referer']) {
			nodeHeaders['Referer'] = 'https://mp.weixin.qq.com/';
		}

		try {
			await this.downloadViaNodeHttps(url, destPath, nodeHeaders);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`文件下载失败 / File download failed: ${msg}`);
		}
	}

	/** 通过 requestUrl 下载 / Download via requestUrl */
	private async downloadViaRequestUrl(
		url: string,
		destPath: string,
		headers: Record<string, string>,
	): Promise<void> {
		console.debug(`ima.copilot Sync: 开始下载文件 / Downloading file: ${url.substring(0, 100)}...`);

		const response = await requestUrl({
			url,
			method: 'GET',
			headers,
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`HTTP ${response.status}`);
		}

		// 小文件检测：< 1024 字节可能是防盗链错误页
		// Small file detection: < 1024 bytes may be anti-hotlink error page
		const buffer = response.arrayBuffer;
		if (buffer.byteLength < 1024) {
			console.warn(`ima.copilot Sync: 下载文件仅 ${buffer.byteLength} 字节，可能是防盗链错误页 / Downloaded file only ${buffer.byteLength} bytes, may be anti-hotlink error page: ${url}`);
		}

		await this.vault.adapter.writeBinary(destPath, buffer);
		console.debug(`ima.copilot Sync: 文件已保存 / File saved: ${destPath}`);
	}

	/**
	 * 通过 Node.js https.get 获取数据 Buffer（桌面端兜底共享实现）
	 * Fetch data Buffer via Node.js https.get (shared desktop fallback implementation)
	 */
	private nodeHttpsGetBuffer(url: string, headers: Record<string, string>): Promise<Buffer> {
		let https: typeof import('https');
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
			https = require('https') as typeof import('https');
		} catch {
			throw new Error('Node.js https 模块不可用（可能为移动端环境）/ Node.js https module unavailable (likely mobile environment)');
		}

		return new Promise<Buffer>((resolve, reject) => {
			const req = https.get(url, { headers }, (res) => {
				if (!res.statusCode || res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					this.nodeHttpsGetBuffer(res.headers.location, headers)
						.then(resolve)
						.catch(reject);
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const buffer = Buffer.concat(chunks);
					if (buffer.length < 1024) {
						console.warn(`ima.copilot Sync: Node.js 仅获取 ${buffer.length} 字节，可能是防盗链错误页 / Node.js only got ${buffer.length} bytes, may be anti-hotlink error page`);
					}
					resolve(buffer);
				});
				res.on('error', reject);
			});
			req.on('error', reject);
			req.setTimeout(60_000, () => {
				req.destroy();
				reject(new Error('下载超时 / Download timeout'));
			});
		});
	}

	/** 通过 Node.js https.get 下载（桌面端兜底）/ Download via Node.js https.get (desktop fallback) */
	public async downloadViaNodeHttps(
		url: string,
		destPath: string,
		headers: Record<string, string>,
	): Promise<void> {
		const buffer = await this.nodeHttpsGetBuffer(url, headers);
		await this.vault.adapter.writeBinary(destPath, (buffer.buffer as ArrayBuffer).slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
		console.debug(`ima.copilot Sync: Node.js 下载完成 / Node.js download complete: ${destPath}`);
	}

	/**
	 * 通过 Node.js https.get 获取网页 HTML（桌面端反盗链兜底）
	 * Fetch webpage HTML via Node.js https.get (desktop anti-hotlink fallback)
	 *
	 * 仿照 downloadViaNodeHttps，但返回 HTML 字符串而非写文件
	 * Modeled after downloadViaNodeHttps, but returns HTML string instead of writing to file
	 */
	public async fetchHtmlViaNodeHttps(
		url: string,
		headers: Record<string, string>,
	): Promise<string> {
		const buffer = await this.nodeHttpsGetBuffer(url, headers);
		return buffer.toString('utf-8');
	}

	/** 格式化图片链接 / Format image link */
	private formatImageLink(
		filename: string,
		destPath: string,
		noteFilePath: string,
		opts: AttachmentOptions,
	): string {
		const format = resolveLinkFormat(this.vault, opts.linkFormat);

		if (format === 'wikilink') {
			return `![[${filename}]]`;
		}

		// Markdown 格式，计算相对路径 / Markdown format, calculate relative path
		const noteDir = extractNoteDir(noteFilePath);
		const relPath = calcRelativePath(noteDir, destPath);
		return `![](${escapePathForMarkdown(relPath)})`;
	}

	/** 格式化文件链接 / Format file link */
	private formatFileLink(
		filename: string,
		destPath: string,
		noteFilePath: string,
		opts: AttachmentOptions,
	): string {
		const format = resolveLinkFormat(this.vault, opts.linkFormat);

		if (format === 'wikilink') {
			return `[[${filename}]]`;
		}

		// Markdown 格式，计算相对路径 / Markdown format, calculate relative path
		const noteDir = extractNoteDir(noteFilePath);
		const relPath = calcRelativePath(noteDir, destPath);
		return `[${filename}](${escapePathForMarkdown(relPath)})`;
	}
}
