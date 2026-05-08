import { requestUrl, Plugin } from 'obsidian';
import type { DataAdapter } from 'obsidian';

// IMA API base URL / IMA API 基础地址
const BASE_URL = 'https://ima.qq.com';

// 调试日志文件路径（vault 内相对路径）/ Debug log file path (relative within vault)
let debugLogPath = '';
// 是否启用调试日志 / Whether debug logging is enabled
let debugLogEnabled = false;
// vault adapter 引用（用于写日志）/ Vault adapter reference (for writing log)
let debugAdapter: DataAdapter | null = null;

/** 初始化日志路径 / Initialize log path */
export function initDebugLog(plugin: Plugin): void {
	debugAdapter = plugin.app.vault.adapter;
	debugLogPath = '.obsidian/plugins/obsidian-ima-sync/ima-debug.log';
}

/** 更新调试日志开关 / Update debug log enabled state */
export function setDebugLogEnabled(enabled: boolean): void {
	debugLogEnabled = enabled;
}

/** 追加写入调试日志（仅在开关开启时有效）/ Append to debug log (only when enabled) */
function debugLog(msg: string): void {
	if (!debugLogEnabled || !debugLogPath || !debugAdapter) return;
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	// 使用 vault adapter 写日志，跨平台兼容 / Use vault adapter for cross-platform log writing
	void debugAdapter.append(debugLogPath, line);
}

// ─── 数据类型定义 / Data type definitions ───────────────────────────────────

/** 笔记基础信息 / Note basic info */
export interface DocBasic {
	docid: string;
	title: string;
	summary: string;
	/** Unix 毫秒时间戳 / Unix milliseconds timestamp */
	create_time: number;
	/** Unix 毫秒时间戳 / Unix milliseconds timestamp */
	modify_time: number;
	/** 0=正常 1=已删除 / 0=normal 1=deleted */
	status: number;
	folder_id: string;
	folder_name: string;
}

// API 响应的嵌套结构 / Nested structure of API response
interface DocBasicInfo {
	basic_info: DocBasic;
}

interface NoteBookInfo {
	basic_info: DocBasicInfo;
}

interface ListNotesResponse {
	note_book_list: NoteBookInfo[];
	next_cursor: string;
	is_end: boolean;
}

interface GetDocContentResponse {
	content: string;
}

// 知识库相关接口 / Knowledge base related interfaces

interface AddableKnowledgeBaseInfo {
	id: string;
	name: string;
}

interface ListAddableKBResponse {
	addable_knowledge_base_list: AddableKnowledgeBaseInfo[];
	next_cursor: string;
	is_end: boolean;
}

// 知识库搜索结果 / Knowledge base search result
export interface SearchedKnowledgeBase {
	kb_id: string;
	kb_name: string;
	cover_url: string;
	member_count: string;
	content_count: string;
	description: string;
	creator: string;
	role_type: string;
	/** "我加入的订阅知识库" 或 "个人知识库" / "Subscribed" or "Personal" */
	base_type: string;
}

interface SearchKBResponse {
	info_list: SearchedKnowledgeBase[];
	is_end: boolean;
	next_cursor: string;
}

// get_media_info 响应类型 / get_media_info response types

/** 访问链接信息 / Access URL info */
export interface URLInfo {
	url: string;
	headers?: Record<string, string>;
}

/** 笔记扩展信息（知识库中笔记类型媒体）/ Notebook extension info (note-type media in KB) */
export interface NotebookExtInfo {
	notebook_id: string;
}

/** get_media_info 响应 / get_media_info response */
export interface GetMediaInfoResponse {
	media_type: number;
	url_info?: URLInfo;
	notebook_ext_info?: NotebookExtInfo;
}

interface GetMediaInfoData {
	media_type: number;
	url_info?: URLInfo;
	notebook_ext_info?: NotebookExtInfo;
}

/** 知识条目 / Knowledge item */
export interface KnowledgeInfo {
	media_id: string;
	title: string;
	parent_folder_id: string;
	/** 媒体类型，11=笔记 / Media type, 11=note */
	media_type: number;
}

