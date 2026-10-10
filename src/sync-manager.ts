import { App, Platform, Vault, Notice, normalizePath, TFile, requestUrl } from 'obsidian';
import { ConfirmModal } from './settings';
import type { ImaPluginSettings } from './settings';
import { findDuplicateCopies } from './duplicate-cleanup';
import type { DuplicatePair } from './duplicate-cleanup';
import type { AttachmentOptions } from './path-utils';
import type { KnowledgeInfo, PublicKBItem, PublicKnowledgeBase } from './ima-client';
import { ImaClient, ImaPublicClient, formatImaError, isImaApiError, isRateLimitError } from './ima-client';
import { ImageHandler } from './image-handler';
import { convertHtmlToMarkdown, convertWeChatHtmlToMarkdown, convertXiaohongshuHtmlToMarkdown, convertZhihuHtmlToMarkdown, isXiaohongshuUrl } from './html-to-md';
import type { HtmlToMdResult } from './html-to-md';
import { FileDownloader } from './file-downloader';
import { sanitizeFilename, buildStableFilename, ensureFolder, escapeInlineHash, classifyUrl, extractFrontmatterValue, extractNoteBaseName, isSuffixedCopyName, listMdPathsInFolder, shortIdOf } from './path-utils';
import { buildHeaders } from './http-utils';
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

/** 同步标识字段名 / Frontmatter key holding the sync identifier */
type SyncIdKey = 'media_id' | 'docid';

/** 一个 id 可能对应多份本地文件（历史重复副本）/ One id may map to several local files (legacy duplicates) */
interface ExistingScan {
	/** 同步标识 → 本地路径（规范路径优先）/ Sync id → local paths (canonical path first) */
	byId: Map<string, string[]>;
	/** 扫描到的 .md 总数 / Total .md files scanned */
	mdCount: number;
	/** 其中靠读盘兜底才读到标识的数量 / How many ids needed the disk fallback */
	diskFallbackCount: number;
}

