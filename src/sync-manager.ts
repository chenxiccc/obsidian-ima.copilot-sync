import { App, Vault, Notice, normalizePath, TFile, requestUrl } from 'obsidian';
import type { ImaPluginSettings } from './settings';
import type { AttachmentOptions } from './image-handler';
import type { KnowledgeInfo } from './ima-client';
import { ImaClient } from './ima-client';
import { ImageHandler } from './image-handler';
import { JsonToMarkdown } from './json-to-md';
import { convertHtmlToMarkdown } from './html-to-md';
import { FileDownloader } from './file-downloader';

// ─── 同步管理器 / Sync manager ───────────────────────────────────────────────

const MEDIA_TYPE_LABELS: Record<number, string> = {
	1: 'PDF', 2: '网页', 3: 'Word 文档', 4: 'PPT', 5: 'Excel',
	6: '微信公众号文章', 7: 'Markdown', 9: '图片', 11: '笔记',
	13: 'TXT', 14: 'Xmind',
};

const FILE_MEDIA_TYPES = new Set([1, 3, 4, 5, 7, 9, 13, 14]);

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class SyncManager {
	private client: ImaClient;
	private imageHandler: ImageHandler;
	private jsonToMd: JsonToMarkdown;
	private fileDownloader: FileDownloader;
	private isSyncing = false;

	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly settings: ImaPluginSettings,
		private readonly saveSettings: () => Promise<void>,
	) {
		this.client = new ImaClient(settings.clientId, settings.apiKey);
		this.imageHandler = new ImageHandler(vault);
		this.jsonToMd = new JsonToMarkdown(this.imageHandler);
		this.fileDownloader = new FileDownloader(vault);
	}

	rebuildClient(): void {
		this.client = new ImaClient(this.settings.clientId, this.settings.apiKey);
		this.imageHandler = new ImageHandler(this.vault);
		this.jsonToMd = new JsonToMarkdown(this.imageHandler);
		this.fileDownloader = new FileDownloader(this.vault);
	}

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

		await this.ensureFolder(syncFolder);

		let syncedCount = 0;

		// ── 同步 IMA 笔记 / Sync IMA notes ──
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

		// ── 同步知识库 / Sync knowledge base ──
		if (this.settings.syncKnowledgeBase) {
			const kbId = this.settings.knowledgeBaseId.trim();
			if (!kbId) {
				new Notice('IMA Sync: 请在设置中填写知识库 ID');
			} else {
				const kbFolder = normalizePath(`${syncFolder}/知识库`);
				await this.ensureFolder(kbFolder);

				// 扫描已有文件，构建 media_id → filePath 映射（增量同步判重，零 I/O）
				// Scan existing files, build media_id → filePath map (incremental sync dedup, zero I/O)
				const existingMap = this.scanExistingKbFiles(kbFolder);

				const items = await this.client.listAllKnowledgeItems(kbId);

				// ── 删除同步：本地有但 API 没有 → 按设置处理 / Delete sync ──
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

				// ── 增量同步：API 有但本地没有 → 新建 / Incremental sync ──
				for (const item of items) {
					try {
						// 条目不可变，已存在则跳过 / Items are immutable, skip if exists
						if (existingMap.has(item.media_id)) continue;

						const filename = this.sanitizeFilename(item.title || item.media_id);
						const filePath = normalizePath(`${kbFolder}/${filename}.md`);

						const content = await this.syncKnowledgeItem(item, filePath, opts);
						if (content !== null) {
							await this.writeNote(filePath, content, opts);
							syncedCount++;
						}
					} catch (err) {
						console.warn(`IMA Sync: 知识库条目 "${item.title}" 同步失败`, err);
					}
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
			// 已标记则跳过 / Skip if already marked
			if (filePath.includes('[deleted]')) return;
			const newFilePath = filePath.replace(/\.md$/, ' [deleted].md');
			try {
				await this.vault.adapter.rename(filePath, newFilePath);
			} catch (renameErr) {
				console.warn(`IMA Sync: 标记删除重命名失败 / Mark-deleted rename failed: ${filePath}`, renameErr);
				return;
			}
			// 在 frontmatter 中加上 sync_status: deleted
			// Add sync_status: deleted to frontmatter
			const renamedFile = this.vault.getFileByPath(newFilePath);
			if (renamedFile instanceof TFile) {
				const content = await this.vault.read(renamedFile);
				const updated = this.prependFrontmatterField(content, 'sync_status', 'deleted');
				await this.vault.modify(renamedFile, updated);
			}
			console.debug(`IMA Sync: 标记已删除条目 / Marked deleted item: ${newFilePath}`);
		}
		// 'keep' → 不做任何操作 / Do nothing
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
			const mediaInfo = await this.client.getMediaInfo(item.media_id);

			// ── 分支 A：笔记类型 ──
			if (mediaInfo.media_type === 11 && mediaInfo.notebook_ext_info?.notebook_id) {
				const notebookId = mediaInfo.notebook_ext_info.notebook_id;
				const rawJson = await this.client.getNoteContent(notebookId);
				const mdContent = await this.jsonToMd.convert(rawJson, filePath, opts);
				// 笔记类型也加上 media_id frontmatter / Add media_id frontmatter for note type too
				return this.prependFrontmatterField(mdContent, 'media_id', item.media_id);
			}

			// ── 分支 B：url_info 中有可访问的 URL ──
			if (mediaInfo.url_info?.url) {
				const { url, headers } = mediaInfo.url_info;
				return await this.syncByMediaType(item.media_type, url, headers, item.title, filePath, opts, item.media_id);
			}

			// ── 分支 C：无可访问内容，fallback 到占位符 ──
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
				return `---\nmedia_id: "${mediaId}"\n---\n\n${result.linkText}`;
			}

			return `---\nmedia_id: "${mediaId}"\n---\n\n# ${title}\n\n${result.linkText}`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const typeLabel = MEDIA_TYPE_LABELS[isImage ? 9 : 0] ?? '文件';
			return `> ${typeLabel}下载失败：${msg}\n\n**标题**: ${title}`;
		}
	}

	/** 从 URL 推断下载文件名 / Infer download filename from URL */
	private inferFilenameFromUrl(url: string, fallbackTitle: string): string {
		try {
			const urlObj = new URL(url);
			const lastSegment = urlObj.pathname.split('/').pop() ?? '';
			const decoded = decodeURIComponent(lastSegment);
			if (decoded && decoded.includes('.')) {
				return decoded.replace(/[/\\:*?"<>|]/g, '_').trim();
			}
		} catch { /* ignore */ }
		const ext = this.guessExtensionFromUrl(url);
		return `${fallbackTitle.replace(/[/\\:*?"<>|#^[\]]/g, '_').trim().slice(0, 80)}${ext}`;
	}

	/** 根据 URL 猜测文件扩展名 / Guess file extension from URL */
	private guessExtensionFromUrl(url: string): string {
		const lower = url.toLowerCase();
		if (lower.includes('.pdf')) return '.pdf';
		if (lower.includes('.doc') || lower.includes('.docx')) return '.docx';
		if (lower.includes('.ppt') || lower.includes('.pptx')) return '.pptx';
		if (lower.includes('.xls') || lower.includes('.xlsx')) return '.xlsx';
		if (lower.includes('.txt')) return '.txt';
		if (lower.includes('.xmind')) return '.xmind';
		if (lower.includes('.md') || lower.includes('.markdown')) return '.md';
		if (lower.includes('.jpg') || lower.includes('.jpeg')) return '.jpg';
		if (lower.includes('.png')) return '.png';
		if (lower.includes('.gif')) return '.gif';
		if (lower.includes('.webp')) return '.webp';
		return '';
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
			const oldContent = await this.vault.read(existing);
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
	 */
	private async cleanOrphanImages(imagePaths: string[], skipFile: string): Promise<void> {
		const syncFolder = normalizePath(this.settings.syncFolder);
		const mdFiles = this.vault.getFiles().filter(f =>
			f.extension === 'md' && f.path.startsWith(syncFolder + '/') && f.path !== skipFile,
		);

		for (const imgPath of imagePaths) {
			try {
				const exists = await this.vault.adapter.exists(imgPath);
				if (!exists) continue;

				const filename = imgPath.split('/').pop() ?? '';
				let stillReferenced = false;

				for (const file of mdFiles) {
					const fileContent = await this.vault.read(file);
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

	private async ensureFolder(folderPath: string): Promise<void> {
		const exists = await this.vault.adapter.exists(folderPath);
		if (!exists) {
			await this.vault.createFolder(folderPath);
		}
	}

	private sanitizeFilename(name: string): string {
		return name
			.replace(/[/\\:*?"<>|#^[\]]/g, '_')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 100);
	}
}