interface ListKnowledgeResponse {
	knowledge_list: KnowledgeInfo[];
	is_end: boolean;
	next_cursor: string;
}

// IMA API 有两种响应外层格式：
// Notes API 用 code/msg，Knowledge Base API 用 retcode/errmsg
// IMA API has two response wrapper formats:
// Notes API uses code/msg, Knowledge Base API uses retcode/errmsg
interface ImaApiResponse<T> {
	code?: number;
	retcode?: number;
	msg?: string;
	errmsg?: string;
	data: T;
}

// ─── IMA API 客户端 / IMA API client ────────────────────────────────────────

export class ImaClient {
	constructor(
		private readonly clientId: string,
		private readonly apiKey: string,
	) {}

	/** 通用 POST 请求 / Generic POST request */
	private async post<T>(path: string, body: unknown): Promise<T> {
		const response = await requestUrl({
			url: `${BASE_URL}/${path}`,
			method: 'POST',
			headers: {
				'ima-openapi-clientid': this.clientId,
				'ima-openapi-apikey': this.apiKey,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			throw: false,
		});

		// 调试：记录真实响应 / Debug: log raw response
		debugLog(`status=${response.status} path=${path}`);
		debugLog(`text=${response.text}`);

		const result = response.json as ImaApiResponse<T>;

		// 兼容两种响应格式：Notes API (code/msg) 和 Knowledge Base API (retcode/errmsg)
		// Compatible with two response formats: Notes API (code/msg) and Knowledge Base API (retcode/errmsg)
		const retcode = result.retcode ?? result.code ?? -1;
		const errmsg = result.errmsg ?? result.msg ?? 'unknown error';
		if (retcode !== 0) {
			throw new Error(`IMA API 错误 (${retcode}): ${errmsg}`);
		}
		return result.data;
	}

	/**
	 * 分页拉取所有笔记，仅返回 modify_time > sinceTime 的条目
	 * Fetch all notes, filtered by modify_time > sinceTime
	 */
	async listAllNotes(sinceTime = 0): Promise<DocBasic[]> {
		const notes: DocBasic[] = [];
		let cursor = '';

		while (true) {
			const result = await this.post<ListNotesResponse>(
				'openapi/note/v1/list_note_by_folder_id',
				{ folder_id: '', cursor, limit: 20 },
			);

			for (const item of result.note_book_list) {
				const basic = item.basic_info.basic_info;
				// 跳过已删除的笔记 / Skip deleted notes
				if (basic.status !== 0) continue;
				// 增量同步：只处理上次同步后修改的笔记
				// Incremental sync: only process notes modified after last sync
				if (basic.modify_time > sinceTime) {
					notes.push(basic);
				}
			}

			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return notes;
	}

	/**
	 * 获取单篇笔记的 Markdown 内容（含动态重签名的图片 URL）
	 * Get note content as Markdown (with dynamically re-signed image URLs)
	 *
	 * format=1 每次调用均对图片 URL 重新签名，可解决 format=2 静态签名过期问题
	 * format=1 re-signs image URLs on every call, solving the stale signature issue of format=2
	 */
	async getNoteContentMarkdown(docId: string): Promise<string> {
		const result = await this.post<GetDocContentResponse>(
			'openapi/note/v1/get_doc_content',
			{
				doc_id: docId,
				// 1=Markdown 格式，图片 URL 为每次调用时动态重签名的新鲜 COS URL
				// 1=Markdown format, image URLs are dynamically re-signed on each call
				target_content_format: 1,
			},
		);
		return result.content;
	}

	/**
	 * 获取可添加内容的知识库列表
	 * Get list of knowledge bases the user can add content to
	 */
	async listKnowledgeBases(): Promise<AddableKnowledgeBaseInfo[]> {
		const bases: AddableKnowledgeBaseInfo[] = [];
		let cursor = '';

		while (true) {
			const result = await this.post<ListAddableKBResponse>(
				'openapi/wiki/v1/get_addable_knowledge_base_list',
				{ cursor, limit: 50 },
			);
			bases.push(...result.addable_knowledge_base_list);
			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return bases;
	}

	/**
	 * 搜索/列出知识库，含 base_type 区分订阅/个人
	 * Search/list knowledge bases, with base_type distinguishing subscribed/personal
	 */
	async searchKnowledgeBases(query = ''): Promise<SearchedKnowledgeBase[]> {
		const bases: SearchedKnowledgeBase[] = [];
		let cursor = '';

		while (true) {
			const result = await this.post<SearchKBResponse>(
				'openapi/wiki/v1/search_knowledge_base',
				{ query, cursor, limit: 20 },
			);
			bases.push(...result.info_list);
			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return bases;
	}

	/**
	 * 分页拉取知识库中所有条目（仅文件，不含文件夹）
	 * Fetch all items in a knowledge base (files only, not folders)
	 */
	async listAllKnowledgeItems(knowledgeBaseId: string): Promise<KnowledgeInfo[]> {
		const items: KnowledgeInfo[] = [];
		let cursor = '';

		while (true) {
			const result = await this.post<ListKnowledgeResponse>(
				'openapi/wiki/v1/get_knowledge_list',
				{ knowledge_base_id: knowledgeBaseId, cursor, limit: 50 },
			);
			items.push(...result.knowledge_list);
			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return items;
	}

	/**
	 * 从知识库条目的 media_id 提取笔记 doc_id
	 * 格式：note_<userId>_<docId>，提取最后一个 _ 之后的部分
	 * Extract note doc_id from knowledge item's media_id
	 * Format: note_<userId>_<docId>, extract the part after the last _
	 */
	extractDocIdFromMediaId(mediaId: string): string | null {
		// media_id 格式：note_<userId>_<docId>
		// 只取最后一个 _ 之后的内容作为 docId
		// media_id format: note_<userId>_<docId>
		// Only take the part after the last _ as docId
		if (!mediaId.startsWith('note_')) return null;
		const lastUnder = mediaId.lastIndexOf('_');
		if (lastUnder < 0) return null;
		return mediaId.slice(lastUnder + 1);
	}

	/**
	 * 获取知识库条目的媒体信息（含访问 URL 或笔记 ID）
	 * Get media info for a knowledge base item (includes access URL or note ID)
	 */
	async getMediaInfo(mediaId: string): Promise<GetMediaInfoResponse> {
		const data = await this.post<GetMediaInfoData>(
			'openapi/wiki/v1/get_media_info',
			{ media_id: mediaId },
		);
		return {
			media_type: data.media_type,
			url_info: data.url_info,
			notebook_ext_info: data.notebook_ext_info,
		};
	}

	/**
	 * 通过加密 kb_id 获取知识库信息（含数字 KB ID）
	 * Get KB info by encrypted kb_id (includes numeric KB ID)
	 */
	async getKnowledgeBaseInfo(encryptedKbId: string): Promise<{ id: string; name: string }> {
		const data = await this.post<{ infos: Record<string, { id: string; name: string }> }>(
			'openapi/wiki/v1/get_knowledge_base',
			{ ids: [encryptedKbId] },
		);
		const info = data.infos?.[encryptedKbId];
		if (!info?.id) throw new Error(`知识库信息获取失败：${encryptedKbId}`);
		return info;
	}

	/**
	 * 通过加密 kb_id 获取知识库根文件夹 ID（用于 cgi-bin 接口的 knowledge_base_id 参数）
	 * Get KB root folder_id via private get_knowledge_list (used as knowledge_base_id for cgi-bin APIs)
	 */
	async getKbFolderId(encryptedKbId: string): Promise<string> {
		const result = await this.post<{ current_path: Array<{ folder_id: string }> }>(
			'openapi/wiki/v1/get_knowledge_list',
			{ knowledge_base_id: encryptedKbId, cursor: '', limit: 1 },
		);
		return result.current_path?.[0]?.folder_id ?? '';
	}
}

// ─── 公共知识库 API 客户端（无需认证）/ Public KB API client (no auth) ────────

/** 公共知识库条目 / Public KB item from cgi-bin API */
export interface PublicKBItem {
	media_id: string;
	title: string;
	media_type: number;
	parent_folder_id: string;
	/** 预览文本 / Preview text */
	introduction: string;
	/** AI 摘要 / AI abstract */
	abstract: string;
	/** 微信文章/文件直链 / Direct URL for WeChat articles/files */
	raw_file_url: string;
	/** 网页原链接 / Original URL for webpages */
	source_path: string;
	/** 封面图 / Cover image URLs */
	cover_urls: string[];
	/** 文件大小 / File size */
	file_size: string;
	/** 创建时间（Unix 毫秒）/ Create time (Unix ms) */
	create_time: string;
	/** 更新时间（Unix 毫秒）/ Update time (Unix ms) */
	update_time: string;
	/** 最后修改时间（Unix 毫秒）/ Last modify time (Unix ms) */
	last_modify_time: string;
	/** 文件夹信息（media_type=99 时有值）/ Folder info (when media_type=99) */
	folder_info: {
		folder_id: string;
		name: string;
		file_number: string;
		folder_number: string;
		parent_folder_id: string;
	} | null;
}

/** 公共知识库元信息 / Public KB metadata */
export interface PublicKBInfo {
	id: string;
	name: string;
	description: string;
	creator: string;
	member_count: number;
	content_count: number;
	/** 知识库更新时间（Unix 秒）/ KB update time (Unix seconds) */
	update_timestamp_sec: string;
}

/** get_share_info / get_knowledge_list 响应 / Response from cgi-bin APIs */
interface PublicKBListResponse {
	knowledge_base_info: {
		id: string;
		basic_info: {
			name: string;
			description: string;
			creator: { nickname: string };
			update_timestamp_sec: string;
		};
		member_info: { member_count: string };
	};
	knowledge_list: PublicKBItem[];
	is_end: boolean;
	next_cursor: string;
	current_path: Array<{
		folder_id: string;
		name: string;
	}>;
}

/** 公共知识库设置条目 / Public KB settings entry */
export interface PublicKnowledgeBase {
	/** 加密 kb_id（从 search_knowledge_base 获取）/ Encrypted kb_id */
	encryptedKbId: string;
	/** 数字 KB ID / Numeric KB ID */
	numericKbId: string;
	/** shareId（手动添加时有值）/ shareId (when manually added) */
	shareId: string;
	/** 知识库名称 / KB name */
	name: string;
	/** 上次同步时间戳（毫秒），0 = 从未同步 / Last sync timestamp (ms), 0 = never */
	lastSyncTime: number;
	/** 知识库分类（共享知识库/订阅和公共知识库）/ KB category */
	kbCategory?: string;
}

export class ImaPublicClient {
	/** 通用 POST 请求（无认证）/ Generic POST request (no auth) */
	private async post<T>(path: string, body: unknown): Promise<T> {
		const response = await requestUrl({
			url: `${BASE_URL}/${path}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			throw: false,
		});

		debugLog(`status=${response.status} path=${path}`);
		debugLog(`text=${response.text}`);

		const result = response.json as { code?: number; msg?: string; data?: T };
		const code = result.code ?? -1;
		const msg = result.msg ?? 'unknown error';
		if (code !== 0) {
			throw new Error(`IMA 公共 API 错误 (${code}): ${msg}`);
		}
		// cgi-bin API 可能将数据放在 data 中或直接在顶层
		// cgi-bin API may put data in `data` or at top level
		return (result.data ?? result) as T;
	}

	/**
	 * 通过 shareId 获取共享知识库信息及条目列表
	 * Get shared KB info and item list via shareId
	 */
	async getShareInfo(
		shareId: string,
		folderId = '',
		cursor = '',
		limit = 20,
	): Promise<PublicKBListResponse> {
		return await this.post<PublicKBListResponse>(
			'cgi-bin/knowledge_share_get/get_share_info',
			{ share_id: shareId, cursor, limit, folder_id: folderId },
		);
	}

	/**
	 * 通过数字 KB ID 获取公共知识库条目列表（无需认证、无需 shareId）
	 * Get public KB item list via numeric KB ID (no auth, no shareId needed)
	 */
	async getKnowledgeListPublic(
		numericKbId: string,
		folderId = '',
		cursor = '',
		limit = 20,
	): Promise<PublicKBListResponse> {
		return await this.post<PublicKBListResponse>(
			'cgi-bin/knowledge_tab_reader_nl/get_knowledge_list',
			{
				knowledge_base_id: numericKbId,
				cursor,
				limit,
				folder_id: folderId,
				need_default_cover: true,
				sort_type: 9,
			},
		);
	}

	/**
	 * 从 PublicKBListResponse 提取知识库元信息
	 * Extract KB metadata from response
	 */
	extractKBInfo(response: PublicKBListResponse): PublicKBInfo {
		const kb = response.knowledge_base_info;
		const basic = kb.basic_info;
		return {
			id: kb.id,
			name: basic.name,
			description: basic.description,
			creator: basic.creator.nickname,
			member_count: parseInt(kb.member_info.member_count) || 0,
			content_count: 0,
			update_timestamp_sec: basic.update_timestamp_sec,
		};
	}

	/**
	 * 递归获取公共知识库所有条目（含文件夹层级路径）
	 * Recursively fetch all public KB items with folder path
	 */
	async listAllPublicItems(
		numericKbId: string,
		folderId = '',
		folderPath = '',
	): Promise<Array<PublicKBItem & { folderPath: string }>> {
		return this.listAllItemsRecursive(
			(folderId, cursor) => this.getKnowledgeListPublic(numericKbId, folderId, cursor, 50),
			folderId,
			folderPath,
		);
	}

	/**
	 * 通过 shareId 递归获取所有条目
	 * Recursively fetch all items via shareId
	 */
	async listAllSharedItems(
		shareId: string,
		folderId = '',
		folderPath = '',
	): Promise<Array<PublicKBItem & { folderPath: string }>> {
		return this.listAllItemsRecursive(
			(folderId, cursor) => this.getShareInfo(shareId, folderId, cursor, 50),
			folderId,
			folderPath,
		);
	}

	/**
	 * 递归获取所有条目（通用实现）
	 * Recursively fetch all items (generic implementation)
	 */
	private async listAllItemsRecursive(
		fetchPage: (folderId: string, cursor: string) => Promise<PublicKBListResponse>,
		folderId: string,
		folderPath: string,
	): Promise<Array<PublicKBItem & { folderPath: string }>> {
		const allItems: Array<PublicKBItem & { folderPath: string }> = [];
		let cursor = '';

		while (true) {
			const result = await fetchPage(folderId, cursor);
			for (const item of result.knowledge_list) {
				if (item.media_type === 99 && item.folder_info) {
					const subPath = folderPath
						? `${folderPath}/${item.folder_info.name}`
						: item.folder_info.name;
					const subItems = await this.listAllItemsRecursive(fetchPage, item.folder_info.folder_id, subPath);
					allItems.push(...subItems);
				} else if (item.media_type !== 99) {
					allItems.push({ ...item, folderPath });
				}
			}
			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return allItems;
	}

	/**
	 * 从分享链接或文本中解析 shareId
	 * Parse shareId from share link or text
	 */
	static parseShareId(input: string): string | null {
		const trimmed = input.trim();
		// 完整 URL: https://ima.qq.com/wiki/?shareId=xxx
		const urlMatch = trimmed.match(/shareId=([a-f0-9]+)/i);
		if (urlMatch && urlMatch[1]) return urlMatch[1];
		// 纯 64 位十六进制字符串 / Bare 64-char hex string
		if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed;
		return null;
	}
}
