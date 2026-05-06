import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { AttachmentOptions } from './image-handler';

// ─── 通用文件下载器（支持反盗链）/ Generic file downloader (with anti-hotlink support) ──

// Chrome UA 字符串，用于反盗链伪装 / Chrome UA string for anti-hotlink spoofing
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

		const attachmentFolder = this.resolveAttachmentFolder(noteFilePath, opts);
		await this.ensureFolder(attachmentFolder);

		const sanitized = this.sanitizeFilename(filename);
		const destPath = normalizePath(`${attachmentFolder}/${sanitized}`);

		// 已存在则跳过下载 / Skip download if file already exists
		const exists = await this.vault.adapter.exists(destPath);
		if (!exists) {
			await this.downloadWithAntiHotlink(url, destPath, headers);
		}

		const linkText = isImage
			? this.formatImageLink(sanitized, destPath, noteFilePath, opts)
			: this.formatFileLink(sanitized, destPath, noteFilePath);

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
		let path: typeof import('path');
		let fs: typeof import('fs/promises');
		try {
			https = require('https');
			path = require('path');
			fs = require('fs/promises');
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

						// 写入临时文件再用 vault adapter 导入
						// Write to temp file then import via vault adapter
						const tmpPath = path.join(
							(this.vault.adapter as unknown as { basePath?: string }).basePath ?? '',
							'.obsidian', '.tmp-ima-download',
						);
						await fs.mkdir(path.dirname(tmpPath), { recursive: true });
						await fs.writeFile(tmpPath, buffer);
						await this.vault.adapter.writeBinary(destPath, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
						await fs.unlink(tmpPath).catch(() => {});
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
		let format = opts.linkFormat;
		if (format === 'auto') {
			const useMarkdown = (this.vault as unknown as { getConfig(k: string): boolean })
				.getConfig('useMarkdownLinks') ?? false;
			format = useMarkdown ? 'markdown' : 'wikilink';
		}

		if (format === 'wikilink') {
			return `![[${filename}]]`;
		}

		// Markdown 格式，计算相对路径 / Markdown format, calculate relative path
		const noteDir = noteFilePath.includes('/')
			? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
			: '';
		const relPath = this.calcRelativePath(noteDir, destPath);
		const encoded = relPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
		return `![](${encoded})`;
	}

	/** 格式化文件链接 / Format file link */
	private formatFileLink(
		filename: string,
		destPath: string,
		noteFilePath: string,
	): string {
		const noteDir = noteFilePath.includes('/')
			? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
			: '';
		const relPath = this.calcRelativePath(noteDir, destPath);
		const encoded = relPath.split('/').map(seg => encodeURIComponent(seg)).join('/');
		return `[${filename}](${encoded})`;
	}

	/** 计算相对路径 / Calculate relative path */
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

	/** 解析附件文件夹路径（与 ImageHandler 相同逻辑）/ Resolve attachment folder path (same logic as ImageHandler) */
	private resolveAttachmentFolder(noteFilePath: string, opts: AttachmentOptions): string {
		const noteDir = noteFilePath.includes('/')
			? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
			: '';
		const noteBasename = noteFilePath
			.replace(/^.*\//, '')
			.replace(/\.md$/, '');

		switch (opts.pathMode) {
			case 'subfolder':
				return normalizePath(`${opts.syncFolder}/${opts.subfolderName || 'attachments'}`);
			case 'obsidian': {
				const setting: string =
					(this.vault as unknown as { getConfig(k: string): string }).getConfig('attachmentFolderPath')
					?? 'attachments';
				if (!setting || setting === '/') return normalizePath('/');
				if (setting.startsWith('./')) {
					return normalizePath(`${noteDir}/${setting.slice(2)}`);
				}
				return normalizePath(setting);
			}
			case 'samename':
				return normalizePath(`${opts.syncFolder}/${noteBasename}`);
			default:
				return normalizePath(`${opts.syncFolder}/attachments`);
		}
	}

	/** 清理文件名 / Sanitize filename */
	private sanitizeFilename(name: string): string {
		return name.replace(/[/\\:*?"<>|]/g, '_').trim();
	}

	/** 确保文件夹存在 / Ensure folder exists */
	private async ensureFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		const exists = await this.vault.adapter.exists(normalized);
		if (!exists) {
			await this.vault.createFolder(normalized);
		}
	}
}
