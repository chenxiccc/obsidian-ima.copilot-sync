import { Vault, Notice, normalizePath, TFile } from 'obsidian';
import type { ImaPluginSettings } from './settings';
import type { AttachmentOptions } from './image-handler';
import { ImaClient } from './ima-client';
import { ImageHandler } from './image-handler';
import { JsonToMarkdown } from './json-to-md';

// ─── 同步管理器 / Sync manager ───────────────────────────────────────────────

export class SyncManager {
	private client: ImaClient;
	private imageHandler: ImageHandler;
	private jsonToMd: JsonToMarkdown;
	/** 防止并发执行 / Prevent concurrent execution */
	private isSyncing = false;

	constructor(
		private readonly vault: Vault,
		private readonly settings: ImaPluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		this.client = new ImaClient(settings.clientId, settings.apiKey);
		this.imageHandler = new ImageHandler(vault);
		this.jsonToMd = new JsonToMarkdown(this.imageHandler);
	}

	/**
	 * 重建 client（设置变更后调用）
	 * Rebuild client (call after settings change)
	 */
	rebuildClient(): void {
		this.client = new ImaClient(this.settings.clientId, this.settings.apiKey);
		this.imageHandler = new ImageHandler(this.vault);
		this.jsonToMd = new JsonToMarkdown(this.imageHandler);
	}

