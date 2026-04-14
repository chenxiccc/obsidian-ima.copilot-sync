import { requestUrl, Plugin } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';

// IMA API base URL / IMA API 基础地址
const BASE_URL = 'https://ima.qq.com';

// 调试日志文件路径（插件目录下）/ Debug log file path (under plugin directory)
let debugLogPath = '';
// 是否启用调试日志 / Whether debug logging is enabled
let debugLogEnabled = false;

/** 初始化日志路径 / Initialize log path */
export function initDebugLog(plugin: Plugin): void {
	// @ts-ignore — Obsidian 内部属性，用于获取插件目录 / Obsidian internal property for plugin dir
	const pluginDir = (plugin.app.vault.adapter as { basePath: string }).basePath;
	debugLogPath = path.join(pluginDir, '.obsidian', 'plugins', 'obsidian-ima-sync', 'ima-debug.log');
}

/** 更新调试日志开关 / Update debug log enabled state */
export function setDebugLogEnabled(enabled: boolean): void {
	debugLogEnabled = enabled;
}

/** 追加写入调试日志（仅在开关开启时有效）/ Append to debug log (only when enabled) */
function debugLog(msg: string): void {
	if (!debugLogEnabled || !debugLogPath) return;
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		fs.appendFileSync(debugLogPath, line, 'utf8');
	} catch {
		// 写日志失败不影响主流程 / Log write failure doesn't affect main flow
	}
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
	 * 获取单篇笔记的纯文本内容
	 * Get plain text content of a single note
	 */
	async getNoteContent(docId: string): Promise<string> {
		const result = await this.post<GetDocContentResponse>(
			'openapi/note/v1/get_doc_content',
			{
				doc_id: docId,
				// 2=JSON 格式，可包含图片等富文本内容
				// 2=JSON format, can include images and rich text content
				target_content_format: 2,
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
}
