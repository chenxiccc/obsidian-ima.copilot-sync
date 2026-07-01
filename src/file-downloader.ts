import { requestUrl, Vault, normalizePath } from 'obsidian';
import type { AttachmentOptions } from './path-utils';
import {
	escapePathForMarkdown,
	sanitizeFilename,
	resolveAttachmentFolder,
	calcRelativePath,
	ensureFolder,
	exceedsSizeLimit,
	extractNoteDir,
	resolveLinkFormat,
} from './path-utils';
import { buildHeaders } from './http-utils';

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

		const attachmentFolder = resolveAttachmentFolder(noteFilePath);
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
			...buildHeaders(undefined, '*/*'),  // no Referer for file downloads, browser-like headers
			...extraHeaders,                     // IMA headers override defaults
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

		// Node.js https.get 可可靠发送自定义 UA/Referer，使用 buildHeaders 模拟浏览器请求
		// Node.js https.get can reliably send custom UA/Referer, use buildHeaders to emulate browser
		const nodeHeaders: Record<string, string> = { ...baseHeaders };
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

	/**
	 * 将 URL 下载到内存（不写文件），返回 ArrayBuffer + Content-Type
	 * Download URL to memory (no file write), returns ArrayBuffer + Content-Type
	 *
	 * 遵循 requestUrl → Node.js https 的兜底逻辑（受 antiHotlinkEnhanced 控制）
	 * Follows requestUrl → Node.js https fallback (gated by antiHotlinkEnhanced)
	 *
	 * Content-Type 用于后续扩展名修正：当 URL 扩展名与 HTTP 实际内容类型不一致时，
	 * 可用 contentTypeToExt() 推导正确扩展名（如知乎 CDN .avis 实际是 PNG）
	 * Content-Type is used for extension correction when URL extension doesn't match actual content type
	 */
	async downloadToBuffer(
		url: string,
		extraHeaders?: Record<string, string>,
		antiHotlinkEnhanced = false,
	): Promise<{ buffer: ArrayBuffer; contentType: string }> {
		// 尝试 requestUrl（可获取 Content-Type 响应头）
		// Try requestUrl (can get Content-Type response header)
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: {
					...buildHeaders(undefined, '*/*'),
					...extraHeaders,
				},
				throw: false,
			});
			if (response.status < 400) {
				const ct = (response.headers?.['content-type'] as string) ?? '';
				return { buffer: response.arrayBuffer, contentType: ct };
			}
		} catch (err) {
			console.warn(`ima.copilot Sync: requestUrl 下载到内存失败 / requestUrl download to buffer failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Node.js https 兜底（仅当防盗链增强开启）/ Node.js https fallback (only when anti-hotlink enhanced)
		if (!antiHotlinkEnhanced) {
			throw new Error('文件下载失败 / File download failed: requestUrl failed and anti-hotlink enhanced is disabled');
		}

		const nodeHeaders: Record<string, string> = {
			...buildHeaders(undefined, 'image/*, */*'),
			...extraHeaders,
		};
		// 微信 CDN 图片需要 Referer（参考 Share to Save image-handler.ts:292-299）
		// WeChat CDN images need Referer (ref: Share to Save image-handler.ts:292-299)
		if (/qpic\.cn/.test(url) && !nodeHeaders['Referer']) {
			nodeHeaders['Referer'] = 'https://mp.weixin.qq.com/';
		}

		const { buffer, contentType } = await this.nodeHttpsGetBuffer(url, nodeHeaders);
		return {
			buffer: (buffer.buffer as ArrayBuffer).slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
			contentType,
		};
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
	 *
	 * 网络错误 / 超时 / 429 / 5xx → 最多重试 2 次（1s/2s 指数退避），参考 Scrapling 策略。
	 * 4xx（非 429）不重试——客户端错误重试无意义。
	 * 重定向递归跟随，上限 5 次。
	 * Network error / timeout / 429 / 5xx → up to 2 retries (1s/2s backoff), ref: Scrapling.
	 * 4xx (non-429) not retried — client errors won't resolve on retry.
	 * Redirects followed recursively, max 5.
	 *
	 * 参考 Share to Save downloader.ts:331-416 / Ref: Share to Save downloader.ts:331-416
	 */
	private nodeHttpsGetBuffer(
		url: string,
		headers: Record<string, string>,
		retryCount = 0,
		redirectCount = 0,
	): Promise<{ buffer: Buffer; contentType: string }> {
		const MAX_RETRIES = 2;
		const MAX_REDIRECTS = 5;

		if (redirectCount >= MAX_REDIRECTS) {
			return Promise.reject(new Error(`重定向次数过多 / Too many redirects (${MAX_REDIRECTS})`));
		}

		// 根据协议动态选择模块，支持 HTTP 和 HTTPS（参考 Share to Save image-handler.ts:370-372）
		// Select module by protocol, support both HTTP and HTTPS (ref: Share to Save image-handler.ts:370-372)
		const protocol = new URL(url).protocol === 'http:' ? 'http' : 'https';
		// 动态 require 避免 Node 模块在移动端顶层加载；require 类型由 @types/node 提供，
		// 断言为 https 模块类型使回调参数 res/req 获得强类型（http 与 https 的 get 签名兼容）
		// Dynamic require avoids loading Node modules at top level on mobile; require is typed by
		// @types/node, asserted to the https module type so callback res/req get strong types
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require for Node.js module based on URL protocol
		const mod = require(protocol) as typeof import('https');

		return new Promise<{ buffer: Buffer; contentType: string }>((resolve, reject) => {
			// 重试辅助函数，防重复触发 / Retry helper with dedup guard
			let settled = false;
			const retry = (reason: string) => {
				if (settled) return;
				settled = true;
				if (retryCount < MAX_RETRIES) {
					const delay = (retryCount + 1) * 1000;  // 指数退避 1s, 2s / exponential backoff
					console.warn(
						`ima.copilot Sync: Node.js 下载重试 ${retryCount + 1}/${MAX_RETRIES}（${delay}ms 后）: ${reason} — ${url.substring(0, 100)}`,
					);
					window.setTimeout(() => {
						this.nodeHttpsGetBuffer(url, headers, retryCount + 1, redirectCount)
							.then(resolve)
							.catch(reject);
					}, delay);
				} else {
					console.warn(`ima.copilot Sync: Node.js 下载重试耗尽 (${MAX_RETRIES}): ${reason} — ${url.substring(0, 100)}`);
					reject(new Error(`下载重试耗尽 / Retries exhausted: ${reason}`));
				}
			};

			const req = mod.get(url, { headers }, (res) => {
				// 处理重定向（含相对路径解析）/ Handle redirect (with relative URL resolution)
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();  // 排空响应体 / Drain response body
					settled = true;  // 阻止原请求的 timeout 重试 / prevent original timeout from retrying
					const redirectUrl = new URL(res.headers.location, url).toString();
					this.nodeHttpsGetBuffer(redirectUrl, headers, retryCount, redirectCount + 1)
						.then(resolve)
						.catch(reject);
					return;
				}

				const sc = res.statusCode || 0;

				// 304 Not Modified — 无响应体，终端错误 / no body, terminal error
				if (sc === 304) {
					res.resume();
					reject(new Error('HTTP 304 Not Modified'));
					return;
				}

				// 限流 — 可重试 / Rate limited — retryable (ref: Scrapling BLOCKED_CODES)
				if (sc === 429) {
					res.resume();
					retry(`HTTP 429 Too Many Requests`);
					return;
				}

				// 服务端错误 — 可重试 / Server error — retryable (ref: Scrapling BLOCKED_CODES)
				if (sc >= 500) {
					res.resume();
					retry(`HTTP ${sc} Server Error`);
					return;
				}

				// 客户端错误 — 不重试 / Client error — terminal (ref: Scrapling BLOCKED_CODES)
				if (sc >= 400) {
					res.resume();
					reject(new Error(`HTTP ${sc}`));
					return;
				}

				// 捕获 Content-Type 用于后续扩展名修正（参考 Share to Save image-handler.ts:388）
				// Capture Content-Type for later extension correction (ref: Share to Save image-handler.ts:388)
				const contentType = res.headers['content-type'] ?? '';
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const buffer = Buffer.concat(chunks);
					if (buffer.length < 1024) {
						console.warn(`ima.copilot Sync: Node.js 仅获取 ${buffer.length} 字节，可能是防盗链错误页 / Node.js only got ${buffer.length} bytes, may be anti-hotlink error page`);
					}
					resolve({ buffer, contentType });
				});
				res.on('error', () => retry('response stream error'));
			});

			req.on('error', (err: Error) => retry(`network error: ${err.message}`));
			req.setTimeout(60_000, () => {
				req.destroy();
				retry('下载超时 / Download timeout');
			});
		});
	}

	/** 通过 Node.js https.get 下载（桌面端兜底）/ Download via Node.js https.get (desktop fallback) */
	public async downloadViaNodeHttps(
		url: string,
		destPath: string,
		headers: Record<string, string>,
	): Promise<void> {
		const { buffer } = await this.nodeHttpsGetBuffer(url, headers);
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
		const { buffer } = await this.nodeHttpsGetBuffer(url, headers);
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