	/**
	 * 执行一次同步
	 * Execute one sync cycle
	 */
	async syncOnce(): Promise<void> {
		if (this.isSyncing) {
			new Notice('IMA Sync: 同步正在进行中，请稍候');
			return;
		}

		if (!this.settings.clientId || !this.settings.apiKey) {
			new Notice('IMA Sync: 请先在设置中填写 Client ID 和 API Key');
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

	/**
	 * 迁移同步文件夹：将 oldFolder 重命名为 newFolder
	 * Migrate sync folder: rename oldFolder to newFolder
	 */
	async migrateSyncFolder(oldFolder: string, newFolder: string): Promise<void> {
		const old = normalizePath(oldFolder);
		const neu = normalizePath(newFolder);
		if (old === neu) return;

		const oldExists = await this.vault.adapter.exists(old);
		if (!oldExists) return; // 旧目录不存在，无需迁移 / Old dir doesn't exist, nothing to migrate

		const newExists = await this.vault.adapter.exists(neu);
		if (newExists) {
			throw new Error(`目标文件夹 "${newFolder}" 已存在，无法迁移 / Target folder "${newFolder}" already exists`);
		}

		// vault.adapter.rename 对文件夹同样有效 / vault.adapter.rename also works on folders
		await this.vault.adapter.rename(old, neu);
	}

	/** 构建附件选项 / Build attachment options */
	private buildAttachmentOptions(): AttachmentOptions {
		return {
			pathMode: this.settings.attachmentPathMode,
			subfolderName: this.settings.attachmentSubfolderName,
			linkFormat: this.settings.linkFormat,
			syncFolder: normalizePath(this.settings.syncFolder),
		};
	}

	/** 核心同步逻辑 / Core sync logic */
	private async doSync(): Promise<number> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const opts = this.buildAttachmentOptions();

		// 确保同步根目录存在 / Ensure sync root folder exists
		await this.ensureFolder(syncFolder);

		let syncedCount = 0;

		// ── 同步 IMA 笔记 / Sync IMA notes ──────────────────────────────────
		if (this.settings.syncNotes) {
			const notes = await this.client.listAllNotes(this.settings.lastSyncTime);
			for (const note of notes) {
				try {
					const filename = this.sanitizeFilename(note.title || note.docid);
					const filePath = normalizePath(`${syncFolder}/${filename}.md`);
					const rawJson = await this.client.getNoteContent(note.docid);
					const processedContent = await this.jsonToMd.convert(rawJson, filePath, opts);
					await this.writeNote(filePath, processedContent, opts);
					syncedCount++;
				} catch (err) {
					console.warn(`IMA Sync: 笔记 "${note.title}" 同步失败`, err);
				}
			}
		}

		// ── 同步知识库 / Sync knowledge base ────────────────────────────────
		if (this.settings.syncKnowledgeBase) {
			const kbId = this.settings.knowledgeBaseId.trim();
			if (!kbId) {
				new Notice('IMA Sync: 请在设置中填写知识库 ID');
			} else {
				const kbFolder = normalizePath(`${syncFolder}/知识库`);
				await this.ensureFolder(kbFolder);

				const items = await this.client.listAllKnowledgeItems(kbId);
				for (const item of items) {
					try {
						const filename = this.sanitizeFilename(item.title || item.media_id);
						let filePath: string;
						let content: string;

						if (item.media_type === 11) {
							// ── 笔记类型：提取 doc_id，通过 Notes API 获取内容
							// ── Note type: extract doc_id, get content via Notes API
							const docId = this.client.extractDocIdFromMediaId(item.media_id);
							if (!docId) {
								console.warn(`IMA Sync: 无法从 media_id 提取 docId: ${item.media_id}`);
								continue;
							}
							filePath = normalizePath(`${kbFolder}/${filename}.md`);
							const rawJson = await this.client.getNoteContent(docId);
							content = await this.jsonToMd.convert(rawJson, filePath, opts);
						} else if (item.media_type === 6 || item.media_type === 2) {
							// ── 微信文章 / 网页：IMA API 不提供原始 URL 或正文，只记录标题作为占位
							// ── WeChat article / Webpage: IMA API does not expose original URL or content, record title as placeholder
							const typeLabel = item.media_type === 6 ? '微信公众号文章' : '网页';
							content = `> 此条目为${typeLabel}，IMA API 不支持直接导出原文。\n\n**标题**: ${item.title}`;
							filePath = normalizePath(`${kbFolder}/${filename}.md`);
						} else if (item.media_type === 3 || item.media_type === 1 || item.media_type === 4 || item.media_type === 5 || item.media_type === 13 || item.media_type === 14) {
							// ── 文件类型（Word/PDF/PPT/Excel/TXT/Xmind）：创建占位文件
							// ── File type (Word/PDF/PPT/Excel/TXT/Xmind): create placeholder
							const typeNames: Record<number, string> = {
								1: 'PDF', 3: 'Word 文档', 4: 'PPT', 5: 'Excel', 13: 'TXT', 14: 'Xmind',
							};
							const typeName = typeNames[item.media_type] ?? '文件';
							content = `> 此条目为 ${typeName}，暂不支持自动同步文件内容。\n\n**标题**: ${item.title}`;
							filePath = normalizePath(`${kbFolder}/${filename}.md`);
						} else {
							// 未知类型，跳过 / Unknown type, skip
							continue;
						}

						await this.writeNote(filePath, content, opts);
						syncedCount++;
					} catch (err) {
						console.warn(`IMA Sync: 知识库条目 "${item.title}" 同步失败`, err);
					}
				}
			}
		}

		// ── 修复残留外链图片 / Fix leftover external image links ─────────────
		await this.fixPendingImages(syncFolder, opts);

		// 更新最后同步时间 / Update last sync time
		this.settings.lastSyncTime = Date.now();
		await this.saveSettings();

		return syncedCount;
	}

	/**
	 * 扫描同步文件夹内所有 .md 文件，将其中残留的外链图片下载到本地并替换链接
	 * Scan all .md files in sync folder, download leftover external image links
	 */
	private async fixPendingImages(syncFolder: string, opts: AttachmentOptions): Promise<void> {
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/'),
		);

		for (const file of mdFiles) {
			try {
				const content = await this.vault.read(file);
				if (!content.match(/!\[[^\]]*\]\(https?:\/\//)) continue;

				const fixed = await this.imageHandler.processContent(content, file.path, opts);
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
			// 读取旧内容，提取旧图片路径集合
			// Read old content and extract old image paths
			const oldContent = await this.vault.read(existing);
			const oldPaths = this.imageHandler.extractLocalImagePaths(oldContent, filePath, opts);

			await this.vault.modify(existing, content);

			// 提取新图片路径，对比差集并清理孤儿文件
			// Extract new image paths, diff and clean orphan files
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
	 * @param imagePaths  待检查的图片 vault 路径列表 / List of image vault paths to check
	 * @param skipFile    已在内存中更新、无需重复读取的笔记路径 / Note path already updated in memory, skip re-reading
	 */
	private async cleanOrphanImages(imagePaths: string[], skipFile: string): Promise<void> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		// 获取同步文件夹下所有 md 文件（排除刚写入的那篇）
		// Get all md files under sync folder (excluding the just-written note)
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/') && f.path !== skipFile,
		);

		for (const imgPath of imagePaths) {
			try {
				const exists = await this.vault.adapter.exists(imgPath);
				if (!exists) continue;

				// 搜索是否还有其他笔记引用此图片
				// Check if any other note still references this image
				const filename = imgPath.split('/').pop() ?? '';
				let stillReferenced = false;

				for (const file of mdFiles) {
					const fileContent = await this.vault.read(file);
					// wikilink 匹配文件名，markdown 格式匹配编码后路径片段
					// Match filename for wikilink, encoded path segment for markdown format
					if (fileContent.includes(`[[${filename}]]`) ||
						fileContent.includes(`[[${filename}|`) ||
						fileContent.includes(`(${encodeURIComponent(filename)})`) ||
						fileContent.includes(`/${encodeURIComponent(filename)})`) ||
						fileContent.includes(`(${filename})`) ||
						fileContent.includes(`/${filename})`)) {
						stillReferenced = true;
						break;
					}
				}

				if (!stillReferenced) {
					await this.vault.adapter.remove(imgPath);
					console.debug(`IMA Sync: 删除孤儿图片 / Removed orphan image: ${imgPath}`);
				}
			} catch (err) {
				console.warn(`IMA Sync: 清理孤儿图片失败 / Failed to clean orphan image ${imgPath}:`, err);
			}
		}
	}

	/** 确保文件夹存在 / Ensure folder exists */
	private async ensureFolder(folderPath: string): Promise<void> {
		const exists = await this.vault.adapter.exists(folderPath);
		if (!exists) {
			await this.vault.createFolder(folderPath);
		}
	}

	/** 清理文件名中的非法字符 / Sanitize illegal characters in filename */
	private sanitizeFilename(name: string): string {
		return name
			.replace(/[/\\:*?"<>|#^[\]]/g, '_')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 100); // 限制文件名长度 / Limit filename length
	}
}
