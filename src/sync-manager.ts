import { App, Vault, Notice, normalizePath, TFile, requestUrl } from 'obsidian';
import type { ImaPluginSettings } from './settings';
import type { AttachmentOptions } from './path-utils';
import type { KnowledgeInfo, PublicKBItem, PublicKnowledgeBase } from './ima-client';
import { ImaClient, ImaPublicClient, formatImaError, isImaApiError } from './ima-client';
import { ImageHandler } from './image-handler';
import { convertHtmlToMarkdown, convertWeChatHtmlToMarkdown } from './html-to-md';
import type { HtmlToMdResult } from './html-to-md';
import { FileDownloader } from './file-downloader';
import { CHROME_UA, sanitizeFilename, buildStableFilename, ensureFolder, escapeInlineHash } from './path-utils';
import { HeadlessExtractor } from './headless-extractor';

// ─── 同步管理器 / Sync manager ───────────────────────────────────────────────

const MEDIA_TYPE_LABELS: Record<number, string> = {
	1: 'PDF', 2: '网页', 3: 'Word 文档', 4: 'PPT', 5: 'Excel',
	6: '微信公众号文章', 7: 'Markdown', 9: '图片', 11: '笔记',
	13: 'TXT', 14: 'Xmind',
};

// ─── 媒体类型常量 / Media type constants ─────────────────────────────────

const MEDIA_TYPE_PDF = 1;
const MEDIA_TYPE_WEBPAGE = 2;
const MEDIA_TYPE_WORD = 3;
const MEDIA_TYPE_PPT = 4;
const MEDIA_TYPE_EXCEL = 5;
const MEDIA_TYPE_WECHAT = 6;
const MEDIA_TYPE_MARKDOWN = 7;
const MEDIA_TYPE_IMAGE = 9;
const MEDIA_TYPE_NOTE = 11;
const MEDIA_TYPE_TXT = 13;
const MEDIA_TYPE_XMIND = 14;
/** 可通过 URL 抓取正文的媒体类型 / Media types whose content can be fetched via URL */
const FETCHABLE_MEDIA_TYPES = new Set([MEDIA_TYPE_WEBPAGE, MEDIA_TYPE_WECHAT]);

const FILE_MEDIA_TYPES = new Set([
	MEDIA_TYPE_PDF, MEDIA_TYPE_WORD, MEDIA_TYPE_PPT, MEDIA_TYPE_EXCEL,
	MEDIA_TYPE_MARKDOWN, MEDIA_TYPE_IMAGE, MEDIA_TYPE_TXT, MEDIA_TYPE_XMIND,
]);

/** IMA 笔记中文件附件的 <file> 标签正则 / Regex for file attachment <file> tags in IMA notes */
const FILE_TAG_REGEX = /<file\s+([^>]*)\s*\/>/g;

/** syncByMediaType 参数 / syncByMediaType parameters */
interface SyncMediaParams {
	url: string;
	headers?: Record<string, string>;
	title: string;
	filePath: string;
	opts: AttachmentOptions;
	mediaId: string;
}

