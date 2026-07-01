import { requestUrl } from 'obsidian';
import type { DataAdapter, RequestUrlResponse } from 'obsidian';

// IMA API base URL / IMA API 基础地址
const BASE_URL = 'https://ima.qq.com';

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
	folder_info?: {
		folder_id: string;
		name: string;
		file_number?: string;
		folder_number?: string;
		parent_folder_id?: string;
	} | null;
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

// ─── 自定义错误类 / Custom error class ────────────────────────────────────────

/** IMA API 错误，携带业务错误码 / IMA API error with business error code */
export class ImaApiError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(`IMA API 错误 (${code}): ${message}`);
		this.name = 'ImaApiError';
	}
}

// 限频错误码集合（网关 200001 / notes 20002 / wiki 110021 / 20005）+ errmsg 关键词兜底
// 20005 为 issue #3 用户报告码，文档未记录、本地无法 curl 验证；errmsg 关键词用于覆盖未来新增码
// Rate-limit code set (gateway 200001 / notes 20002 / wiki 110021 / 20005) + errmsg keyword fallback
// 20005 reported in issue #3, not in docs, cannot verify via curl locally; errmsg keywords cover future new codes
const RATE_LIMIT_CODES = new Set([200001, 20002, 110021, 20005]);
// errmsg 关键词：覆盖码集合之外的新增限频码（如每日配额类）
// 刻意不匹配 limit（过宽，用 rate limit 替代）、exceed/超过（会误伤 210009「单篇笔记超过最大限制」等非限频错误）
// errmsg keywords: cover new rate-limit codes outside the set (e.g. daily-quota ones)
// Intentionally not matching limit (too broad, use rate limit), exceed/超过 (would mismatch 210009 etc.)
const RATE_LIMIT_MSG_PATTERNS = [
	// 中文：频率 / 限频 / 频控 / 限流 / 稍后重试 / 过于频繁 / 请求频繁 / 配额 / 每日 / 超限
	/频率/, /限频/, /频控/, /限流/, /稍后重试/, /过于频繁/, /请求频繁/, /配额/, /每日/, /超限/,
	// 英文：rate limit / too many requests / throttl / quota / daily / retry later / frequent
	/rate\s*limit/i, /too many requests/i, /throttl/i, /quota/i, /daily/i, /retry later/i, /frequent/i,
];

/** 判断是否限频错误（码命中 OR errmsg 关键词命中）/ Rate-limit check (code hit OR errmsg keyword hit) */
export function isRateLimitError(err: unknown): err is ImaApiError {
	if (!(err instanceof ImaApiError)) return false;
	if (RATE_LIMIT_CODES.has(err.code)) return true;
	return RATE_LIMIT_MSG_PATTERNS.some(p => p.test(err.message));
}

/** 格式化错误消息用于用户展示 / Format error message for user display */
export function formatImaError(err: unknown): string {
	if (err instanceof ImaApiError) {
		// 200002：鉴权失败 / API Key 过期，引导用户续期
		// 200002: auth failed / API Key expired, guide user to renew
		if (err.code === 200002) {
			return 'API Key已过期，请到 ima客户端→Claw设置 进行一键续期';
		}
		// 限频码：已退避重试耗尽仍被限，提示稍后重试，并保留服务器原始 msg 便于排障
		// Rate-limit codes: backoff exhausted, prompt to retry later, keeping the server's original msg for debugging
		if (isRateLimitError(err)) {
			return `请求频率超限，请稍后重试（${err.message}）`;
		}
	}
	return err instanceof Error ? err.message : String(err);
}

/** 类型守卫：判断是否为指定错误码的 ImaApiError / Type guard for ImaApiError with optional code match */
export function isImaApiError(err: unknown, code?: number): err is ImaApiError {
	return err instanceof ImaApiError && (code === undefined || err.code === code);
}

// ─── IMA API 客户端 / IMA API client ────────────────────────────────────────

export class ImaClient {
	private debugPath = '';
	private debugAdapter: DataAdapter | null = null;
	private debugEnabled = false;

	// ── 限频保护 / Rate-limit protection ───────────────────────────────────
	// 全局节流：任意两次 openapi 请求之间至少间隔 MIN_REQUEST_INTERVAL_MS
	// Global throttle: at least MIN_REQUEST_INTERVAL_MS between any two openapi requests
	private static readonly MIN_REQUEST_INTERVAL_MS = 200;
	// 退避梯度：10s → 30s → 90s（限频命中后等窗口充分冷却再重试，避免反复撞墙）
	// Backoff schedule: 10s → 30s → 90s (let the rate-limit window cool down fully before retry, avoid repeated hits)
	private static readonly RATE_LIMIT_BACKOFF_MS = [10_000, 30_000, 90_000];
	// 链路层未知错误码（JSON 解析失败 / 非 JSON 响应 / 缺 data 字段等），区别于业务码
	// Link-layer unknown error code (JSON parse failure / non-JSON response / missing data field etc.), distinct from business codes
	private static readonly UNKNOWN_ERROR_CODE = -1;
	// 上次请求完成的时间戳，用于节流 / Last request completion timestamp, for throttling
	private lastRequestTime = 0;

