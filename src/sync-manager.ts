import { App, Vault, Notice, normalizePath, TFile, requestUrl } from 'obsidian';
import type { ImaPluginSettings } from './settings';
import type { AttachmentOptions } from './image-handler';
import type { KnowledgeInfo, PublicKBItem, PublicKnowledgeBase } from './ima-client';
import { ImaClient, ImaPublicClient } from './ima-client';
import { ImageHandler } from './image-handler';
import { JsonToMarkdown } from './json-to-md';
import { convertHtmlToMarkdown } from './html-to-md';
import { FileDownloader } from './file-downloader';
import { CHROME_UA, sanitizeFilename, sanitizeTitle, ensureFolder, extractExtFromUrl, guessFileExtension } from './path-utils';

// ─── 同步管理器 / Sync manager ───────────────────────────────────────────────

const MEDIA_TYPE_LABELS: Record<number, string> = {
	1: 'PDF', 2: '网页', 3: 'Word 文档', 4: 'PPT', 5: 'Excel',
	6: '微信公众号文章', 7: 'Markdown', 9: '图片', 11: '笔记',
	13: 'TXT', 14: 'Xmind',
};

const FILE_MEDIA_TYPES = new Set([1, 3, 4, 5, 7, 9, 13, 14]);

export class SyncManager {
	private client: ImaClient | null = null;
	private publicClient = new ImaPublicClient();
	private imageHandler: ImageHandler;
	private jsonToMd: JsonToMarkdown;
	private fileDownloader: FileDownloader;
	private isSyncing = false;

	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly settings: ImaPluginSettings,
		private readonly saveSettings: () => Promise<void>,
		private readonly resolveCredentials: () => { clientId: string | null; apiKey: string | null },
	) {
		this.imageHandler = new ImageHandler(vault);
		this.jsonToMd = new JsonToMarkdown(this.imageHandler);
		this.fileDownloader = new FileDownloader(vault);
	}

	rebuildClient(): void {
		const { clientId, apiKey } = this.resolveCredentials();
		this.client = (clientId && apiKey) ? new ImaClient(clientId, apiKey) : null;
	}

	async syncOnce(): Promise<void> {
		if (this.isSyncing) {
			new Notice('IMA Sync: 同步正在进行中，请稍候');
			return;
		}

		// 凭证仅私有同步需要；公共知识库同步无需凭证
		// Credentials only needed for private sync; public KB sync doesn't need them
		const { clientId, apiKey } = this.resolveCredentials();
		const hasCredentials = !!(clientId && apiKey);
		if (hasCredentials) {
			this.rebuildClient();
		}

		// 检查是否有任何同步任务可执行 / Check if any sync task is available
		const hasPrivateWork = this.settings.syncNotes || this.settings.syncKnowledgeBase;
		const hasPublicWork = this.settings.publicKnowledgeBases.length > 0;
		if (hasPrivateWork && !hasCredentials) {
			new Notice('IMA Sync: 私有同步需要 Client ID 和 API Key，请先在设置中填写');
			return;
		}
		if (!hasPrivateWork && !hasPublicWork) {
			new Notice('IMA Sync: 没有可执行的同步任务');
			return;
		}

		this.isSyncing = true;
		new Notice('IMA Sync: 开始同步…');

		try {
			const syncedCount = await this.doSync();
			new Notice(`IMA Sync: 同步完成，共同步 ${syncedCount} 篇笔记`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error('IMA Sync error:', err);
			new Notice(`IMA Sync: 同步失败 — ${msg}`);
		} finally {
			this.isSyncing = false;
		}
	}

	async migrateSyncFolder(oldFolder: string, newFolder: string): Promise<void> {
		const old = normalizePath(oldFolder);
		const neu = normalizePath(newFolder);
		if (old === neu) return;

		const oldExists = await this.vault.adapter.exists(old);
		if (!oldExists) return;

		const newExists = await this.vault.adapter.exists(neu);
		if (newExists) {
			throw new Error(`目标文件夹 "${newFolder}" 已存在，无法迁移 / Target folder "${newFolder}" already exists`);
		}

		await this.vault.adapter.rename(old, neu);
	}

	private buildAttachmentOptions(kbName?: string, kbCategory?: string): AttachmentOptions {
		return {
			linkFormat: this.settings.linkFormat,
			syncFolder: normalizePath(this.settings.syncFolder),
			downloadAttachments: this.settings.downloadAttachments,
			attachmentSizeLimitBytes: this.calcSizeLimitBytes(),
			kbName,
			kbCategory,
		};
	}

	private calcSizeLimitBytes(): number {
		const { attachmentSizeLimit, attachmentSizeLimitUnit } = this.settings;
		if (attachmentSizeLimit <= 0) return 0;
		const multipliers: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
		return Math.round(attachmentSizeLimit * (multipliers[attachmentSizeLimitUnit] ?? 1));
	}

	/** 核心同步逻辑 / Core sync logic */
	private async doSync(): Promise<number> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const opts = this.buildAttachmentOptions();

		await ensureFolder(this.vault, syncFolder);

		let syncedCount = 0;

		// ── 同步 IMA 笔记 / Sync IMA notes ──
		if (this.settings.syncNotes && this.client) {
			const notes = await this.client.listAllNotes(this.settings.lastSyncTime);
			for (const note of notes) {
				try {
					const filename = sanitizeFilename(note.title || note.docid);
					const filePath = normalizePath(`${syncFolder}/${filename}.md`);
					const rawJson = await this.client.getNoteContent(note.docid);
					const processedContent = await this.jsonToMd.convert(rawJson, filePath, opts, filename);
					await this.writeNote(filePath, processedContent, opts);
					syncedCount++;
				} catch (err) {
					console.warn(`IMA Sync: 笔记 "${note.title}" 同步失败`, err);
				}
			}
		}

		// ── 同步个人知识库（多选）/ Sync personal knowledge bases (multi-select) ──
		if (this.settings.syncKnowledgeBase && this.client) {
			for (const pkb of this.settings.personalKnowledgeBases) {
				const kbId = pkb.kbId.trim();
				if (!kbId) continue;
				try {
					const kbName = pkb.name;
					const kbOpts = this.buildAttachmentOptions(kbName || undefined, '个人知识库');
					const kbFolder = normalizePath(`${syncFolder}/个人知识库/${sanitizeFilename(kbName || kbId)}`);
					await ensureFolder(this.vault, kbFolder);

					const existingMap = this.scanExistingKbFiles(kbFolder);
					const items = await this.client.listAllKnowledgeItems(kbId);

					// 删除同步 / Delete sync
					const apiMediaIds = new Set(items.map(i => i.media_id));
					for (const [mediaId, filePath] of existingMap) {
						if (!apiMediaIds.has(mediaId)) {
							try {
								await this.handleDeletedItem(filePath, opts);
							} catch (err) {
								console.warn(`IMA Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
							}
							existingMap.delete(mediaId);
						}
					}

					// 增量同步 / Incremental sync
					for (const item of items) {
						try {
							if (existingMap.has(item.media_id)) continue;
							const filename = sanitizeFilename(item.title || item.media_id);
							const filePath = normalizePath(`${kbFolder}/${filename}.md`);
							const content = await this.syncKnowledgeItem(item, filePath, kbOpts);
							if (content !== null) {
								await this.writeNote(filePath, content, opts);
								syncedCount++;
							}
						} catch (err) {
							console.warn(`IMA Sync: 知识库条目 "${item.title}" 同步失败`, err);
						}
					}
				} catch (err) {
					console.warn(`IMA Sync: 个人知识库 "${pkb.name}" 同步失败`, err);
					new Notice(`IMA Sync: 个人知识库 "${pkb.name}" 同步失败 — ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// ── 同步公共/订阅知识库 / Sync public/subscribed knowledge bases ──
		if (this.settings.publicKnowledgeBases.length > 0) {
			for (const pubKB of this.settings.publicKnowledgeBases) {
				try {
					const count = await this.syncPublicKnowledgeBase(pubKB, this.buildAttachmentOptions(pubKB.name || undefined, pubKB.kbCategory || '订阅和公共知识库'));
					syncedCount += count;
				} catch (err) {
					console.warn(`IMA Sync: 公共知识库 "${pubKB.name}" 同步失败`, err);
					new Notice(`IMA Sync: 公共知识库 "${pubKB.name}" 同步失败 — ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		// ── 修复残留外链图片 / Fix leftover external image links ──
		await this.fixPendingImages(syncFolder, opts);

		this.settings.lastSyncTime = Date.now();
		await this.saveSettings();

		return syncedCount;
	}

	/**
	 * 同步单个公共/订阅知识库
	 * Sync a single public/subscribed knowledge base
	 */
	private async syncPublicKnowledgeBase(
		pubKB: PublicKnowledgeBase,
		opts: AttachmentOptions,
	): Promise<number> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const kbCategory = pubKB.kbCategory || '订阅和公共知识库';
			const kbFolder = normalizePath(`${syncFolder}/${sanitizeFilename(kbCategory)}/${sanitizeFilename(pubKB.name || pubKB.shareId || pubKB.numericKbId)}`);
		await ensureFolder(this.vault, kbFolder);

		// 获取数字 KB ID（若尚未获取）/ Resolve numeric KB ID if not yet available
		let numericKbId = pubKB.numericKbId;
		if (!numericKbId && pubKB.shareId) {
			const result = await this.publicClient.getShareInfo(pubKB.shareId);
			numericKbId = result.knowledge_base_info.id;
			pubKB.numericKbId = numericKbId;
			if (!pubKB.name) {
				pubKB.name = result.knowledge_base_info.basic_info.name;
			}
		} else if (!numericKbId && pubKB.encryptedKbId) {
			// 用公共 API 通过 encryptedKbId 获取数字 KB ID
			// Use public API via encryptedKbId to get numeric KB ID
			const kbListResult = await this.publicClient.getKnowledgeListPublic(pubKB.encryptedKbId);
			numericKbId = kbListResult.current_path[0]?.folder_id ?? '';
			pubKB.numericKbId = numericKbId;
		}

		// 获取所有条目 / Fetch all items
		const items = numericKbId
			? await this.publicClient.listAllPublicItems(numericKbId)
			: pubKB.shareId
				? await this.publicClient.listAllSharedItems(pubKB.shareId)
				: [];

		if (items.length === 0) {
			console.warn(`IMA Sync: 公共知识库 "${pubKB.name}" 无条目或无法获取`);
			return 0;
		}

		// 扫描已有文件 / Scan existing files
		const existingMap = this.scanExistingKbFiles(kbFolder);

		// 删除同步 / Delete sync
		const apiMediaIds = new Set(items.map(i => i.media_id));
		for (const [mediaId, filePath] of existingMap) {
			if (!apiMediaIds.has(mediaId)) {
				try {
					await this.handleDeletedItem(filePath, opts);
				} catch (err) {
					console.warn(`IMA Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
				}
				existingMap.delete(mediaId);
			}
		}

		// 增量同步 / Incremental sync
		let count = 0;
		for (const item of items) {
			try {
				if (existingMap.has(item.media_id)) continue;

				const itemFolder = item.folderPath
					? normalizePath(`${kbFolder}/${item.folderPath}`)
					: kbFolder;
				await ensureFolder(this.vault, itemFolder);
				const filename = sanitizeFilename(item.title || item.media_id);
				const filePath = normalizePath(`${itemFolder}/${filename}.md`);

				const content = await this.syncPublicKBItem(item, filePath, opts);
				if (content !== null) {
					await this.writeNote(filePath, content, opts);
					count++;
				}
			} catch (err) {
				console.warn(`IMA Sync: 公共知识库条目 "${item.title}" 同步失败`, err);
			}
		}

		// 更新同步时间 / Update last sync time
		pubKB.lastSyncTime = Date.now();
		await this.saveSettings();

		return count;
	}

	/**
	 * 同步单个公共知识库条目：按类型分发
	 * Sync a single public KB item: dispatch by type
	 */
	private async syncPublicKBItem(
		item: PublicKBItem & { folderPath: string },
		filePath: string,
		opts: AttachmentOptions,
	): Promise<string | null> {
		const fmBase = `---\nmedia_id: "${item.media_id}"\n`;

		// 微信文章：raw_file_url / source_path 有完整微信 URL → 抓全文
		// WeChat article: raw_file_url / source_path has full WeChat URL → fetch full content
		if (item.media_type === 6) {
			const url = item.raw_file_url || item.source_path;
			if (url && url.startsWith('http')) {
				return await this.syncWebContent(url, undefined, item.title, true, item.media_id);
			}
		}

		// 网页：source_path 有原始 URL → 抓全文
		// Webpage: source_path has original URL → fetch full content
		if (item.media_type === 2) {
			const url = item.source_path || item.raw_file_url;
			if (url && url.startsWith('http')) {
				return await this.syncWebContent(url, undefined, item.title, false, item.media_id);
			}
		}

		// 笔记：introduction 提供预览（约 300 字符截断）
		// Note: introduction provides preview (~300 chars truncated)
		if (item.media_type === 11) {
			const preview = item.introduction || item.abstract || '';
			if (preview) {
				return `${fmBase}content_type: preview\n---\n\n# ${item.title}\n\n${preview}\n\n> 此内容为笔记预览摘要，完整内容需要登录 IMA 查看。`;
			}
			return `${fmBase}content_type: preview\n---\n\n# ${item.title}\n\n> 无法获取此笔记的预览内容。`;
		}

		// 文件类型（PDF 等）：abstract/introduction 提供摘要，raw_file_url 是 COS 相对路径无法直接下载
		// File types (PDF etc): abstract/introduction provide summary, raw_file_url is COS relative path (can't download directly)
		if (FILE_MEDIA_TYPES.has(item.media_type)) {
			const summary = item.abstract || item.introduction || '';
			const typeLabel = MEDIA_TYPE_LABELS[item.media_type] ?? `类型 ${item.media_type}`;
			if (summary) {
				return `${fmBase}---\n\n# ${item.title}\n\n${summary}\n\n> 此内容为${typeLabel}的 AI 摘要，完整文件需要在 IMA 客户端中查看。`;
			}
			return `${fmBase}---\n\n# ${item.title}\n\n> 此条目为${typeLabel}，暂不支持自动下载。`;
		}

		// 其他类型 fallback / Other types fallback
		const preview = item.introduction || item.abstract || '';
		const typeLabel = MEDIA_TYPE_LABELS[item.media_type] ?? `类型 ${item.media_type}`;
		if (preview) {
			return `${fmBase}---\n\n# ${item.title}\n\n${preview}`;
		}
		return `${fmBase}---\n\n> 此条目为${typeLabel}，暂不支持自动同步内容。\n\n**标题**: ${item.title}`;
	}

	/**
	 * 扫描知识库文件夹下已有 .md 文件，从 metadataCache 提取 media_id（零 I/O）
	 * Scan existing KB .md files, extract media_id from metadataCache (zero I/O)
	 */
	private scanExistingKbFiles(kbFolder: string): Map<string, string> {
		const map = new Map<string, string>();
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(kbFolder + '/'),
		);

		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const mediaId = cache?.frontmatter?.media_id;
			if (mediaId) {
				map.set(String(mediaId), file.path);
			}
		}

		return map;
	}

	/**
	 * 处理 IMA 端已删除的知识库条目：按 syncDeleteMode 设置执行删除/保留/标记
	 * Handle KB items deleted from IMA: delete/keep/mark per syncDeleteMode setting
	 */
	private async handleDeletedItem(filePath: string, opts: AttachmentOptions): Promise<void> {
		const file = this.vault.getFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const mode = this.settings.syncDeleteMode;

		if (mode === 'delete') {
			const oldContent = await this.vault.read(file);
			const oldPaths = this.imageHandler.extractLocalImagePaths(oldContent, filePath, opts);
			await this.cleanOrphanImages(oldPaths, filePath);
			await this.vault.delete(file);
			console.debug(`IMA Sync: 删除已移除条目 / Deleted removed item: ${filePath}`);
		} else if (mode === 'mark-deleted') {
			if (filePath.includes('[deleted]')) return;
			const newFilePath = filePath.replace(/\.md$/, ' [deleted].md');
			try {
				await this.vault.adapter.rename(filePath, newFilePath);
			} catch (renameErr) {
				console.warn(`IMA Sync: 标记删除重命名失败 / Mark-deleted rename failed: ${filePath}`, renameErr);
				return;
			}
			const renamedFile = this.vault.getFileByPath(newFilePath);
			if (renamedFile instanceof TFile) {
				const content = await this.vault.read(renamedFile);
				const updated = this.prependFrontmatterField(content, 'sync_status', 'deleted');
				await this.vault.modify(renamedFile, updated);
			}
			console.debug(`IMA Sync: 标记已删除条目 / Marked deleted item: ${newFilePath}`);
		}
	}

	/**
	 * 同步单个知识库条目：通过 get_media_info 获取访问信息，按类型分发处理
	 * Sync a single KB item: get access info via get_media_info, dispatch by type
	 */
	private async syncKnowledgeItem(
		item: KnowledgeInfo,
		filePath: string,
		opts: AttachmentOptions,
	): Promise<string | null> {
		try {
			const mediaInfo = await this.client!.getMediaInfo(item.media_id);

			if (mediaInfo.media_type === 11 && mediaInfo.notebook_ext_info?.notebook_id) {
				const notebookId = mediaInfo.notebook_ext_info.notebook_id;
				const rawJson = await this.client!.getNoteContent(notebookId);
				const mdContent = await this.jsonToMd.convert(rawJson, filePath, opts, item.title);
				return this.prependFrontmatterField(mdContent, 'media_id', item.media_id);
			}

			if (mediaInfo.url_info?.url) {
				const { url, headers } = mediaInfo.url_info;
				return await this.syncByMediaType(item.media_type, url, headers, item.title, filePath, opts, item.media_id);
			}

			return this.buildPlaceholder(item);
		} catch (err) {
			console.warn(`IMA Sync: get_media_info 失败，使用占位符 / get_media_info failed, using placeholder: ${item.media_id}`, err);
			return this.buildPlaceholder(item);
		}
	}

	/**
	 * 在 frontmatter 中插入一个字段（若已有 frontmatter 则合并，否则新建）
	 * Insert a field into frontmatter (merge if exists, create if not)
	 */
	private prependFrontmatterField(content: string, key: string, value: string): string {
		if (content.startsWith('---')) {
			const closeIdx = content.indexOf('---', 3);
			if (closeIdx > 0) {
				return content.slice(0, closeIdx) + `${key}: "${value}"\n` + content.slice(closeIdx);
			}
		}
		return `---\n${key}: "${value}"\n---\n\n${content}`;
	}

	/**
	 * 根据 media_type 分发处理
	 * Dispatch by media_type
	 */
	private async syncByMediaType(
		mediaType: number,
		url: string,
		headers: Record<string, string> | undefined,
		title: string,
		filePath: string,
		opts: AttachmentOptions,
		mediaId: string,
	): Promise<string> {
		if (mediaType === 2 || mediaType === 6) {
			return await this.syncWebContent(url, headers, title, mediaType === 6, mediaId);
		}

		if (mediaType === 9) {
			return await this.syncFileDownload(url, headers, title, filePath, opts, true, mediaId);
		}

		if (FILE_MEDIA_TYPES.has(mediaType)) {
			return await this.syncFileDownload(url, headers, title, filePath, opts, false, mediaId);
		}

		return this.buildPlaceholder({ media_id: mediaId, title, parent_folder_id: '', media_type: mediaType });
	}

	/**
	 * 抓取网页内容并转为 Markdown（含 YAML frontmatter）
	 * Fetch webpage content and convert to Markdown (with YAML frontmatter)
	 */
	private async syncWebContent(
		url: string,
		headers: Record<string, string> | undefined,
		title: string,
		isWeChat: boolean,
		mediaId: string,
	): Promise<string> {
		try {
			const requestHeaders: Record<string, string> = {
				'User-Agent': CHROME_UA,
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...headers,
			};

			const response = await requestUrl({
				url,
				method: 'GET',
				headers: requestHeaders,
				throw: false,
			});

			if (response.status >= 400) {
				throw new Error(`HTTP ${response.status}`);
			}

			const html = response.text;
			const result = convertHtmlToMarkdown(html, {
				url,
				contentSelector: isWeChat ? '#js_content' : undefined,
			});

			const frontmatter = this.buildWebFrontmatter(url, result.author, result.published, mediaId);

			const parts: string[] = [frontmatter];
			const effectiveTitle = result.title || title;
			if (effectiveTitle) {
				parts.push(`# ${effectiveTitle}\n`);
			}
			if (result.content) {
				parts.push(result.content);
			} else {
				parts.push(`> 无法提取网页正文，请访问原文：[链接](${url})`);
			}
			return parts.join('\n');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `> 网页内容获取失败：${msg}\n\n**标题**: ${title}\n\n**原文链接**: [${url}](${url})`;
		}
	}

	/**
	 * 构建网页条目的 YAML frontmatter
	 * Build YAML frontmatter for web content items
	 */
	private buildWebFrontmatter(source: string, author: string, published: string, mediaId: string): string {
		const lines: string[] = ['---'];
		lines.push(`source: "${source}"`);
		lines.push(`media_id: "${mediaId}"`);

		if (author) {
			lines.push('author:');
			lines.push(`  - "[[${author}]]"`);
		}

		if (published) {
			const formatted = this.formatDateTime(published);
			if (formatted) {
				lines.push(`published: ${formatted}`);
			}
		}

		lines.push(`created: ${new Date().toISOString().slice(0, 19)}`);
		lines.push('---');
		return lines.join('\n');
	}

	/**
	 * 将各种日期格式统一为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss
	 * Normalize various date formats to YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss
	 */
	private formatDateTime(input: string): string | null {
		if (!input) return null;
		try {
			const date = new Date(input);
			if (isNaN(date.getTime())) return null;
			const iso = date.toISOString();
			if (iso.slice(11, 19) === '00:00:00') {
				return iso.slice(0, 10);
			}
			return iso.slice(0, 19);
		} catch {
			return null;
		}
	}

	/**
	 * 下载文件到附件目录，返回包含链接的 Markdown
	 * Download file to attachment dir, return Markdown with link
	 */
	private async syncFileDownload(
		url: string,
		headers: Record<string, string> | undefined,
		title: string,
		filePath: string,
		opts: AttachmentOptions,
		isImage: boolean,
		mediaId: string,
	): Promise<string> {
		const fm = `---\nmedia_id: "${mediaId}"\n---\n\n`;

		if (!opts.downloadAttachments) {
			if (isImage) {
				return `${fm}![${title}](${url})`;
			}
			return `${fm}# ${title}\n\n[${title}](${url})`;
		}

		try {
			const filename = this.inferFilenameFromUrl(url, title);

			const result = await this.fileDownloader.downloadFile({
				url,
				headers,
				filename,
				noteFilePath: filePath,
				opts,
				isImage,
			});

			if (isImage) {
				return `${fm}${result.linkText}`;
			}

			return `${fm}# ${title}\n\n${result.linkText}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const typeLabel = MEDIA_TYPE_LABELS[isImage ? 9 : 0] ?? '文件';
			return `> ${typeLabel}下载失败：${msg}\n\n**标题**: ${title}`;
		}
	}

	/** 从 URL 推断下载文件名 / Infer download filename from URL */
	private inferFilenameFromUrl(url: string, fallbackTitle: string): string {
		const ext = extractExtFromUrl(url) || guessFileExtension(url);
		const safeTitle = sanitizeTitle(fallbackTitle, 'file');
		return `${safeTitle}-${Date.now()}-1${ext}`;
	}

	/** 构建占位符内容 / Build placeholder content */
	private buildPlaceholder(item: KnowledgeInfo): string {
		const typeLabel = MEDIA_TYPE_LABELS[item.media_type] ?? `类型 ${item.media_type}`;
		return `---\nmedia_id: "${item.media_id}"\n---\n\n> 此条目为${typeLabel}，暂不支持自动同步内容。\n\n**标题**: ${item.title}`;
	}

	/**
	 * 扫描同步文件夹内所有 .md 文件，将其中残留的外链图片下载到本地并替换链接
	 * Scan all .md files in sync folder, download leftover external image links
	 */
	private async fixPendingImages(syncFolder: string, opts: AttachmentOptions): Promise<void> {
		if (!opts.downloadAttachments) return;

		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/'),
		);

		for (const file of mdFiles) {
			try {
				const content = await this.vault.read(file);
				if (!content.match(/!\[[^\]]*\]\(https?:\/\//)) continue;

				const fixed = await this.imageHandler.processContent(content, file.path, opts, file.basename);
				if (fixed !== content) {
					await this.vault.modify(file, fixed);
					console.debug(`IMA Sync: 修复图片链接 / Fixed image links in: ${file.path}`);
				}
			} catch (err) {
				console.warn(`IMA Sync: 修复图片链接失败 / Failed to fix image links in ${file.path}:`, err);
			}
		}
	}

	/**
	 * 写入或更新笔记文件，更新后清理孤儿图片
	 * Write or update note file, then clean up orphan images
	 */
	private async writeNote(filePath: string, content: string, opts: AttachmentOptions): Promise<void> {
		const existing = this.vault.getFileByPath(filePath);
		if (existing instanceof TFile) {
			const oldContent = await this.vault.read(existing);

			if (oldContent === content) return;

			const oldPaths = this.imageHandler.extractLocalImagePaths(oldContent, filePath, opts);
			await this.vault.modify(existing, content);

			const newPaths = new Set(this.imageHandler.extractLocalImagePaths(content, filePath, opts));
			const orphans = oldPaths.filter(p => !newPaths.has(p));
			if (orphans.length > 0) {
				await this.cleanOrphanImages(orphans, filePath);
			}
		} else {
			await this.vault.create(filePath, content);
		}
	}

	/**
	 * 检查图片路径列表，删除不再被任何同步笔记引用的图片文件
	 * Check image paths and delete files no longer referenced by any synced note
	 *
	 * 使用 metadataCache 替代全文件读取，零 I/O
	 * Uses metadataCache instead of full file reads, zero I/O
	 */
	private async cleanOrphanImages(imagePaths: string[], skipFile: string): Promise<void> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/') && f.path !== skipFile,
		);

		const referencedFilenames = new Set<string>();
		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			for (const embed of cache.embeds ?? []) {
				referencedFilenames.add(embed.link.split('/').pop() ?? embed.link);
			}
			for (const link of cache.links ?? []) {
				if (link.original.startsWith('!') && !link.link.startsWith('http')) {
					const decoded = link.link.split('/').map(s => decodeURIComponent(s)).join('/');
					referencedFilenames.add(decoded.split('/').pop() ?? decoded);
				}
			}
		}

		for (const imgPath of imagePaths) {
			try {
				const exists = await this.vault.adapter.exists(imgPath);
				if (!exists) continue;

				const filename = imgPath.split('/').pop() ?? '';
				if (!referencedFilenames.has(filename) &&
					!referencedFilenames.has(encodeURIComponent(filename))) {
					await this.vault.adapter.remove(imgPath);
					console.debug(`IMA Sync: 删除孤儿图片 / Removed orphan image: ${imgPath}`);
				}
			} catch (err) {
				console.warn(`IMA Sync: 清理孤儿图片失败 / Failed to clean orphan image ${imgPath}:`, err);
			}
		}
	}
}