export class SyncManager {
	private client: ImaClient | null = null;
	private publicClient = new ImaPublicClient();
	private imageHandler: ImageHandler;
	private fileDownloader: FileDownloader;
	private isSyncing = false;
	private headlessExtractor: HeadlessExtractor;
	private debugConfig?: { adapter: import('obsidian').DataAdapter; path: string };

	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly settings: ImaPluginSettings,
		private readonly saveSettings: () => Promise<void>,
		private readonly resolveCredentials: () => { clientId: string | null; apiKey: string | null },
		private readonly onSyncStateChange?: (syncing: boolean) => void,
	) {
		this.fileDownloader = new FileDownloader(vault);
		this.imageHandler = new ImageHandler(vault, this.fileDownloader);
		this.headlessExtractor = new HeadlessExtractor();
	}

	setDebugConfig(config: { adapter: import('obsidian').DataAdapter; path: string }): void {
		this.debugConfig = config;
	}

	setDebugEnabled(enabled: boolean): void {
		this.client?.setDebugEnabled(enabled);
	}

	rebuildClient(): void {
		const { clientId, apiKey } = this.resolveCredentials();
		this.client = (clientId && apiKey) ? new ImaClient(clientId, apiKey, this.debugConfig) : null;
	}

	async syncOnce(): Promise<void> {
		if (this.isSyncing) {
			new Notice('ima.copilot sync: 同步正在进行中，请稍候');
			return;
		}
		this.isSyncing = true;

		// 凭证仅私有同步需要；公共知识库同步无需凭证
		// Credentials only needed for private sync; public KB sync doesn't need them
		const { clientId, apiKey } = this.resolveCredentials();
		const hasCredentials = !!(clientId && apiKey);
		if (hasCredentials) {
			this.rebuildClient();
		}

		// 检查是否有任何同步任务可执行 / Check if any sync task is available
		const hasPrivateWork = this.settings.syncNotes || this.settings.syncKnowledgeBase;
		const hasSubscribedKBNeedingConversion = this.settings.publicKnowledgeBases.some(
			kb => !!kb.encryptedKbId && !kb.numericKbId && !kb.shareId,
		);
		const hasPublicWork = this.settings.publicKnowledgeBases.length > 0;
		if ((hasPrivateWork || hasSubscribedKBNeedingConversion) && !hasCredentials) {
			new Notice('ima.copilot sync: 私有同步需要 Client ID 和 API Key，请先在设置中填写');
			this.isSyncing = false;
			return;
		}
		if (!hasPrivateWork && !hasPublicWork) {
			new Notice('ima.copilot sync: 没有可执行的同步任务');
			this.isSyncing = false;
			return;
		}
		this.onSyncStateChange?.(true);
		new Notice('ima.copilot sync: 开始同步…');

		try {
			const syncedCount = await this.doSync();
			new Notice(`ima.copilot Sync: 同步完成，共同步 ${syncedCount} 篇笔记`);
		} catch (err) {
			console.error('ima.copilot Sync error:', err);
			new Notice(`ima.copilot Sync: 同步失败 — ${formatImaError(err)}`);
		} finally {
			this.isSyncing = false;
			this.onSyncStateChange?.(false);
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
			downloadImages: this.settings.downloadImages,
			imageSizeLimitBytes: this.calcSizeLimitBytes(this.settings.imageSizeLimit, this.settings.imageSizeLimitUnit),
			downloadFiles: this.settings.downloadFiles,
			fileSizeLimitBytes: this.calcSizeLimitBytes(this.settings.fileSizeLimit, this.settings.fileSizeLimitUnit),
			kbName,
			kbCategory,
			antiHotlinkEnhanced: this.settings.downloadEnhanced,
		};
	}

	private calcSizeLimitBytes(limit: number, unit: string): number {
		if (limit <= 0) return 0;
		const multipliers: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
		return Math.round(limit * (multipliers[unit] ?? 1));
	}

	/** 核心同步逻辑 / Core sync logic */
	private async doSync(): Promise<number> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const opts = this.buildAttachmentOptions();
		// 个人笔记的图片和文件强制下载到本地，避免 COS 签名 URL 约 8 小时过期
		// Force download images and files for personal notes to avoid expired COS signed URLs (~8h TTL)
		opts.downloadImages = true;
		opts.downloadFiles = true;

		await ensureFolder(this.vault, syncFolder);

		let syncedCount = 0;
			let authExpired = false;

		// ── 同步 IMA 笔记 / Sync IMA notes ──
		if (this.settings.syncNotes && this.client && !authExpired) {
			try {
			// 全量拉取，内存过滤增量（对齐知识库模式，一次请求同时服务增量+删除）
			// Fetch all notes, filter incrementally in memory (align with KB pattern, one request for both)
			const allNotes = await this.client.listAllNotes(0);
			const existingMap = this.scanExistingNoteFiles(syncFolder);

			// 删除同步：本地有 docid 但 API 已无 / Delete sync: local has docid but not in API
			const apiDocIds = new Set(allNotes.map(n => n.docid));
			for (const [docid, filePath] of existingMap) {
				if (!apiDocIds.has(docid)) {
					try {
						await this.handleDeletedItem(filePath, opts);
					} catch (err) {
						console.warn(`ima.copilot Sync: 笔记删除同步失败 / Note delete sync failed for ${filePath}:`, err);
					}
					existingMap.delete(docid);
				}
			}

			// 增量同步：新笔记，或上次同步后有修改的 / Incremental sync: new or modified since last sync
			for (const note of allNotes) {
				try {
					// modify_time 为毫秒级，lastSyncTime 为毫秒级 / modify_time is ms, lastSyncTime is also ms
					if (existingMap.has(note.docid) && note.modify_time <= this.settings.lastSyncTime) continue;
					const filePath = this.resolveFilePath(syncFolder, note.title, note.docid);
					const rawContent = await this.client.getNoteContentMarkdown(note.docid);
					console.debug(`ima.copilot Sync: processing "${note.title}", hasFileTag=${rawContent.includes("<file")}`);
					const withFiles = await this.processInlineFileTags(rawContent, filePath, opts);
					const withImages = await this.imageHandler.processContent(withFiles, filePath, opts, note.title);
					const noteContent = `---\ndocid: "${note.docid}"\n---\n\n${escapeInlineHash(withImages)}`;
					await this.writeNote(filePath, noteContent, opts);
					syncedCount++;
				} catch (err) {
					console.warn(`ima.copilot Sync: 笔记 "${note.title}" 同步失败`, err);
				}
			}
			} catch (err) {
				if (isImaApiError(err, 200002)) {
					authExpired = true;
					new Notice(`ima.copilot Sync: ${formatImaError(err)}`);
				} else {
					console.warn('ima.copilot Sync: 个人笔记同步失败', err);
					new Notice(`ima.copilot Sync: 个人笔记同步失败 — ${formatImaError(err)}`);
				}
			}
		}

		// ── 同步个人知识库（多选）/ Sync personal knowledge bases (multi-select) ──
		if (this.settings.syncKnowledgeBase && this.client && !authExpired) {
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
								await this.handleDeletedItem(filePath, kbOpts);
							} catch (err) {
								console.warn(`ima.copilot Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
							}
							existingMap.delete(mediaId);
						}
					}

					// 增量同步 / Incremental sync
					for (const item of items) {
						try {
							if (existingMap.has(item.media_id)) continue;
						const filePath = this.resolveFilePath(kbFolder, item.title, item.media_id);
							const content = await this.syncKnowledgeItem(item, filePath, kbOpts);
							if (content !== null) {
								await this.writeNote(filePath, content, kbOpts);
								syncedCount++;
							}
						} catch (err) {
							console.warn(`ima.copilot Sync: 知识库条目 "${item.title}" 同步失败`, err);
						}
					}
					} catch (err) {
						if (isImaApiError(err, 200002)) {
							authExpired = true;
							new Notice(`ima.copilot Sync: ${formatImaError(err)}`);
							break;
						}
						console.warn(`ima.copilot Sync: 个人知识库 "${pkb.name}" 同步失败`, err);
						new Notice(`ima.copilot Sync: 个人知识库 "${pkb.name}" 同步失败 — ${formatImaError(err)}`);
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
					console.warn(`ima.copilot Sync: 公共知识库 "${pubKB.name}" 同步失败`, err);
					new Notice(`ima.copilot Sync: 公共知识库 "${pubKB.name}" 同步失败 — ${formatImaError(err)}`);
				}
			}
		}

		// ── 修复残留外链图片 / Fix leftover external image links ──
		await this.fixPendingImages(syncFolder, opts);

		// 仅私有同步未过期时更新时间戳，避免下次跳过需重试的条目
		// Only update timestamp when private sync didn't expire, avoid skipping items that need retry
		if (!authExpired) {
			this.settings.lastSyncTime = Date.now();
		}
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
		} else if (!numericKbId && pubKB.encryptedKbId && this.client) {
			// 订阅知识库：通过私有 API 获取根文件夹 ID，作为 cgi-bin 的 knowledge_base_id
			// Subscribed KB: get root folder_id via private API, use as knowledge_base_id for cgi-bin
			try {
				const folderId = await this.client.getKbFolderId(pubKB.encryptedKbId);
				if (folderId) {
					numericKbId = folderId;
					pubKB.numericKbId = numericKbId;
				}
			} catch (err) {
				if (isImaApiError(err, 200002)) {
					console.warn(`ima.copilot Sync: 订阅知识库 "${pubKB.name}" 跳过（API Key 已过期，无法转换 encryptedKbId）`);
					return 0;
				}
				throw err;
			}
		}

		// 获取所有条目 / Fetch all items
		const items = numericKbId
			? await this.publicClient.listAllPublicItems(numericKbId)
			: pubKB.shareId
				? await this.publicClient.listAllSharedItems(pubKB.shareId)
				: [];

		if (items.length === 0) {
			console.warn(`ima.copilot Sync: 公共知识库 "${pubKB.name}" 无条目或无法获取`);
			return 0;
		}

		// 检查解析进度，未完成则等待重试 / Check parse progress, retry if incomplete
		const PARSE_RETRY_MAX = 5;
		const PARSE_RETRY_DELAY_MS = 10000;
		for (let attempt = 0; attempt < PARSE_RETRY_MAX; attempt++) {
			const unready = items.filter(i => i.parse_progress < 100);
			if (unready.length === 0) break;

			console.debug(
				`ima.copilot Sync: ${unready.length} 个条目解析未完成，第 ${attempt + 1}/${PARSE_RETRY_MAX} 次重试等待...`,
				unready.map(i => i.title),
			);
			await new Promise(r => setTimeout(r, PARSE_RETRY_DELAY_MS));

			// 重新拉取全部条目以获取最新 parse_progress / Re-fetch all items for latest parse_progress
			const refreshedItems = numericKbId
				? await this.publicClient.listAllPublicItems(numericKbId)
				: pubKB.shareId
					? await this.publicClient.listAllSharedItems(pubKB.shareId)
					: [];

			const refreshedMap = new Map(refreshedItems.map(i => [i.media_id, i]));
			for (const item of unready) {
				const refreshed = refreshedMap.get(item.media_id);
				if (refreshed) {
					item.parse_progress = refreshed.parse_progress;
					item.raw_file_url = refreshed.raw_file_url;
					item.source_path = refreshed.source_path;
					item.abstract = refreshed.abstract;
					item.introduction = refreshed.introduction;
					item.summary_state = refreshed.summary_state;
				}
			}
		}

		// 解析未完成的条目只跳过创建，不参与删除同步（避免误删之前已同步的文件）
		// Parse-incomplete items skip creation only, NOT delete sync (avoid deleting previously synced files)
		const skippedItems = items.filter(i => i.parse_progress < 100);
		if (skippedItems.length > 0) {
			console.warn(
				`ima.copilot Sync: ${skippedItems.length} 个条目解析仍未完成，跳过创建：`,
				skippedItems.map(i => i.title),
			);
		}

		// 扫描已有文件 / Scan existing files
		const existingMap = this.scanExistingKbFiles(kbFolder);

		// 删除同步时包含未就绪条目，防止其被误删 / Include unready items in delete sync to prevent false deletion
		const apiMediaIds = new Set(items.map(i => i.media_id));

		// 从创建列表中移除未就绪条目 / Remove unready items from creation list
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i]!.parse_progress < 100) {
				items.splice(i, 1);
			}
		}
		for (const [mediaId, filePath] of existingMap) {
			if (!apiMediaIds.has(mediaId)) {
				try {
					await this.handleDeletedItem(filePath, opts);
				} catch (err) {
					console.warn(`ima.copilot Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
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
				// 防御路径穿越：确保最终路径在 kbFolder 下 / Guard against path traversal
				if (!itemFolder.startsWith(kbFolder + '/') && itemFolder !== kbFolder) {
					console.warn(`ima.copilot Sync: 拒绝路径穿越 / Path traversal blocked: ${item.folderPath}`);
					continue;
				}
				await ensureFolder(this.vault, itemFolder);
				const filePath = this.resolveFilePath(itemFolder, item.title, item.media_id);

				const content = await this.syncPublicKBItem(item, filePath, opts);
				if (content !== null) {
					await this.writeNote(filePath, content, opts);
					count++;
				}
			} catch (err) {
				console.warn(`ima.copilot Sync: 公共知识库条目 "${item.title}" 同步失败`, err);
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

		// 微信文章：统一走三层回退（#js_content → meta 提取 → defuddle 裸提取 → IMA 兜底），不区分长链短链
		// WeChat article: unified three-tier fallback (#js_content → meta → bare defuddle → IMA), no URL type distinction
		if (item.media_type === MEDIA_TYPE_WECHAT) {
			const url = item.raw_file_url || item.source_path;
			if (url && url.startsWith('http')) {
				const content = await this.syncWebContent(stripWeChatTrackingParams(url), undefined, item.title, item.media_id, convertWeChatHtmlToMarkdown);
				// 三层回退均失败时，使用 IMA 的 introduction/abstract 兜底
				// Fall back to IMA introduction/abstract when all three tiers fail
				return content;
			}
		}

		// 网页：source_path 有原始 URL → 抓全文
		// Webpage: source_path has original URL → fetch full content
		if (item.media_type === MEDIA_TYPE_WEBPAGE) {
			const url = item.source_path || item.raw_file_url;
			if (url && url.startsWith('http')) {
				return await this.syncWebContent(url, undefined, item.title, item.media_id);
			}
		}

		// 笔记：introduction 提供预览（约 300 字符截断）
		// Note: introduction provides preview (~300 chars truncated)
		if (item.media_type === MEDIA_TYPE_NOTE) {
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

	/** 生成友好的占位提示（统一文案）/ Build friendly placeholder text (unified copy) */
	private buildFriendlyPlaceholder(title: string, url: string, mediaId: string): string {
		return [
			`---`,
			`media_id: "${mediaId}"`,
			`---`,
			``,
			`> [!warning] 由于目标网站限制，无法获取完整内容`,
			`> `,
			`> **建议操作**：`,
			`> 1. 确保已开启 Obsidian 设置 → 核心插件 → **网页浏览器**`,
			`> 2. 点击 [原文链接](${url})，在 Obsidian 内置浏览器中打开`,
			`> 3. 点击右上角菜单 → **「保存到仓库」**`,
			`> `,
			`> 也可以使用浏览器扩展 [Web Clipper](https://obsidian.md/clipper) 保存`,
			``,
			`**标题**: ${title}`,
			``,
			`**原文链接**: [${url}](${url})`,
		].join('\n');
	}

	/**
	 * 扫描知识库文件夹下已有 .md 文件，从 metadataCache 提取 media_id（零 I/O）
	 * Scan existing KB .md files, extract media_id from metadataCache (zero I/O)
	 */
		// vault.getFiles() 用于增量同步：仅扫描 vault 中 .md 文件路径做存在性判断，不读取文件内容
	// vault.getFiles() for incremental sync: only scans .md file paths for existence check, does not read file content
	private scanExistingKbFiles(kbFolder: string): Map<string, string> {
		const map = new Map<string, string>();
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(kbFolder + '/'),
		);

		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const mediaId = (cache?.frontmatter as Record<string, unknown>)?.['media_id'];
			if (typeof mediaId === 'string') {
				map.set(mediaId, file.path);
			}
		}

		return map;
	}

	/**
	 * 扫描 syncFolder 根目录下已有 .md 文件，从 metadataCache 提取 docid（零 I/O）
	 * Scan existing note .md files in syncFolder root, extract docid from metadataCache (zero I/O)
	 */
		// vault.getFiles() 用于增量同步：仅扫描 syncFolder 根目录 .md 文件，判断 docid 是否已同步
	// vault.getFiles() for incremental sync: scans syncFolder root .md files to check if docid already synced
	private scanExistingNoteFiles(syncFolder: string): Map<string, string> {
		const map = new Map<string, string>();
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' &&
			f.path.startsWith(syncFolder + '/') &&
			!f.path.slice(syncFolder.length + 1).includes('/'),
		);

		for (const file of mdFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			const docid = (cache?.frontmatter as Record<string, unknown>)?.['docid'];
			if (typeof docid === 'string') {
				map.set(docid, file.path);
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
			await this.app.fileManager.trashFile(file);
			console.debug(`ima.copilot Sync: 删除已移除条目 / Deleted removed item: ${filePath}`);
		} else if (mode === 'mark-deleted') {
			if (filePath.includes('[deleted]')) return;
			const newFilePath = filePath.replace(/\.md$/, ' [deleted].md');
			try {
				await this.vault.adapter.rename(filePath, newFilePath);
			} catch (renameErr) {
				console.warn(`ima.copilot Sync: 标记删除重命名失败 / Mark-deleted rename failed: ${filePath}`, renameErr);
				return;
			}
			const renamedFile = this.vault.getFileByPath(newFilePath);
			if (renamedFile instanceof TFile) {
				const content = await this.vault.read(renamedFile);
				const updated = this.prependFrontmatterField(content, 'sync_status', 'deleted');
				await this.vault.modify(renamedFile, updated);
			}
			console.debug(`ima.copilot Sync: 标记已删除条目 / Marked deleted item: ${newFilePath}`);
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

			if (mediaInfo.media_type === MEDIA_TYPE_NOTE && mediaInfo.notebook_ext_info?.notebook_id) {
				const notebookId = mediaInfo.notebook_ext_info.notebook_id;
				const mdContent = await this.client!.getNoteContentMarkdown(notebookId);
				const withImages = await this.imageHandler.processContent(mdContent, filePath, opts, item.title);
				return this.prependFrontmatterField(escapeInlineHash(withImages), 'media_id', item.media_id);
			}

			if (mediaInfo.url_info?.url) {
				const { url, headers } = mediaInfo.url_info;
				return await this.syncByMediaType(item.media_type, { url, headers, title: item.title, filePath, opts, mediaId: item.media_id });
			}

			// 文件类型无 url_info 时重试（解析可能未完成），非文件类型直接 fallback
			// File types retry when url_info is missing (parsing may be incomplete), non-file types fallback directly
			if (FILE_MEDIA_TYPES.has(item.media_type)) {
				const FILE_RETRY_MAX = 5;
				const FILE_RETRY_DELAY_MS = 10000;
				for (let attempt = 0; attempt < FILE_RETRY_MAX; attempt++) {
					console.debug(
						`ima.copilot Sync: get_media_info url_info 为空，第 ${attempt + 1}/${FILE_RETRY_MAX} 次重试: ${item.title}`,
					);
					await new Promise(r => setTimeout(r, FILE_RETRY_DELAY_MS));
					try {
						const retryInfo = await this.client!.getMediaInfo(item.media_id);
						if (retryInfo.url_info?.url) {
							const { url, headers } = retryInfo.url_info;
							return await this.syncByMediaType(item.media_type, { url, headers, title: item.title, filePath, opts, mediaId: item.media_id });
						}
					} catch (retryErr) {
						console.warn(`ima.copilot Sync: get_media_info 重试失败: ${item.title}`, retryErr);
					}
				}
				// 重试耗尽，跳过不创建文件，下次同步自动重试
				// Retries exhausted, skip without creating file, will retry on next sync
				console.warn(`ima.copilot Sync: get_media_info 重试 ${FILE_RETRY_MAX} 次后仍无 url_info，跳过: ${item.title}`);
				return null;
			}

			return this.buildPlaceholder(item);
		} catch (err) {
			console.warn(`ima.copilot Sync: get_media_info 失败，使用占位符 / get_media_info failed, using placeholder: ${item.media_id}`, err);
			return this.buildPlaceholder(item);
		}
	}

	/**
	 * 在 frontmatter 中插入一个字段（若已有 frontmatter 则合并，否则新建）
	 * Insert a field into frontmatter (merge if exists, create if not)
	 */
	private prependFrontmatterField(content: string, key: string, value: string): string {
		if (content.startsWith('---')) {
			// 逐行扫描找结束 ---，避免值内含 --- 误判
			// Line-by-line scan for closing ---, avoiding false match on --- inside values
			const lines = content.split('\n');
			let fmDelimiterCount = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i]?.trim() === '---') {
					fmDelimiterCount++;
					if (fmDelimiterCount === 2) {
						const before = lines.slice(0, i).join('\n');
						const after = lines.slice(i).join('\n');
						return before + `\n${key}: "${value}"\n` + after;
					}
				}
			}
		}
		return `---\n${key}: "${value}"\n---\n\n${content}`;
	}
	private async syncByMediaType(
		mediaType: number,
		params: SyncMediaParams,
	): Promise<string> {
		if (FETCHABLE_MEDIA_TYPES.has(mediaType)) {
			const conv = mediaType === MEDIA_TYPE_WECHAT ? convertWeChatHtmlToMarkdown : undefined;
			return await this.syncWebContent(params.url, params.headers, params.title, params.mediaId, conv);
		}

		if (mediaType === MEDIA_TYPE_IMAGE) {
			return await this.syncFileDownload(params.url, params.headers, params.title, params.filePath, params.opts, true, params.mediaId);
		}

		if (FILE_MEDIA_TYPES.has(mediaType)) {
			return await this.syncFileDownload(params.url, params.headers, params.title, params.filePath, params.opts, false, params.mediaId);
		}

		return this.buildPlaceholder({ media_id: params.mediaId, title: params.title, parent_folder_id: '', media_type: mediaType });
	}

	/**
	 * 抓取网页内容并转为 Markdown（含 YAML frontmatter）
	 * Fetch webpage content and convert to Markdown (with YAML frontmatter)
	 */
	/**
	 * 尝试 headless BrowserWindow 提取并转换 / Try headless BrowserWindow extraction and conversion
	 * @returns 成功返回 { html, result }，失败返回 null
	 */
	private async tryHeadlessExtraction(
		url: string,
		converter: (html: string, url: string) => HtmlToMdResult,
	): Promise<{ html: string; result: HtmlToMdResult } | null> {
		const renderedHtml = await this.headlessExtractor.extractRenderedHtml(url);
		if (!renderedHtml || !HeadlessExtractor.hasWeChatContent(renderedHtml)) return null;
		const headlessResult = converter(renderedHtml, url);
		if (!headlessResult.content || headlessResult.fromMeta) return null;
		return { html: renderedHtml, result: headlessResult };
	}

	private async syncWebContent(
		url: string,
		headers: Record<string, string> | undefined,
		title: string,
		mediaId: string,
		wechatConverter?: (html: string, url: string) => HtmlToMdResult,
	): Promise<string> {
		try {
			// 构建基础请求头（requestUrl 不支持自定义 UA/Referer，会被 Chromium 安全策略剥离）
			// Build base headers (requestUrl cannot send custom UA/Referer — stripped by Chromium security policy)
			const baseHeaders: Record<string, string> = {
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...headers,
			};

			let html: string;
			try {
				// 首选 requestUrl / Try requestUrl first
				const response = await requestUrl({
					url,
					method: 'GET',
					headers: baseHeaders,
					throw: false,
				});

				if (response.status >= 400) {
					throw new Error(`HTTP ${response.status}`);
				}

				html = response.text;
			} catch (requestUrlErr) {
				// requestUrl 失败，检查防盗链增强开关
				// requestUrl failed, check anti-hotlink enhanced flag
				if (!this.settings.downloadEnhanced) {
					throw requestUrlErr;
				}

				const requestUrlMsg = requestUrlErr instanceof Error ? requestUrlErr.message : String(requestUrlErr);
				console.warn(`ima.copilot Sync: requestUrl 网页获取失败，尝试 Node.js 兜底 / requestUrl web fetch failed, trying Node.js fallback: ${requestUrlMsg}`);

				// Node.js https 可可靠发送自定义 UA/Referer，设置 Chrome UA 绕过防盗链
				// Node.js https can reliably send custom UA/Referer, set Chrome UA to bypass anti-hotlink
				const nodeHeaders: Record<string, string> = {
					'User-Agent': CHROME_UA,
					...baseHeaders,
				};
				html = await this.fileDownloader.fetchHtmlViaNodeHttps(url, nodeHeaders);
			}

			const result = wechatConverter
				? wechatConverter(html, url)
				: convertHtmlToMarkdown(html, { url });

			const frontmatter = this.buildWebFrontmatter(url, result.author, result.published, mediaId, result.authorUrl);

			const parts: string[] = [frontmatter];
			const effectiveTitle = result.title || title;
			if (effectiveTitle) {
				parts.push(`# ${effectiveTitle}\n`);
			}
			// 微信 URL 未获取到完整内容 → 尝试 Tier 4 headless BrowserWindow 回退
			// WeChat URL didn't get full content → try Tier 4 headless BrowserWindow fallback
			const contentTooShort = result.content && result.content.trim().length < 120;
			// HTML 含 <img> 但提取结果中无 Markdown 图片 → 图片丢失，需 headless
			// HTML has <img> tags but extracted Markdown has no images → images lost, need headless
			const htmlHasMmBizImgs = /<img[^>]+src=["']https?:\/\/[^"']+mmbiz[^"']*["']/i.test(html);
			const mdHasImages = /!\[.*\]\(https?:\/\//.test(result.content || '');
			// 静态 HTML 有图但 Markdown 没图 / Static HTML has images but Markdown doesn't
			const hasOrphanImages = htmlHasMmBizImgs && !mdHasImages;
			// 静态 HTML 很大（>500KB JS）但提取内容很短（<2000 chars）→ JS 渲染页面，headless 可能有更多内容
			// Large static HTML (>500KB JS) but short extracted content (<2000 chars) → JS-rendered page, headless may yield more
			const looksLikeJsPage = html.length > 500_000 && (result.content?.trim().length || 0) < 2000;
			if (wechatConverter && (result.fromMeta || !HeadlessExtractor.hasWeChatContent(html) || contentTooShort || hasOrphanImages || looksLikeJsPage)) {
				let headlessSucceeded = false;
				if (this.settings.downloadEnhanced) {
					const headless = await this.tryHeadlessExtraction(url, wechatConverter);
					if (headless) {
						html = headless.html;
						result.content = headless.result.content;
						result.title = headless.result.title || result.title;
						result.author = headless.result.author || result.author;
						result.fromMeta = false;
						parts.length = 0;
						parts.push(this.buildWebFrontmatter(url, result.author, result.published, mediaId, result.authorUrl));
						const hdTitle = result.title || title;
						if (hdTitle) {
							parts.push(`# ${hdTitle}\n`);
						}
						headlessSucceeded = true;
					}
				}
				if (!headlessSucceeded) {
						parts.push(
						`> [!warning] 由于目标网站限制，无法获取完整内容`,
						`> `,
						`> **建议操作**：`,
						`> 1. 确保已开启 Obsidian 设置 → 核心插件 → **网页浏览器**`,
						`> 2. 点击 [原文链接](${url})，在 Obsidian 内置浏览器中打开`,
						`> 3. 点击右上角菜单 → **「保存到仓库」**`,
						`> `,
						`> 也可以使用浏览器扩展 [Web Clipper](https://obsidian.md/clipper) 保存`,
						`\n`,
					);
				}
			}
			if (result.content) {
				parts.push(result.content);
			} else {
				parts.push(`> 无法提取网页正文，请访问原文：[链接](${url})`);
			}
			return escapeInlineHash(parts.join('\n'));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`ima.copilot Sync: All static extraction failed for "${title}": ${msg}`);

				// 尝试 headless 作为最后手段 / Attempt headless as last resort
				if (this.settings.downloadEnhanced) {
					try {
						const headless = await this.tryHeadlessExtraction(url, convertWeChatHtmlToMarkdown);
						if (headless) {
							const frontmatter = this.buildWebFrontmatter(url, headless.result.author, headless.result.published, mediaId, headless.result.authorUrl);
							const hdParts: string[] = [frontmatter];
							const hdTitle = headless.result.title || title;
							if (hdTitle) {
								hdParts.push(`# ${hdTitle}\n`);
							}
							hdParts.push(headless.result.content);
							return escapeInlineHash(hdParts.join('\n'));
						}
					} catch (headlessErr) {
						console.warn(`ima.copilot Sync: Headless extraction also failed for "${title}":`, headlessErr);
					}
				}

				return this.buildFriendlyPlaceholder(title, url, mediaId);
			}
	}

	/**
	 * 构建网页条目的 YAML frontmatter
	 * Build YAML frontmatter for web content items
	 */
	private buildWebFrontmatter(source: string, author: string, published: string, mediaId: string, authorUrl?: string): string {
		const lines: string[] = ['---'];
		lines.push(`source: "${source}"`);
		lines.push(`media_id: "${mediaId}"`);

		if (author) {
			lines.push('author:');
			if (authorUrl) {
				// 有 URL → Markdown 链接 / Has URL → Markdown link
				lines.push(`  - "[${author}](${authorUrl})"`);
			} else {
				// 无 URL → 纯文本 / No URL → plain text
				lines.push(`  - "${author}"`);
			}
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
			return date.toISOString().slice(0, 19);
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

		if (isImage ? !opts.downloadImages : !opts.downloadFiles) {
			if (isImage) {
				return `${fm}![${title}](${url})`;
			}
			return `${fm}# ${title}\n\n[${title}](${url})`;
		}

		try {
			// 图片从 URL 提取扩展名（KB 图片标题可能无扩展名），非图片文件直接用标题（标题即原名）
			// Images extract extension from URL (KB image titles may lack ext), non-image files use title directly
			const filename = isImage
				? buildStableFilename(url, { titleBase: title, fallbackName: 'img', fallbackExt: '.png' })
				: sanitizeFilename(title);

			const result = await this.fileDownloader.downloadFile({
				url,
				headers,
				filename,
				noteFilePath: filePath,
				opts,
				isImage,
				antiHotlinkEnhanced: opts.antiHotlinkEnhanced,
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

	/**
	 * 处理 IMA 笔记中 <file> 标签格式的文件附件：调 get_media_info 获取下载 URL，
	 * 下载到附件目录，替换为本地 Markdown 链接
	 * Process <file> tag file attachments in IMA notes: get download URL via get_media_info,
	 * download to attachment dir, replace with local Markdown link
	 */
	private async processInlineFileTags(
		content: string,
		noteFilePath: string,
		opts: AttachmentOptions,
	): Promise<string> {
		if (!this.client) return content;
		const matches = [...content.matchAll(FILE_TAG_REGEX)];
		console.debug(`ima.copilot Sync: processInlineFileTags found ${matches.length} file tags`);
		if (matches.length === 0) return content;

		let result = content;
		for (const match of matches) {
			const attrStr = match[1];
			if (!attrStr) continue;
			const mediaId = this.extractAttr(attrStr, 'mediaId');
			if (!mediaId) continue;

			const filename = this.extractAttr(attrStr, 'filePath').split('/').pop() || 'file';
			const cleanFilename = sanitizeFilename(filename);

			try {
				const mediaInfo = await this.client.getMediaInfo(mediaId);
				const url = mediaInfo.url_info?.url;
				if (!url) continue;

				const download = await this.fileDownloader.downloadFile({
					url,
					filename: cleanFilename,
					noteFilePath,
					opts,
					isImage: false,
					antiHotlinkEnhanced: opts.antiHotlinkEnhanced,
				});

				if (download.linkText) {
					result = result.replace(match[0], download.linkText);
				}
			} catch (err) {
				console.warn(
					`ima.copilot Sync: 文件附件下载失败 / File attachment download failed: ${cleanFilename} (${mediaId})`,
					err,
				);
			}
		}

		return result;
	}

	/** 从 HTML/XML 属性字符串中提取指定属性的值 / Extract attribute value from HTML/XML attribute string */
	private extractAttr(attrStr: string, name: string): string {
		const match = attrStr.match(new RegExp(`${name}="([^"]*)"`));
		return match?.[1] ?? '';
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
		if (!opts.downloadImages && !opts.downloadFiles) return;

		// vault.getFiles() 扫描所有已同步 .md 文件以修复残留外链图片，不读取文件内容
		// vault.getFiles() scans all synced .md files to fix leftover external image links, does not read content
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/'),
		);

		for (const file of mdFiles) {
			try {
				const content = await this.vault.read(file);
				if (!content.match(/!\[[^\]]*\]\(https?:\/\//)) continue;

				// 按文件所在路径推断知识库分类/名称，确保图片存入正确附件子目录
				// Infer KB category/name from file path so images land in the correct attachment subdirectory
				const fileOpts = this.inferOptsFromFilePath(file.path, opts);

				// 若笔记有 docid 且认证客户端可用，重新拉 Markdown 获取新鲜图片 URL（避免 COS 临时链接过期）
				// If note has docid and auth client is available, re-fetch Markdown for fresh image URLs (avoids expired COS signed URLs)
				const cache = this.app.metadataCache.getFileCache(file);
				const docid = (cache?.frontmatter as Record<string, unknown>)?.['docid'];

				let fixed = content;
				if (typeof docid === 'string' && this.client) {
					try {
						const freshMd = await this.client.getNoteContentMarkdown(docid);
						const withImages = await this.imageHandler.processContent(freshMd, file.path, fileOpts, file.basename);
						fixed = `---\ndocid: "${docid}"\n---\n\n${withImages}`;
					} catch (err) {
						console.warn(`ima.copilot Sync: 重新获取笔记内容失败，降级修复现有外链 / Re-fetch failed, falling back for ${file.path}:`, err);
					}
				}
				if (fixed === content) {
					fixed = await this.imageHandler.processContent(content, file.path, fileOpts, file.basename);
				}

				if (fixed !== content) {
					await this.vault.modify(file, fixed);
				}
			} catch (err) {
				console.warn(`ima.copilot Sync: 修复图片链接失败 / Failed to fix image links in ${file.path}:`, err);
			}
		}
	}

	/**
	 * 根据文件路径推断其所属知识库分类和名称，返回含正确 kbCategory/kbName 的 opts
	 * 路径规则：{syncFolder}/{kbCategory}/{kbName}/xxx.md → kbCategory, kbName
	 * Infer KB category and name from file path, return opts with correct kbCategory/kbName
	 * Path rule: {syncFolder}/{kbCategory}/{kbName}/xxx.md → kbCategory, kbName
	 */
	private inferOptsFromFilePath(filePath: string, baseOpts: AttachmentOptions): AttachmentOptions {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const prefix = syncFolder + '/';
		if (!filePath.startsWith(prefix)) return baseOpts;

		const relative = filePath.slice(prefix.length);
		const parts = relative.split('/');
		// 根目录笔记（单段）或二级目录（知识库直接根目录文件）均无 kbName
		// Root notes (1 segment) or files directly in category dir (2 segments) have no kbName
		if (parts.length < 3) return baseOpts;

		const kbCategory = parts[0];
		const kbName = parts[1];
		return { ...baseOpts, kbCategory, kbName };
	}

	/**
	 * 写入或更新笔记文件，更新后清理孤儿图片
	 * Write or update note file, then clean up orphan images
	 */
	/**
	 * 解析唯一文件路径，避免同名标题笔记互相覆盖
	 * Resolve unique file path to prevent same-title notes from overwriting each other
	 */
	private resolveFilePath(dir: string, title: string, uniqueId: string, ext = 'md'): string {
		const base = sanitizeFilename(title || uniqueId);
		let filePath = normalizePath(`${dir}/${base}.${ext}`);

		// 文件已存在且 media_id 不同 → 追加短标识 / File exists with different media_id → append short id
		const existing = this.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			const shortId = uniqueId.replace(/\W+/g, '_').slice(-12);
			filePath = normalizePath(`${dir}/${base}-${shortId}.${ext}`);
		}
		return filePath;
	}

	private async writeNote(filePath: string, content: string, opts: AttachmentOptions): Promise<void> {
		const existing = this.vault.getFileByPath(filePath);
		if (existing instanceof TFile) {
			const oldContent = await this.vault.read(existing);

			if (oldContent === content) return;

			const oldImagePaths = this.imageHandler.extractLocalImagePaths(oldContent, filePath, opts);
			const oldFilePaths = this.imageHandler.extractLocalFilePaths(oldContent, filePath, opts);
			const oldPaths = [...oldImagePaths, ...oldFilePaths];
			await this.vault.modify(existing, content);

			const newImagePaths = this.imageHandler.extractLocalImagePaths(content, filePath, opts);
			const newFilePaths = this.imageHandler.extractLocalFilePaths(content, filePath, opts);
			const newPaths = new Set([...newImagePaths, ...newFilePaths]);
			const orphans = oldPaths.filter(p => !newPaths.has(p));
			if (orphans.length > 0) {
				await this.cleanOrphanImages(orphans, filePath);
			}
		} else {
			await this.vault.create(filePath, content);
		}
	}

	/**
	 * 将指定的多个文件夹下的所有已同步文件移入系统回收站
	 * Move all synced files under the specified folders to system trash
	 */
	async deleteKbFolder(...folderPaths: string[]): Promise<void> {
		for (const folderPath of folderPaths) {
			await this.trashFolder(folderPath);
		}
	}

	/** 递归将一个文件夹下所有文件移入回收站，并删除空文件夹（含顶层） / Recursively trash all files under a folder and remove empty directories */
	private async trashFolder(folderPath: string): Promise<void> {
		const exists = await this.vault.adapter.exists(folderPath);
		if (!exists) return;

		const listing = await this.vault.adapter.list(folderPath);
		const allFiles: string[] = [...listing.files];
		const allFolders: string[] = [];

		// 递归收集子文件夹中的文件 / Recursively collect files in subfolders
		const queue = [...listing.folders];
		while (queue.length > 0) {
			const folder = queue.pop()!;
			allFolders.push(folder);
			try {
				const sub = await this.vault.adapter.list(folder);
				allFiles.push(...sub.files);
				queue.push(...sub.folders);
			} catch {
				// 忽略无法读取的子目录 / Ignore unreadable subdirectories
			}
		}

		for (const filePath of allFiles) {
			try {
				const file = this.vault.getFileByPath(filePath);
				if (file instanceof TFile) {
					await this.app.fileManager.trashFile(file);
				} else {
					await this.vault.adapter.remove(filePath);
				}
			} catch (err) {
				console.warn(`ima.copilot Sync: 移入回收站失败 / Failed to trash: ${filePath}`, err);
			}
		}

		// 从最深层到顶层依次删除空文件夹 / Remove empty folders from deepest to top
		const sortedFolders = allFolders.sort((a, b) => b.length - a.length);
		for (const folder of sortedFolders) {
			try {
				await this.vault.adapter.rmdir(folder, false);
			} catch {
				// 非空时忽略 / Ignore if not empty
			}
		}
		// 删除顶层知识库文件夹 / Remove the top-level KB folder itself
		try {
			await this.vault.adapter.rmdir(folderPath, false);
		} catch {
			// 非空时忽略 / Ignore if not empty
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
		// vault.getFiles() 扫描所有已同步 .md 文件以清理未被引用的孤儿图片，不读取文件内容
		// vault.getFiles() scans all synced .md files to clean unreferenced orphan images, does not read content
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
					console.debug(`ima.copilot Sync: 删除孤儿图片 / Removed orphan image: ${imgPath}`);
				}
			} catch (err) {
				console.warn(`ima.copilot Sync: 清理孤儿图片失败 / Failed to clean orphan image ${imgPath}:`, err);
			}
		}
	}

}

/**
 * 去除微信文章 URL 中的追踪参数，只保留 __biz/mid/idx/sn 四个核心参数
 * 带追踪参数的长链会被微信识别为非浏览器来源并触发人机验证
 * Strip WeChat article URL tracking params, keep only __biz/mid/idx/sn
 * Long URLs with tracking params trigger WeChat's bot verification
 */
function stripWeChatTrackingParams(url: string): string {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.endsWith('weixin.qq.com') && !parsed.hostname.endsWith('mp.weixin.qq.com')) {
			return url;
		}
		const keep = ['__biz', 'mid', 'idx', 'sn'];
		const cleaned = new URL('https://mp.weixin.qq.com/s');
		for (const key of keep) {
			const val = parsed.searchParams.get(key);
			if (val) cleaned.searchParams.set(key, val);
		}
		// 短链格式（/s/xxx）无参数，直接返回原 URL / Short link format (/s/xxx) has no params, return as-is
		if (cleaned.searchParams.toString() === '') return url;
		return cleaned.toString();
	} catch {
		return url;
	}
}