	constructor(
		private readonly clientId: string,
		private readonly apiKey: string,
		debug?: { adapter: DataAdapter; path: string },
	) {
		if (debug) {
			this.debugAdapter = debug.adapter;
			this.debugPath = debug.path;
		}
	}

	/** 更新调试日志开关（由 settings 调用）/ Set debug log enabled (called from settings) */
	setDebugEnabled(enabled: boolean): void {
		this.debugEnabled = enabled;
	}

	/** 追加写入调试日志 / Append to debug log */
	private debugLog(msg: string): void {
		if (!this.debugEnabled || !this.debugPath || !this.debugAdapter) return;
		const line = `[${new Date().toISOString()}] ${msg}\n`;
		void this.debugAdapter.append(this.debugPath, line);
	}

	/**
	 * 单次 POST 请求（含全局节流，不含退避重试）/ Single POST request (with global throttle, no backoff retry)
	 *
	 * 解析响应并校验：非 JSON / 非 200 / 业务码非 0 均抛 ImaApiError，由调用方决定是否重试
	 * Parses and validates the response: non-JSON / non-200 / non-zero business code all throw ImaApiError;
	 * the caller decides whether to retry
	 */
	private async postOnce<T>(path: string, body: unknown): Promise<T> {
		// 全局节流：保证两次 openapi 请求间隔 ≥ MIN_REQUEST_INTERVAL_MS，避免突发尖峰触发限频
		// Global throttle: ensure ≥ MIN_REQUEST_INTERVAL_MS between openapi requests to avoid burst rate-limiting
		await this.throttle();

		// requestUrl 的 throw:false 只压制 HTTP 4xx/5xx，不保证 JSON 解析成功
		// （WAF 拦截会返回 HTML 重定向页，response.json 可能为 null/undefined）
		// requestUrl's throw:false only suppresses HTTP 4xx/5xx, not JSON parse failures
		// (WAF blocks return an HTML redirect page, response.json may be null/undefined)
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
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
		} catch (err) {
			// 网络层错误（超时、连接失败）包装成 ImaApiError，避免裸 Error 泄漏给用户
			// Network-layer errors (timeout, connection failure) wrapped as ImaApiError to avoid leaking raw Errors
			throw new ImaApiError(ImaClient.UNKNOWN_ERROR_CODE, `网络请求失败 / Network request failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		// 调试：记录真实响应 / Debug: log raw response
		this.debugLog(`status=${response.status} path=${path}`);
		this.debugLog(`text=${response.text}`);

		// 非 JSON 响应（WAF 拦截返回 HTML 等）：包装成 ImaApiError，避免 result.retcode 抛 TypeError
		// Non-JSON response (WAF HTML etc.): wrap as ImaApiError to avoid TypeError on result.retcode
		const result: unknown = response.json;
		if (result === null || result === undefined || typeof result !== 'object') {
			throw new ImaApiError(
				ImaClient.UNKNOWN_ERROR_CODE,
				`HTTP ${response.status} 非 JSON 响应 / non-JSON response (可能被 WAF 拦截，请检查网络或稍后重试)`,
			);
		}
		const typed = result as ImaApiResponse<T>;

		// 兼容两种响应格式：Notes API (code/msg) 和 Knowledge Base API (retcode/errmsg)
		// Compatible with two response formats: Notes API (code/msg) and Knowledge Base API (retcode/errmsg)
		const retcode = typed.retcode ?? typed.code ?? ImaClient.UNKNOWN_ERROR_CODE;
		const errmsg = typed.errmsg ?? typed.msg ?? 'unknown error';

		if (retcode !== 0) {
			throw new ImaApiError(retcode, errmsg);
		}

		// code=0 但缺 data 字段（意外空响应）：抛错避免下游解构 undefined
		// code=0 but missing data field (unexpected empty response): throw to avoid undefined destructuring downstream
		if (typed.data === undefined || typed.data === null) {
			throw new ImaApiError(ImaClient.UNKNOWN_ERROR_CODE, '响应缺少 data 字段 / response missing data field');
		}
		return typed.data;
	}

	/**
	 * 通用 POST 请求（全局节流 + 限频退避重试）/ Generic POST request (global throttle + rate-limit backoff)
	 *
	 * 命中限频码（200001/20002/110021/20005 或 errmsg 关键词命中）按梯度退避重试（10s → 30s → 90s），耗尽才抛出；其他错误立即抛出
	 * On rate-limit (200001/20002/110021/20005 or errmsg keyword match) retries with backoff (10s → 30s → 90s), throws only after exhausted;
	 * other errors throw immediately
	 */
	private async post<T>(path: string, body: unknown): Promise<T> {
		let attempt = 0;
		// 循环重试：仅对限频码退避重试，其他错误由 postOnce 立即抛出
		// Retry loop: only backoff on rate-limit codes; other errors throw immediately from postOnce
		while (true) {
			try {
				return await this.postOnce<T>(path, body);
			} catch (err) {
				// 非限频码错误立即向上抛出 / Non-rate-limit errors propagate immediately
				if (!isRateLimitError(err)) {
					throw err;
				}
				// 限频码但退避次数耗尽：抛出，由 formatImaError 转成用户提示
				// Rate-limit code but backoff exhausted: throw, formatImaError turns it into a user-facing message
				if (attempt >= ImaClient.RATE_LIMIT_BACKOFF_MS.length) {
					throw err;
				}
				const backoff = ImaClient.RATE_LIMIT_BACKOFF_MS[attempt]!;
				this.debugLog(`rate-limited (code=${err.code}), retry ${attempt + 1}/${ImaClient.RATE_LIMIT_BACKOFF_MS.length} after ${backoff}ms`);
				await this.sleep(backoff);
				attempt++;
			}
		}
	}

	/** 节流：若距上次请求不足 MIN_REQUEST_INTERVAL_MS，则 sleep 补足 / Throttle: sleep to fill the gap if too soon */
	private async throttle(): Promise<void> {
		const now = Date.now();
		const elapsed = now - this.lastRequestTime;
		if (elapsed < ImaClient.MIN_REQUEST_INTERVAL_MS) {
			await this.sleep(ImaClient.MIN_REQUEST_INTERVAL_MS - elapsed);
		}
		this.lastRequestTime = Date.now();
	}

	/** Promise 化的 sleep / Promise-based sleep */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}

	/**
	 * 轻量探测：仅发一次 limit=1 请求验证凭证有效性，不遍历全部笔记
	 * Lightweight probe: a single limit=1 request to verify credentials, without fetching all notes
	 *
	 * 用于「测试连接」按钮，避免 listAllNotes 的 while 翻页密集请求触发网关限频 (200001)
	 * Used by the "Test connection" button to avoid the dense paging of listAllNotes
	 * triggering gateway rate limiting (200001)
	 *
	 * 走 postOnce（单次、不退避）：测试连接应快速返回，命中限频立即抛出而非等 130s 退避
	 * Uses postOnce (single, no backoff): test connection should return fast,
	 * throw immediately on rate-limit instead of waiting through the 130s backoff
	 */
	async testConnection(): Promise<void> {
		// limit=1 即可在 code=0 时判定凭证有效，无需关心返回的笔记内容
		// limit=1 is enough to confirm credentials valid on code=0, note content is irrelevant
		await this.postOnce<ListNotesResponse>(
			'openapi/note/v1/list_note_by_folder_id',
			{ folder_id: '', cursor: '', limit: 1 },
		);
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
	async listAllKnowledgeItems(knowledgeBaseId: string): Promise<Array<KnowledgeInfo & { folderPath: string }>> {
		return this.listAllKnowledgeItemsRecursive(knowledgeBaseId, '', '');
	}

	private getKnowledgeFolderInfo(item: KnowledgeInfo): { folderId: string; name: string } | null {
		if (item.folder_info?.folder_id) {
			return {
				folderId: item.folder_info.folder_id,
				name: item.folder_info.name || item.title,
			};
		}

		if (item.media_type !== 99 || !item.media_id.startsWith('folder_')) return null;

		return {
			folderId: item.media_id,
			name: item.title,
		};
	}

	private async listAllKnowledgeItemsRecursive(
		knowledgeBaseId: string,
		folderId: string,
		folderPath: string,
	): Promise<Array<KnowledgeInfo & { folderPath: string }>> {
		const items: Array<KnowledgeInfo & { folderPath: string }> = [];
		let cursor = '';

		while (true) {
			const body: {
				knowledge_base_id: string;
				folder_id?: string;
				cursor: string;
				limit: number;
			} = { knowledge_base_id: knowledgeBaseId, cursor, limit: 50 };
			if (folderId) body.folder_id = folderId;

			const result = await this.post<ListKnowledgeResponse>(
				'openapi/wiki/v1/get_knowledge_list',
				body,
			);
			for (const item of result.knowledge_list) {
				const folder = this.getKnowledgeFolderInfo(item);
				if (folder) {
					const subPath = folderPath
						? `${folderPath}/${folder.name}`
						: folder.name;
					const subItems = await this.listAllKnowledgeItemsRecursive(
						knowledgeBaseId,
						folder.folderId,
						subPath,
					);
					items.push(...subItems);
				} else if (item.media_type !== 99) {
					items.push({ ...item, folderPath });
				}
			}
			if (result.is_end) break;
			cursor = result.next_cursor;
		}

		return items;
	}

	/**
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
	/** 解析进度 0~100，100=完成 / Parse progress 0~100, 100=complete */
	parse_progress: number;
	/** 摘要状态，2=已完成 / Summary state, 2=complete */
	summary_state: number;
	/** 媒体状态，2=正常 / Media state, 2=normal */
	media_state: number;
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

		console.debug(`ima.copilot Sync: status=${response.status} path=${path}`);
		console.debug(`ima.copilot Sync: text=${response.text}`);

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