export class SyncManager {
	private client: ImaClient | null = null;
	private publicClient = new ImaPublicClient();
	private imageHandler: ImageHandler;
	private fileDownloader: FileDownloader;
	private isSyncing = false;
	private headlessExtractor: HeadlessExtractor;
	private debugConfig?: { adapter: import('obsidian').DataAdapter; path: string };
	/**
	 * 单轮同步内的附件引用索引：笔记路径 → 引用的附件文件名
	 * Per-run attachment reference index: note path → referenced attachment filenames
	 *
	 * metadataCache 未就绪时的读盘结果缓存，避免每次孤儿清理都全量读盘
	 * Caches disk-read results when metadataCache isn't ready, avoiding a full re-read per orphan cleanup
	 */
	private readonly refIndex = new Map<string, Set<string>>();

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
			new Notice('🐼 ima.copilot sync: 同步正在进行中，请稍候');
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
			new Notice('🐼 ima.copilot sync: 私有同步需要 Client ID 和 API key，请先在设置中填写');
			this.isSyncing = false;
			return;
		}
		if (!hasPrivateWork && !hasPublicWork) {
			new Notice('🐼 ima.copilot sync: 没有可执行的同步任务');
			this.isSyncing = false;
			return;
		}
		this.onSyncStateChange?.(true);
		new Notice('🐼 ima.copilot sync: 开始同步…');

		try {
			const syncedCount = await this.doSync();
			new Notice(`🐼 ima.copilot sync: 同步完成，共同步 ${syncedCount} 篇笔记`);
		} catch (err) {
			console.error('ima.copilot Sync error:', err);
			new Notice(`🐼 ima.copilot sync: 同步失败 — ${formatImaError(err)}`);
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

	private buildAttachmentOptions(): AttachmentOptions {
		return {
			linkFormat: this.settings.linkFormat,
			downloadImages: this.settings.downloadImages,
			imageSizeLimitBytes: this.calcSizeLimitBytes(this.settings.imageSizeLimit, this.settings.imageSizeLimitUnit),
			downloadFiles: this.settings.downloadFiles,
			fileSizeLimitBytes: this.calcSizeLimitBytes(this.settings.fileSizeLimit, this.settings.fileSizeLimitUnit),
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
		// 新的一轮同步：清空上一轮的附件引用缓存 / New sync run: clear the previous run's attachment reference cache
		this.refIndex.clear();
		// 个人笔记的图片和文件强制下载到本地，避免 COS 签名 URL 约 8 小时过期
		// Force download images and files for personal notes to avoid expired COS signed URLs (~8h TTL)
		opts.downloadImages = true;
		opts.downloadFiles = true;

		await ensureFolder(this.vault, syncFolder);

		let syncedCount = 0;
			let authExpired = false;
			// 限频时中断后续同步阶段，避免无效请求；剩余条目下次增量补齐
			// On rate-limit, skip later phases to avoid wasted requests; remaining items retry next sync
			let rateLimited = false;
			// 限频 Notice 只提示一次，避免刷屏 / Rate-limit Notice shown once to avoid spam
			let notifiedRateLimit = false;

		// ── 同步 IMA 笔记 / Sync IMA notes ──
		if (this.settings.syncNotes && this.client && !authExpired) {
			try {
			// 全量拉取，内存过滤增量（对齐知识库模式，一次请求同时服务增量+删除）
			// Fetch all notes, filter incrementally in memory (align with KB pattern, one request for both)
			const allNotes = await this.client.listAllNotes(0);
			const existingMap = await this.scanExistingNoteFiles(syncFolder);
			const skipCreation = this.isIndexSuspicious(existingMap, '个人笔记');

			// 删除同步：本地有 docid 但 API 已无 / Delete sync: local has docid but not in API
			const apiDocIds = new Set(allNotes.map(n => n.docid));
			for (const [docid, filePaths] of existingMap.byId) {
				if (!apiDocIds.has(docid)) {
					// 同一 docid 的历史副本一并回收 / Recycle every legacy copy of the same docid
					for (const filePath of filePaths) {
						try {
							await this.handleDeletedItem(filePath, opts);
						} catch (err) {
							console.warn(`ima.copilot Sync: 笔记删除同步失败 / Note delete sync failed for ${filePath}:`, err);
						}
					}
					existingMap.byId.delete(docid);
				}
			}

			// 增量同步：新笔记，或上次同步后有修改的 / Incremental sync: new or modified since last sync
			const notesToCreate = skipCreation ? [] : allNotes;
			for (const note of notesToCreate) {
				try {
					// modify_time 为毫秒级，lastSyncTime 为毫秒级 / modify_time is ms, lastSyncTime is also ms
					if (existingMap.byId.has(note.docid) && note.modify_time <= this.settings.lastSyncTime) continue;
					const filePath = await this.resolveFilePath(syncFolder, note.title, note.docid, 'docid');
					const rawContent = await this.client.getNoteContentMarkdown(note.docid);
					console.debug(`ima.copilot Sync: processing "${note.title}", hasFileTag=${rawContent.includes("<file")}`);
					const withFiles = await this.processInlineFileTags(rawContent, filePath, opts);
					// 图片命名基名 = 笔记最终文件名基名，与是否带 id 后缀保持一致
					// Image naming base = final note filename base, consistent with the id suffix
					const withImages = await this.imageHandler.processContent(withFiles, filePath, opts, extractNoteBaseName(filePath));
					const noteContent = `---\ndocid: "${note.docid}"\n---\n\n${escapeInlineHash(withImages)}`;
					await this.writeNote(filePath, noteContent, opts);
					syncedCount++;
				} catch (err) {
					// 限频时中断本次笔记循环，剩余笔记下次增量补齐；其他错误继续下一篇
					// On rate-limit, break note loop (remaining notes retry next sync); other errors continue
					if (isRateLimitError(err)) {
						rateLimited = true;
						if (!notifiedRateLimit) {
							new Notice(`ima.copilot Sync: 已同步 ${syncedCount} 篇，遇到限频，剩余下次补齐 — ${formatImaError(err)}`);
							notifiedRateLimit = true;
						}
						break;
					}
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
		if (this.settings.syncKnowledgeBase && this.client && !authExpired && !rateLimited) {
			for (const pkb of this.settings.personalKnowledgeBases) {
				const kbId = pkb.kbId.trim();
				if (!kbId) continue;
				try {
					const kbName = pkb.name;
					const kbOpts = this.buildAttachmentOptions();
					const kbFolder = normalizePath(`${syncFolder}/个人知识库/${sanitizeFilename(kbName || kbId)}`);
					await ensureFolder(this.vault, kbFolder);

					const existingMap = await this.scanExistingKbFiles(kbFolder);
					const items = await this.client.listAllKnowledgeItems(kbId);
					const skipCreation = this.isIndexSuspicious(existingMap, `知识库「${kbName}」`);

					// 删除同步 / Delete sync
					const apiMediaIds = new Set(items.map(i => i.media_id));
					for (const [mediaId, filePaths] of existingMap.byId) {
						if (!apiMediaIds.has(mediaId)) {
							// 同一 media_id 的历史副本一并回收 / Recycle every legacy copy of the same media_id
							for (const filePath of filePaths) {
								try {
									await this.handleDeletedItem(filePath, kbOpts);
								} catch (err) {
									console.warn(`ima.copilot Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
								}
							}
							existingMap.byId.delete(mediaId);
						}
					}

					// 增量同步 / Incremental sync
					const kbItemsToCreate = skipCreation ? [] : items;
					for (const item of kbItemsToCreate) {
						try {
							if (existingMap.byId.has(item.media_id)) continue;
							const itemFolder = item.folderPath
								? normalizePath(`${kbFolder}/${item.folderPath}`)
								: kbFolder;
							if (!itemFolder.startsWith(kbFolder + '/') && itemFolder !== kbFolder) {
								console.warn(`ima.copilot Sync: blocked unsafe folder path: ${item.folderPath}`);
								continue;
							}
							await ensureFolder(this.vault, itemFolder);
							const filePath = await this.resolveFilePath(itemFolder, item.title, item.media_id, 'media_id');
							const content = await this.syncKnowledgeItem(item, filePath, kbOpts);
							if (content !== null) {
								await this.writeNote(filePath, content, kbOpts);
								syncedCount++;
							}
						} catch (err) {
							// 限频时中断本次知识库循环，剩余条目下次增量补齐；其他错误继续下一条
							// On rate-limit, break KB loop (remaining items retry next sync); other errors continue
							if (isRateLimitError(err)) {
								rateLimited = true;
								if (!notifiedRateLimit) {
									new Notice(`ima.copilot Sync: 已同步 ${syncedCount} 篇，遇到限频，剩余下次补齐 — ${formatImaError(err)}`);
									notifiedRateLimit = true;
								}
								break;
							}
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
		if (this.settings.publicKnowledgeBases.length > 0 && !rateLimited) {
			for (const pubKB of this.settings.publicKnowledgeBases) {
				try {
					const count = await this.syncPublicKnowledgeBase(pubKB, this.buildAttachmentOptions());
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
			await new Promise(r => window.setTimeout(r, PARSE_RETRY_DELAY_MS));

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
		const existingMap = await this.scanExistingKbFiles(kbFolder);
		const skipCreation = this.isIndexSuspicious(existingMap, `公共知识库「${pubKB.name}」`);

		// 删除同步时包含未就绪条目，防止其被误删 / Include unready items in delete sync to prevent false deletion
		const apiMediaIds = new Set(items.map(i => i.media_id));

		// 从创建列表中移除未就绪条目 / Remove unready items from creation list
		for (let i = items.length - 1; i >= 0; i--) {
			if (items[i]!.parse_progress < 100) {
				items.splice(i, 1);
			}
		}
		for (const [mediaId, filePaths] of existingMap.byId) {
			if (!apiMediaIds.has(mediaId)) {
				// 同一 media_id 的历史副本一并回收 / Recycle every legacy copy of the same media_id
				for (const filePath of filePaths) {
					try {
						await this.handleDeletedItem(filePath, opts);
					} catch (err) {
						console.warn(`ima.copilot Sync: 删除同步失败 / Delete sync failed for ${filePath}:`, err);
					}
				}
				existingMap.byId.delete(mediaId);
			}
		}

		// 增量同步 / Incremental sync
		let count = 0;
		const pubItemsToCreate = skipCreation ? [] : items;
		for (const item of pubItemsToCreate) {
			try {
				if (existingMap.byId.has(item.media_id)) continue;

				const itemFolder = item.folderPath
					? normalizePath(`${kbFolder}/${item.folderPath}`)
					: kbFolder;
				// 防御路径穿越：确保最终路径在 kbFolder 下 / Guard against path traversal
				if (!itemFolder.startsWith(kbFolder + '/') && itemFolder !== kbFolder) {
					console.warn(`ima.copilot Sync: 拒绝路径穿越 / Path traversal blocked: ${item.folderPath}`);
					continue;
				}
				await ensureFolder(this.vault, itemFolder);
				const filePath = await this.resolveFilePath(itemFolder, item.title, item.media_id, 'media_id');

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

	/** 生成友好的占位提示（统一文案）/ Build friendly placeholder text (unified copy)
	 * @param reason 'need-desktop' = 移动端或 downloadEnhanced 关闭；'headless-failed' = 桌面端 headless 也失败 */
	private buildFriendlyPlaceholder(title: string, url: string, mediaId: string, reason?: 'need-desktop' | 'headless-failed'): string {
		const messageLines = reason === 'need-desktop'
			? [
				`> [!warning] 此内容需要桌面端配合「下载增强」功能获取`,
				`> `,
				`> **建议操作**：`,
				`> 1. 请切换到桌面端 Obsidian`,
				`> 2. 删除此文件，使用本插件重新同步`,
				`> 3. 确认已开启插件设置中的「下载增强」`,
			]
			: [
				`> [!warning] 由于目标网站限制，无法获取完整内容`,
				`> `,
				`> **建议操作**：`,
				`> 1. 确认已开启插件设置中的「下载增强」`,
				`> 2. 确保已开启 Obsidian 设置 → 核心插件 → **网页浏览器**`,
				`> 3. 点击 [原文链接](${url})，在 Obsidian 内置浏览器中打开`,
				`> 4. 点击右上角菜单 → **「保存到仓库」**`,
				`> `,
				`> 也可以使用浏览器扩展 [Web Clipper](https://obsidian.md/clipper) 保存`,
			];
		return [
			`---`,
			`media_id: "${mediaId}"`,
			`---`,
			``,
			...messageLines,
			``,
			`**标题**: ${title}`,
			``,
			`**原文链接**: [${url}](${url})`,
		].join('\n');
	}

	/**
	 * 读取某文件的同步标识：metadataCache 优先，未命中则读盘解析 frontmatter
	 * Read a file's sync id: metadataCache first, falling back to parsing frontmatter from disk
	 *
	 * 读盘兜底是幂等性的关键：Obsidian 刚启动/大库重建索引时 cache 可能为空，
	 * 只依赖 cache 会把已同步条目误判为新条目并重复落盘
	 * The disk fallback is what makes syncing idempotent: right after startup (or while a large
	 * vault is still being indexed) the cache can be empty, and a cache-only check would treat
	 * already-synced items as new and write duplicates
	 */
	private async readFrontmatterId(path: string, key: SyncIdKey): Promise<string | null> {
		const cache = this.app.metadataCache.getCache(path);
		const cached = (cache?.frontmatter as Record<string, unknown>)?.[key];
		if (typeof cached === 'string' && cached.length > 0) return cached;

		try {
			const content = await this.vault.adapter.read(path);
			return extractFrontmatterValue(content, key);
		} catch (err) {
			console.warn(`ima.copilot Sync: 读取 frontmatter 失败 / Failed to read frontmatter: ${path}`, err);
			return null;
		}
	}

	/**
	 * 汇总已同步条目的同步标识（缓存优先 + 读盘兜底）
	 * Collect sync ids of already-synced items (cache first, disk fallback)
	 */
	private async collectExistingIds(paths: string[], key: SyncIdKey): Promise<ExistingScan> {
		const byId = new Map<string, string[]>();
		let diskFallbackCount = 0;

		for (const path of paths) {
			const cache = this.app.metadataCache.getCache(path);
			const cached = (cache?.frontmatter as Record<string, unknown>)?.[key];
			let id: string | null = (typeof cached === 'string' && cached.length > 0) ? cached : null;

			if (id === null) {
				id = await this.readFrontmatterId(path, key);
				if (id !== null) diskFallbackCount++;
			}
			if (id === null) continue;

			const existing = byId.get(id);
			if (existing) {
				existing.push(path);
			} else {
				byId.set(id, [path]);
			}
		}

		// 同一 id 多份文件时规范路径优先（无 -<短标识> 后缀者排前）
		// When one id has several files, put the canonical path first (no "-<short id>" suffix)
		for (const [id, filePaths] of byId) {
			if (filePaths.length > 1) {
				filePaths.sort((a, b) =>
					Number(isSuffixedCopyName(extractNoteBaseName(a), id)) - Number(isSuffixedCopyName(extractNoteBaseName(b), id)),
				);
			}
		}

		if (diskFallbackCount > 0) {
			console.debug(`ima.copilot Sync: 已同步标识 ${byId.size} 个，其中 ${diskFallbackCount} 个靠读盘兜底（metadataCache 未就绪）`);
		}

		return { byId, mdCount: paths.length, diskFallbackCount };
	}

	/**
	 * 空索引保护：本地已有若干笔记却读不到任何同步标识时，跳过创建以免重复落盘
	 * Empty-index guard: when local notes exist but no sync id can be read, skip creation to avoid duplicates
	 */
	private isIndexSuspicious(scan: ExistingScan, label: string): boolean {
		if (scan.mdCount < 5 || scan.byId.size > 0) return false;

		console.warn(`ima.copilot Sync: ${label} 已有 ${scan.mdCount} 篇笔记但未识别到任何同步标识，跳过创建以免重复落盘`);
		new Notice(`🐼 ima.copilot sync: ${label} 已有 ${scan.mdCount} 篇笔记但读不到同步标识，已跳过创建以免重复落盘`);
		return true;
	}

	/**
	 * 扫描知识库文件夹下已有 .md 文件，提取 media_id（缓存优先 + 读盘兜底）
	 * Scan existing KB .md files, extract media_id (cache first, disk fallback)
	 */
	private async scanExistingKbFiles(kbFolder: string): Promise<ExistingScan> {
		return this.collectExistingIds(await listMdPathsInFolder(this.vault, kbFolder), 'media_id');
	}

	/**
	 * 扫描 syncFolder 根目录下已有 .md 文件，提取 docid（缓存优先 + 读盘兜底）
	 * Scan existing note .md files in syncFolder root, extract docid (cache first, disk fallback)
	 */
	private async scanExistingNoteFiles(syncFolder: string): Promise<ExistingScan> {
		const paths: string[] = [];
		// 只取根层 .md 文件（不含子文件夹）/ Only root-level .md files (exclude subfolders)
		try {
			const listed = await this.vault.adapter.list(syncFolder);
			for (const file of listed.files) {
				if (!file.endsWith('.md')) continue;
				paths.push(normalizePath(file)); // adapter.list() returns vault-relative path / vault 完整路径
			}
		} catch {
			// 文件夹不存在时返回空结果 / Return an empty result if folder doesn't exist
		}

		return this.collectExistingIds(paths, 'docid');
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
				// 图片命名基名 = 笔记最终文件名基名，与是否带 id 后缀保持一致
				// Image naming base = final note filename base, consistent with the id suffix
				const withImages = await this.imageHandler.processContent(mdContent, filePath, opts, extractNoteBaseName(filePath));
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
					await new Promise(r => window.setTimeout(r, FILE_RETRY_DELAY_MS));
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
			// 限频错误重新抛出，由 doSync 内层 catch 中断循环（避免 N×130s 卡死与 N 个兜底文件）
			// 不写兜底文件 → 下次同步该条目本地不存在 → 增量逻辑自动重新获取
			// Rate-limit re-thrown so doSync's inner catch breaks the loop (avoid N×130s stall and N placeholders)
			// No placeholder written → next sync finds item absent locally → incremental logic re-fetches it
			if (isRateLimitError(err)) {
				throw err;
			}
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
			const isXhs = isXiaohongshuUrl(params.url);
			const siteClass = classifyUrl(params.url);
			const isZhihu = siteClass === 'zhihu';
			const conv = mediaType === MEDIA_TYPE_WECHAT ? convertWeChatHtmlToMarkdown
				: isXhs ? convertXiaohongshuHtmlToMarkdown
				: isZhihu ? convertZhihuHtmlToMarkdown
				: undefined;
			const result = await this.syncWebContent(params.url, params.headers, params.title, params.mediaId, conv);
			return result;
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
		options?: { isWeChat?: boolean },
	): Promise<{ html: string; result: HtmlToMdResult } | null> {
		const renderedHtml = await this.headlessExtractor.extractRenderedHtml(url);
		if (!renderedHtml) return null;

		// 验证码检测 / Captcha detection
		if (HeadlessExtractor.hasCaptcha(renderedHtml)) return null;

		// 内容有效性检查：微信用 hasWeChatContent，通用用 hasValidContent
		// Content validity check: WeChat uses hasWeChatContent, generic uses hasValidContent
		const hasContent = options?.isWeChat
			? HeadlessExtractor.hasWeChatContent(renderedHtml)
			: HeadlessExtractor.hasValidContent(renderedHtml);
		if (!hasContent) return null;

		const headlessResult = converter(renderedHtml, url);
		if (!headlessResult.content) return null;
		// 微信 meta 提取（Tier 3 回退）内容质量不可靠，拒绝 / WeChat meta-extracted content (Tier 3) is unreliable, reject
		if (options?.isWeChat && headlessResult.fromMeta) return null;

		return { html: renderedHtml, result: headlessResult };
	}

	private async syncWebContent(
		url: string,
		headers: Record<string, string> | undefined,
		title: string,
		mediaId: string,
		wechatConverter?: (html: string, url: string) => HtmlToMdResult,
	): Promise<string> {
		let headlessTried = false;
		const siteClass = classifyUrl(url);
		const isWeChatPage = siteClass === 'wechat';
		try {
			// 构建基础请求头（requestUrl 不支持自定义 UA/Referer，会被 Chromium 安全策略剥离）
			// Build base headers (requestUrl cannot send custom UA/Referer — stripped by Chromium security policy)
			const baseHeaders: Record<string, string> = {
				'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				...headers,
			};

			let html: string;
			// 微信 + downloadEnhanced：跳过 Node.js，直接 headless（微信是 Vue SPA，Node.js 拿到的是空壳）
			// WeChat + downloadEnhanced: skip Node.js, go straight to headless (WeChat is Vue SPA, Node.js gets empty shell)
			// 参考 Share to Save: downloader.ts:69-71, 293-295
			// 知乎 + downloadEnhanced：跳过 requestUrl/Node.js，直接 headless（知乎反爬严格，HTTP 请求必然失败）
			// Zhihu + downloadEnhanced: skip requestUrl/Node.js, go straight to headless (Zhihu anti-bot is strict, HTTP requests always fail)
			if (siteClass === 'zhihu' && this.settings.downloadEnhanced) {
				const zhihuHtml = await this.headlessExtractor.extractRenderedHtml(url);
				if (zhihuHtml && HeadlessExtractor.hasValidContent(zhihuHtml) && !HeadlessExtractor.hasCaptcha(zhihuHtml)) {
					headlessTried = true;
					html = zhihuHtml;
				} else {
					// headless 失败时给占位符，不浪费时间去试 requestUrl
					// When headless fails, use placeholder directly instead of wasting time on requestUrl
					return this.buildFriendlyPlaceholder(title, url, mediaId,
						this.settings.downloadEnhanced ? 'headless-failed' : 'need-desktop');
				}
			} else if (wechatConverter && isWeChatPage && this.settings.downloadEnhanced) {
				const headlessHtml = await this.headlessExtractor.extractRenderedHtml(url);
				if (headlessHtml && HeadlessExtractor.hasWeChatContent(headlessHtml)) {
					headlessTried = true;
					html = headlessHtml;
					// 直接跳到转换阶段，跳过后续的 headless 回退
					// Skip to conversion phase, bypass subsequent headless fallback
				} else {
					// headless 失败 → 降级到 Node.js 兜底
					// headless failed → fallback to Node.js
					console.warn(`ima.copilot Sync: Headless 提取失败，降级到 Node.js / Headless failed, falling back to Node.js: ${url}`);
					const nodeHeaders = buildHeaders(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
					// IMA headers（来自 get_media_info）覆盖 buildHeaders 默认值 / IMA headers override buildHeaders defaults
					if (headers) Object.assign(nodeHeaders, headers);
					html = await this.fileDownloader.fetchHtmlViaNodeHttps(url, nodeHeaders);
				}
			} else {
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

					// Node.js https 可可靠发送自定义 UA/Referer，使用 buildHeaders 模拟浏览器请求
					// Node.js https can reliably send custom UA/Referer, use buildHeaders to emulate browser
					const nodeHeaders = buildHeaders(url, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
					// IMA headers（来自 get_media_info）覆盖 buildHeaders 默认值 / IMA headers override buildHeaders defaults
					if (headers) Object.assign(nodeHeaders, headers);
					html = await this.fileDownloader.fetchHtmlViaNodeHttps(url, nodeHeaders);
				}

				// 非微信 URL：若获取的 HTML 疑似反爬页或内容过短，尝试 headless 兜底
				// Non-WeChat URL: if HTML looks like anti-bot or too short, try headless fallback
				if (!isWeChatPage && this.settings.downloadEnhanced && !headlessTried) {
					const htmlTooShort = html.trim().length < 500;
					const looksLikeAntiBot = HeadlessExtractor.hasCaptcha(html) ||
						html.includes('请开启JavaScript') || html.includes('请打开JavaScript');
					if (htmlTooShort || looksLikeAntiBot) {
						try {
							const headlessHtml = await this.headlessExtractor.extractRenderedHtml(url);
							if (headlessHtml && HeadlessExtractor.hasValidContent(headlessHtml) && !HeadlessExtractor.hasCaptcha(headlessHtml)) {
								html = headlessHtml;
								headlessTried = true;
								console.debug(`ima.copilot Sync: Headless extraction succeeded for non-WeChat URL: ${url}`);
							}
						} catch (headlessErr) {
							console.warn(`ima.copilot Sync: Headless extraction failed for: ${url}`, headlessErr);
						}
					}
				}

			}
			const result = wechatConverter
				? wechatConverter(html, url)
				: convertHtmlToMarkdown(html, { url });

			const frontmatter = this.buildWebFrontmatter(url, result.author, result.published, mediaId);

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
		if (!headlessTried && wechatConverter && isWeChatPage && (result.fromMeta || !HeadlessExtractor.hasWeChatContent(html) || contentTooShort || hasOrphanImages || looksLikeJsPage)) {
				let headlessSucceeded = false;
				if (this.settings.downloadEnhanced) {
					const headless = await this.tryHeadlessExtraction(url, wechatConverter, { isWeChat: true });
					if (headless) {
						html = headless.html;
						result.content = headless.result.content;
						result.title = headless.result.title || result.title;
						result.author = headless.result.author || result.author;
						result.fromMeta = false;
						parts.length = 0;
						parts.push(this.buildWebFrontmatter(url, result.author, result.published, mediaId));
						const hdTitle = result.title || title;
						if (hdTitle) {
							parts.push(`# ${hdTitle}\n`);
						}
						headlessSucceeded = true;
						headlessTried = true;
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

				// 尝试 headless 作为最后手段（如果尚未尝试）/ Attempt headless as last resort (if not already tried)
				// 微信用专用 converter，通用网页用通用 converter / WeChat uses dedicated converter, generic pages use generic
				if (this.settings.downloadEnhanced && !headlessTried) {
					try {
						const catchConverter = isWeChatPage ? convertWeChatHtmlToMarkdown : (h: string, u: string) => convertHtmlToMarkdown(h, u);
						const headless = await this.tryHeadlessExtraction(url, catchConverter, { isWeChat: isWeChatPage });
						if (headless) {
							const frontmatter = this.buildWebFrontmatter(url, headless.result.author, headless.result.published, mediaId);
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

				return this.buildFriendlyPlaceholder(title, url, mediaId,
				(Platform.isDesktop && this.settings.downloadEnhanced) ? 'headless-failed' : 'need-desktop');
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
			lines.push(`  - "${author}"`);
		}

		if (published) {
			// 已是标准 ISO 日期时间格式（含/不含时区），直接使用，不转 UTC
			// Already in standard ISO datetime format (with/without timezone), use as-is
			const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?$/;
			if (isoRe.test(published)) {
				lines.push(`published: ${published.replace(/[+-]\d{2}:\d{2}$/, '')}`);
			} else {
				const formatted = this.formatDateTime(published);
				if (formatted) {
					lines.push(`published: ${formatted}`);
				}
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
		// RegExp.exec() 循环替代 matchAll：matchAll 是 ES2020 API，当前 tsconfig lib 不含其类型定义，
		// 会退化为 any 触发 no-unsafe-* 警告；exec() 是 ES3 API，有完整 RegExpExecArray 类型
		// Replace matchAll with RegExp.exec() loop: matchAll is ES2020, not in tsconfig lib,
		// so it degrades to any triggering no-unsafe-*; exec() is ES3 with full RegExpExecArray types
		const regex = new RegExp(FILE_TAG_REGEX.source, FILE_TAG_REGEX.flags);
		let result = content;
		let matchCount = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content)) !== null) {
			matchCount++;
			const attrStr = match[1] ?? '';
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
		console.debug(`ima.copilot Sync: processInlineFileTags found ${matchCount} file tags`);

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

		const mdPaths = await listMdPathsInFolder(this.vault, syncFolder);

		for (const path of mdPaths) {
			// 按需将路径转为 TFile（本方法需要 vault.read/modify）
			// Convert path to TFile on demand (this method needs vault.read/modify)
			const file = this.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.vault.read(file);
				if (!content.match(/!\[[^\]]*\]\(https?:\/\//)) continue;

				// 若笔记有 docid 且认证客户端可用，重新拉 Markdown 获取新鲜图片 URL（避免 COS 临时链接过期）
				// If note has docid and auth client is available, re-fetch Markdown for fresh image URLs (avoids expired COS signed URLs)
				// docid 同样读盘兜底：metadataCache 未就绪时不至于跳过刷新分支
				// docid also uses the disk fallback so a cold metadataCache doesn't skip the refresh branch
				const docid = await this.readFrontmatterId(path, 'docid');

				let fixed = content;
				if (typeof docid === 'string' && this.client) {
					try {
						const freshMd = await this.client.getNoteContentMarkdown(docid);
						const withImages = await this.imageHandler.processContent(freshMd, file.path, opts, extractNoteBaseName(file.path));
						fixed = `---\ndocid: "${docid}"\n---\n\n${withImages}`;
					} catch (err) {
						console.warn(`ima.copilot Sync: 重新获取笔记内容失败，降级修复现有外链 / Re-fetch failed, falling back for ${file.path}:`, err);
					}
				}
				if (fixed === content) {
					fixed = await this.imageHandler.processContent(content, file.path, opts, extractNoteBaseName(file.path));
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
	 * 写入或更新笔记文件，更新后清理孤儿图片
	 * Write or update note file, then clean up orphan images
	 */
	/**
	 * 解析唯一文件路径：同一条目复用原路径，真撞名才追加短标识
	 * Resolve a unique file path: reuse the original path for the same item, only append a short id on a real title collision
	 *
	 * 幂等性核心闸门：即使判重扫描漏掉了某条目，只要同名文件的 frontmatter 标识等于当前条目，
	 * 就原地覆盖而不是另存一份（issue #7 的重复副本就是缺了这道闸门）
	 * The core idempotency gate: even if the dedup scan misses an item, a same-name file whose
	 * frontmatter id equals the current item is overwritten in place instead of copied aside
	 * (missing this gate is exactly what produced the duplicates in issue #7)
	 */
	private async resolveFilePath(dir: string, title: string, uniqueId: string, idKey: SyncIdKey, ext = 'md'): Promise<string> {
		const base = sanitizeFilename(title || uniqueId);
		const basePath = normalizePath(`${dir}/${base}.${ext}`);

		const existing = this.vault.getFileByPath(basePath);
		if (!(existing instanceof TFile)) return basePath;

		// 同一条目 → 原地覆盖 / Same item → overwrite in place
		const existingId = await this.readFrontmatterId(basePath, idKey);
		if (existingId === uniqueId) return basePath;

		// 标题真撞名 → 追加短标识；已存在且属于当前条目的后缀文件直接复用
		// Real title collision → append the short id; an existing suffixed file for this item is reused
		const shortId = shortIdOf(uniqueId);
		for (let n = 1; n <= 20; n++) {
			const candidate = normalizePath(`${dir}/${base}-${shortId}${n > 1 ? `-${n}` : ''}.${ext}`);
			const candidateFile = this.vault.getFileByPath(candidate);
			if (!(candidateFile instanceof TFile)) {
				if (n === 1) {
					console.warn(`ima.copilot Sync: 标题撞名，另存为 / Title collision, saving as: ${candidate}`);
				}
				return candidate;
			}
			if (await this.readFrontmatterId(candidate, idKey) === uniqueId) return candidate;
		}

		const fallback = normalizePath(`${dir}/${base}-${shortId}-21.${ext}`);
		console.warn(`ima.copilot Sync: 同名文件过多，改用 / Too many same-name files, using: ${fallback}`);
		return fallback;
	}

	private async writeNote(filePath: string, content: string, opts: AttachmentOptions): Promise<void> {
		const existing = this.vault.getFileByPath(filePath);
		if (existing instanceof TFile) {
			const oldContent = await this.vault.read(existing);

			if (oldContent === content) {
				// 内容未变也刷新引用缓存，避免后续清理误判 / Refresh the reference cache even when unchanged
				this.refIndex.set(filePath, this.namesFromContent(content));
				return;
			}

			const oldImagePaths = this.imageHandler.extractLocalImagePaths(oldContent, filePath, opts);
			const oldFilePaths = this.imageHandler.extractLocalFilePaths(oldContent, filePath, opts);
			const oldPaths = [...oldImagePaths, ...oldFilePaths];
			await this.vault.modify(existing, content);

			const newImagePaths = this.imageHandler.extractLocalImagePaths(content, filePath, opts);
			const newFilePaths = this.imageHandler.extractLocalFilePaths(content, filePath, opts);
			const newPaths = new Set([...newImagePaths, ...newFilePaths]);
			const orphans = oldPaths.filter(p => !newPaths.has(p));
			this.refIndex.set(filePath, this.namesFromContent(content));
			if (orphans.length > 0) {
				await this.cleanOrphanImages(orphans, filePath);
			}
		} else {
			await this.vault.create(filePath, content);
			this.refIndex.set(filePath, this.namesFromContent(content));
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
	 * 从 CachedMetadata 收集某笔记引用的附件文件名；cache 缺失返回 null
	 * Collect attachment filenames referenced by a note from CachedMetadata; null when the cache is missing
	 */
	private namesFromCache(path: string): Set<string> | null {
		const cache = this.app.metadataCache.getCache(path);
		if (!cache) return null;

		const names = new Set<string>();
		for (const embed of cache.embeds ?? []) {
			names.add(embed.link.split('/').pop() ?? embed.link);
		}
		for (const link of cache.links ?? []) {
			// 非外链的 wikilink/嵌入都算引用（含 PDF 等非图片附件，与 extractLocalFilePaths 对齐）
			// Every non-http wikilink/embed counts as a reference (including non-image attachments, aligned with extractLocalFilePaths)
			if (link.link.startsWith('http')) continue;
			const decoded = link.link.split('/').map(s => decodeURIComponent(s)).join('/');
			names.add(decoded.split('/').pop() ?? decoded);
		}
		return names;
	}

	/**
	 * 从正文正则收集引用的附件文件名（metadataCache 未就绪时的兜底）
	 * Collect referenced attachment filenames from raw content (fallback while the cache isn't ready)
	 */
	private namesFromContent(content: string): Set<string> {
		const names = new Set<string>();
		const add = (raw: string): void => {
			const trimmed = raw.trim();
			if (!trimmed) return;
			const decoded = trimmed.split('/').map(s => decodeURIComponent(s)).join('/');
			const name = decoded.split('/').pop() ?? decoded;
			if (name) names.add(name);
		};

		let match: RegExpExecArray | null;
		// [[file.pdf]] / ![[image.png|alt]]
		const wikiRe = /!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		while ((match = wikiRe.exec(content)) !== null) add(match[1] ?? '');
		// [text](path) / ![alt](path)，跳过外链
		const mdRe = /!?\[[^\]]*\]\((?!https?:\/\/)([^)\s]+)\)/g;
		while ((match = mdRe.exec(content)) !== null) add(match[1] ?? '');

		return names;
	}

	/**
	 * 取某笔记引用的附件文件名；null 表示不可信
	 * Referenced attachment filenames of a note; null means "unknown"
	 */
	private async getReferencedNames(path: string): Promise<Set<string> | null> {
		const cached = this.namesFromCache(path);
		if (cached) return cached;

		const memo = this.refIndex.get(path);
		if (memo) return memo;

		try {
			const content = await this.vault.adapter.read(path);
			const names = this.namesFromContent(content);
			this.refIndex.set(path, names);
			return names;
		} catch (err) {
			console.warn(`ima.copilot Sync: 读取笔记引用失败 / Failed to read note references: ${path}`, err);
			return null;
		}
	}

	/**
	 * 检查图片路径列表，删除不再被任何同步笔记引用的图片文件
	 * Check image paths and delete files no longer referenced by any synced note
	 *
	 * metadataCache 优先，未就绪时读盘兜底；引用索引不可信（有文件读不到）时整体放弃删除
	 * metadataCache first with a disk fallback; when the reference index is unreliable (some file
	 * couldn't be read) the whole cleanup is abandoned instead of deleting anything
	 */
	private async cleanOrphanImages(imagePaths: string[], skipFile: string): Promise<void> {
		if (imagePaths.length === 0) return;

		const syncFolder = normalizePath(this.settings.syncFolder);
		const mdPaths = (await listMdPathsInFolder(this.vault, syncFolder)).filter(p => p !== skipFile);

		const referencedFilenames = new Set<string>();
		for (const path of mdPaths) {
			const names = await this.getReferencedNames(path);
			if (names === null) {
				console.warn(`ima.copilot Sync: 引用索引不可信，跳过本次孤儿图片清理 / Reference index unreliable, skipping orphan cleanup: ${path}`);
				return;
			}
			for (const name of names) referencedFilenames.add(name);
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

	/**
	 * 清理「原名-<同步标识后缀>」重复副本（命令入口）
	 * Clean "<name>-<sync id suffix>" duplicate copies (command entry)
	 */
	async cleanupDuplicateCopies(): Promise<void> {
		if (this.isSyncing) {
			new Notice('🐼 ima.copilot sync: 同步正在进行中，请稍候');
			return;
		}

		const syncFolder = normalizePath(this.settings.syncFolder);
		const scan = await findDuplicateCopies(this.vault, syncFolder);

		if (scan.pairs.length === 0) {
			new Notice(`🐼 ima.copilot sync: 未发现可清理的重复副本（无主档 ${scan.unpaired.length}，正文不一致 ${scan.ambiguous.length}）`);
			return;
		}

		console.debug(`ima.copilot Sync: 可清理的重复副本 / Cleanable duplicate copies:\n${scan.pairs.map(p => p.copyPath).join('\n')}`);
		const sample = scan.pairs.slice(0, 10).map(p => p.copyPath).join('\n');
		const more = scan.pairs.length > 10 ? `\n…等共 ${scan.pairs.length} 份` : '';
		const skipped = scan.unpaired.length + scan.ambiguous.length;

		new ConfirmModal(
			this.app,
			'清理重复副本？',
			`发现 ${scan.pairs.length} 份「原名-同步标识后缀」副本，与主档标识相同且正文一致${skipped > 0 ? `（另有 ${skipped} 份疑似或正文不一致，将保留）` : ''}。\n以下文件将移入回收站：\n${sample}${more}`,
			'移入回收站',
			'取消',
			() => void this.applyDuplicateCleanup(scan.pairs),
			() => { /* 用户取消 / Cancelled by user */ },
			() => { /* 用户直接关窗 / Dismissed */ },
		).open();
	}

	/**
	 * 执行重复副本回收：副本移入回收站，其专属附件随后按引用索引清理
	 * Apply duplicate cleanup: trash the copies, then recycle their exclusive attachments
	 */
	private async applyDuplicateCleanup(pairs: DuplicatePair[]): Promise<void> {
		this.refIndex.clear();
		const opts = this.buildAttachmentOptions();
		const attachmentCandidates = new Set<string>();
		let removedNotes = 0;
		let failed = 0;

		for (const pair of pairs) {
			const file = this.vault.getFileByPath(pair.copyPath);
			if (!(file instanceof TFile)) continue;
			try {
				const content = await this.vault.read(file);
				for (const p of this.imageHandler.extractLocalImagePaths(content, pair.copyPath, opts)) attachmentCandidates.add(p);
				for (const p of this.imageHandler.extractLocalFilePaths(content, pair.copyPath, opts)) attachmentCandidates.add(p);
				await this.app.fileManager.trashFile(file);
				removedNotes++;
			} catch (err) {
				failed++;
				console.warn(`ima.copilot Sync: 重复副本移入回收站失败 / Failed to trash duplicate copy ${pair.copyPath}:`, err);
			}
		}

		// 统计候选附件在清理前的存在数量，清理后对比得出实际回收数
		// Count candidates that exist before cleanup, then diff afterwards to report how many were recycled
		const existingCandidates: string[] = [];
		for (const candidate of attachmentCandidates) {
			try {
				if (await this.vault.adapter.exists(candidate)) existingCandidates.push(candidate);
			} catch { /* 不存在则忽略 / Ignore when missing */ }
		}
		if (existingCandidates.length > 0) {
			await this.cleanOrphanImages(existingCandidates, '');
		}
		let removedAttachments = 0;
		for (const candidate of existingCandidates) {
			try {
				if (!(await this.vault.adapter.exists(candidate))) removedAttachments++;
			} catch { /* 忽略 / Ignore */ }
		}

		const failedNote = failed > 0 ? `，${failed} 份失败（见控制台）` : '';
		new Notice(`🐼 ima.copilot sync: 已清理 ${removedNotes} 份重复副本、${removedAttachments} 个重复附件${failedNote}`);
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
