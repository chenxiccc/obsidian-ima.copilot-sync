import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { AttachmentOptions } from './image-handler';
import {
	CHROME_UA,
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
	}): Promise<DownloadResult> {
		const { url, headers, filename, noteFilePath, opts, isImage = false } = params;

		// 大小限制检查 / Size limit check
		const sizeLimitBytes = isImage ? opts.imageSizeLimitBytes : opts.fileSizeLimitBytes;
		if (sizeLimitBytes > 0) {
			const exceeded = await exceedsSizeLimit(url, sizeLimitBytes, headers);
			if (exceeded) {
				console.debug(`IMA Sync: 附件超过大小限制，保留原链接 / Attachment exceeds size limit, keeping link: ${url}`);
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
			await this.downloadWithAntiHotlink(url, destPath, headers);
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
	private async downloadWithAntiHotlink(
		url: string,
		destPath: string,
		extraHeaders?: Record<string, string>,
	): Promise<void> {
		// 合并请求头：API 返回的 headers + 反盗链头 / Merge headers: API headers + anti-hotlink headers
		const mergedHeaders: Record<string, string> = {
			'User-Agent': CHROME_UA,
			'Accept': '*/*',
			...extraHeaders,
		};

		try {
			await this.downloadViaRequestUrl(url, destPath, mergedHeaders);
			return;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`IMA Sync: requestUrl 下载失败，尝试 Node.js fallback / requestUrl download failed, trying Node.js fallback: ${msg}`);
		}

		// 兜底：Node.js https.get（仅桌面端 Electron 环境）
		// Fallback: Node.js https.get (desktop Electron environment only)
		try {
			await this.downloadViaNodeHttps(url, destPath, mergedHeaders);
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
		console.debug(`IMA Sync: 开始下载文件 / Downloading file: ${url.substring(0, 100)}...`);

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
			console.warn(`IMA Sync: 下载文件仅 ${buffer.byteLength} 字节，可能是防盗链错误页 / Downloaded file only ${buffer.byteLength} bytes, may be anti-hotlink error page: ${url}`);
		}

		await this.vault.adapter.writeBinary(destPath, buffer);
		console.debug(`IMA Sync: 文件已保存 / File saved: ${destPath}`);
	}

	/** 通过 Node.js https.get 下载（桌面端兜底）/ Download via Node.js https.get (desktop fallback) */
	private async downloadViaNodeHttps(
		url: string,
		destPath: string,
		headers: Record<string, string>,
	): Promise<void> {
		// 动态引入 Node.js 模块，移动端不可用时直接抛错
		// Dynamic import of Node.js modules; throws on mobile where they're unavailable
		let https: typeof import('https');
		try {
			https = require('https');
		} catch {
			throw new Error('Node.js https 模块不可用（可能为移动端环境）/ Node.js https module unavailable (likely mobile environment)');
		}

		return new Promise<void>((resolve, reject) => {
			const req = https.get(url, { headers }, (res) => {
				if (!res.statusCode || res.statusCode >= 400) {
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}

				// 处理重定向 / Handle redirects
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					this.downloadViaNodeHttps(res.headers.location, destPath, headers)
						.then(resolve)
						.catch(reject);
					return;
				}

				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', async () => {
					try {
						const buffer = Buffer.concat(chunks);
						if (buffer.length < 1024) {
							console.warn(`IMA Sync: Node.js 下载仅 ${buffer.length} 字节，可能是防盗链错误页 / Node.js download only ${buffer.length} bytes, may be anti-hotlink error page`);
						}

						await this.vault.adapter.writeBinary(destPath, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
						console.debug(`IMA Sync: Node.js 下载完成 / Node.js download complete: ${destPath}`);
						resolve();
					} catch (err) {
						reject(err);
					}
				});
				res.on('error', reject);
			});
			req.on('error', reject);
			// 超时 60 秒 / 60 second timeout
			req.setTimeout(60_000, () => {
				req.destroy();
				reject(new Error('下载超时 / Download timeout'));
			});
		});
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
		const safePath = relPath.includes(' ') ? `<${relPath}>` : relPath;
		return `![](${safePath})`;
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
		const safePath = relPath.includes(' ') ? `<${relPath}>` : relPath;
		return `[${filename}](${safePath})`;
	}
}
