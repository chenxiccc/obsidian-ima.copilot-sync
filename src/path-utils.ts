import { Vault, normalizePath, requestUrl } from 'obsidian';

// ─── 共享类型定义 / Shared type definitions ────────────────────────────────

/** 链接格式 / Link format */
export type LinkFormat = 'auto' | 'wikilink' | 'markdown';

/** 下载开关与限制 / Download toggles and limits */
export interface DownloadConfig {
	downloadImages: boolean;
	downloadFiles: boolean;
	imageSizeLimitBytes: number;
	fileSizeLimitBytes: number;
	antiHotlinkEnhanced: boolean;
}

/** 附件选项 / Attachment options */
export interface AttachmentOptions extends DownloadConfig {
	linkFormat: LinkFormat;
}

/** 图片命名上下文 / Image naming context */
export interface ImageNamingContext {
	titleBase?: string;
}

/** 创建默认图片命名上下文 / Create default image naming context */
export function createNamingContext(titleBase?: string): ImageNamingContext {
	return { titleBase };
}

// ─── 文件名清理 / Filename sanitization ──────────────────────────────────────

/** 清理文件名中的非法字符 / Sanitize illegal characters in filename */
export function sanitizeFilename(name: string): string {
	let result = name
		.replace(/[/\\:*?"<>|#^[\]]/g, '_')
		.replace(/\s+/g, ' ')
		.trim();
	// 去除首尾点号和空格（Windows 兼容）/ Strip leading/trailing dots and spaces (Windows compat)
	// 参考 Share to Save text-utils.ts:89-101 / Ref: Share to Save text-utils.ts:89-101
	result = result.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
	// 空值回退 / Empty fallback
	if (!result) result = 'untitled';
	return result;
}

/** 清理标题为安全文件名片段（空格→连字符，特殊字符→下划线）/ Sanitize title for filename segment (spaces→hyphens, special chars→underscores) */
export function sanitizeTitle(name: string | undefined, fallback = 'img'): string {
	return name
		? name.replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '_')
		: fallback;
}

// ─── 路径工具 / Path utilities ──────────────────────────────────────────────

/** 提取笔记所在目录 / Extract directory of a note path */
export function extractNoteDir(noteFilePath: string): string {
	return noteFilePath.includes('/')
		? noteFilePath.substring(0, noteFilePath.lastIndexOf('/'))
		: '';
}

/**
 * 解析附件文件夹路径：笔记所在目录/attachments
 * Resolve attachment folder path: note directory/attachments
 */
export function resolveAttachmentFolder(noteFilePath: string): string {
	const dir = extractNoteDir(noteFilePath);
	return normalizePath(dir ? `${dir}/attachments` : 'attachments');
}

/**
 * 计算从 fromDir 到 toPath 的相对路径
 * Calculate relative path from fromDir to toPath
 */
export function calcRelativePath(fromDir: string, toPath: string): string {
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

	const ups = Array<string>(fromParts.length - common).fill('..');
	const downs: string[] = toParts.slice(common);
	return [...ups, ...downs].join('/') || '.';
}

/** 确保文件夹存在 / Ensure folder exists */
export async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	const exists = await vault.adapter.exists(normalized);
	if (!exists) {
		await vault.createFolder(normalized);
	}
}

/**
 * 递归列出文件夹下所有 .md 文件（vault 相对路径）
 * Recursively list all .md files under a folder (vault-relative paths)
 *
 * 用 adapter.list 而非 metadataCache/fileMap：读盘兜底，索引未就绪时同样可用
 * Uses adapter.list instead of metadataCache/fileMap: disk-based fallback, works while the cache isn't ready
 */
export async function listMdPathsInFolder(vault: Vault, folderPath: string): Promise<string[]> {
	const result: string[] = [];
	const stack = [normalizePath(folderPath)];

	while (stack.length > 0) {
		const current = stack.pop()!;
		try {
			const listed = await vault.adapter.list(current);
			for (const file of listed.files) {
				if (file.endsWith('.md')) {
					result.push(normalizePath(file)); // adapter.list() 返回 vault 相对路径 / adapter.list() returns vault-relative paths
				}
			}
			for (const folder of listed.folders) {
				stack.push(normalizePath(folder));
			}
		} catch {
			// 文件夹不存在时跳过 / Skip if folder doesn't exist
		}
	}

	return result;
}

// ─── 同步标识解析（读盘兜底）/ Sync identifier parsing (disk fallback) ────────

/**
 * 从文件内容开头的 YAML frontmatter 中读取指定字段
 * Read a field from the leading YAML frontmatter of a file's content
 *
 * 不依赖 metadataCache：Obsidian 尚未索引（或 YAML 解析失败）时仍可识别 media_id/docid
 * Does not rely on metadataCache: still resolves media_id/docid when Obsidian hasn't indexed yet
 * (or when its YAML parse failed)
 */
export function extractFrontmatterValue(content: string, key: string): string | null {
	if (!content) return null;
	// 去掉 BOM / Strip BOM
	const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const lines = text.split('\n');
	// frontmatter 必须位于文件首行 / Frontmatter must start on the first line
	if ((lines[0] ?? '').replace(/\r$/, '').trim() !== '---') return null;

	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const matcher = new RegExp(`^${escapedKey}\\s*:\\s*(.*)$`);

	for (let i = 1; i < lines.length; i++) {
		const line = (lines[i] ?? '').replace(/\r$/, '');
		if (line.trim() === '---') break; // frontmatter 结束 / End of frontmatter
		const match = matcher.exec(line);
		if (!match) continue;

		let value = (match[1] ?? '').trim();
		// 去成对引号 / Strip surrounding quotes
		const quote = value.charAt(0);
		if (value.length > 1 && (quote === '"' || quote === "'") && value.charAt(value.length - 1) === quote) {
			value = value.slice(1, -1);
		}
		return value.length > 0 ? value : null;
	}

	return null;
}

// ─── 文件名与重复副本判据 / Filenames and duplicate-copy detection ───────────

/** 同步标识的短后缀（末 12 位，非单词字符归一为下划线）/ Short suffix of a sync id (last 12 chars, non-word chars → underscore) */
export function shortIdOf(uniqueId: string): string {
	return uniqueId.replace(/\W+/g, '_').slice(-12);
}

/** 提取笔记文件名基名（去目录、去扩展名）/ Extract note file basename (no directory, no extension) */
export function extractNoteBaseName(filePath: string): string {
	const name = filePath.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** 判断文件名是否为「原名-同步标识后缀」形式的副本 / Whether a basename is a "<name>-<short id>" copy */
export function isSuffixedCopyName(basename: string, uniqueId: string): boolean {
	const suffix = `-${shortIdOf(uniqueId)}`;
	return basename.length > suffix.length && basename.endsWith(suffix);
}

/**
 * 归一化笔记正文用于重复副本比对：去 frontmatter、清空链接目标、折叠空白
 * Normalize a note body for duplicate comparison: drop frontmatter, blank out link targets, collapse whitespace
 *
 * 同一篇被重复落盘时，图片/附件文件名会带上级联后缀（…-hex12-hash.png），
 * 因此必须忽略链接目标本身，只比较正文结构
 * A duplicated note has cascaded-suffix attachment names (…-hex12-hash.png), so link targets
 * themselves must be ignored; only the body structure is compared
 */
export function normalizeNoteBodyForCompare(content: string): string {
	const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const lines = text.split('\n');
	let body = text;

	if ((lines[0] ?? '').replace(/\r$/, '').trim() === '---') {
		for (let i = 1; i < lines.length; i++) {
			if ((lines[i] ?? '').replace(/\r$/, '').trim() === '---') {
				body = lines.slice(i + 1).join('\n');
				break;
			}
		}
	}

	// wikilink / embed：保留 alias，清空目标 / Wikilink and embed: keep alias, drop target
	body = body.replace(/(!?)\[\[([^\]]*)\]\]/g, (_match: string, bang: string, inner: string) => {
		const bar = inner.indexOf('|');
		return bar >= 0 ? `${bang}[[${inner.slice(bar)}]]` : `${bang}[[]]`;
	});
	// Markdown 图片与链接：保留 alt/text，清空路径 / Markdown images and links: keep alt/text, drop path
	body = body.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match: string, alt: string) => `![${alt}]()`);
	body = body.replace(/\[([^\]]*)\]\([^)]*\)/g, (_match: string, label: string) => `[${label}]()`);

	return body.replace(/\s+/g, ' ').trim();
}

// CHROME_UA 已迁移至 http-utils.ts，此处重导出以保持向后兼容
// CHROME_UA moved to http-utils.ts, re-exported here for backward compatibility
export { CHROME_UA } from './http-utils';
import { contentTypeToExt } from './http-utils';

/**
 * HEAD 请求检查附件是否超过大小限制
 * HEAD request to check if attachment exceeds size limit
 */
export async function exceedsSizeLimit(url: string, limitBytes: number, extraHeaders?: Record<string, string>): Promise<boolean> {
	try {
		const response = await requestUrl({
			url,
			method: 'HEAD',
			headers: extraHeaders,
			throw: false,
		});
		const contentLength = response.headers?.['content-length'];
		if (contentLength && Number(contentLength) > limitBytes) {
			return true;
		}
	} catch { /* HEAD 失败时不阻止下载 / Don't block download if HEAD fails */ }
	return false;
}

// ─── 链接格式 / Link format ──────────────────────────────────────────────────

/** 解析链接格式（auto → 读取 vault 配置）/ Resolve link format (auto → read vault config) */
export function resolveLinkFormat(vault: Vault, format: LinkFormat): 'wikilink' | 'markdown' {
	if (format !== 'auto') return format;
	const useMarkdown = (vault as unknown as { getConfig(k: string): boolean })
		.getConfig('useMarkdownLinks') ?? false;
	return useMarkdown ? 'markdown' : 'wikilink';
}

// ─── 扩展名推断 / Extension guessing ─────────────────────────────────────────

/** 从 URL 路径提取扩展名 / Extract extension from URL path */
export function extractExtFromUrl(url: string): string {
	try {
		const urlObj = new URL(url);
		const lastSegment = urlObj.pathname.split('/').pop() ?? '';
		const dotIdx = lastSegment.lastIndexOf('.');
		if (dotIdx > 0) return lastSegment.slice(dotIdx).toLowerCase();
	} catch { /* ignore */ }
	return '';
}

/**
 * 从 URL 构建稳定的本地文件名：单次 URL 解析同时提取文件名和扩展名，
 * 结合 title 前缀，确保同一 URL 始终生成同一文件名
 * Build stable local filename from URL: single URL parse extracts both filename and extension,
 * combines with title prefix, ensuring same URL always produces same filename
 */
export function buildStableFilename(
	url: string,
	options: { titleBase?: string; fallbackName: string; fallbackExt?: string; contentType?: string },
): string {
	let filename = '';
	let ext = '';
	try {
		const urlObj = new URL(url);
		const segments = urlObj.pathname.split('/').filter(s => s.length > 0);
		const lastSegment = segments[segments.length - 1];
		// 末尾段是纯数字（如 mmbiz 图片 URL 的 /0），用 URL 短 hash 做唯一标识
		// Last segment is numeric (e.g. /0 in mmbiz image URLs), use short URL hash as unique identifier
		if (lastSegment && /^\d+$/.test(lastSegment)) {
			filename = shortHash(url);
		} else if (lastSegment) {
			filename = decodeURIComponent(lastSegment);
			const dotIdx = filename.lastIndexOf('.');
			if (dotIdx > 0) {
				ext = filename.slice(dotIdx).toLowerCase();
			}
		}
	} catch { /* ignore */ }

	if (!ext) {
		ext = extractExtFromUrl(url) || guessFileExtension(url) || options.fallbackExt || '';
	}

	// Content-Type 修正（优先级：wx_fmt > Content-Type > URL 扩展名）
	// Content-Type correction (priority: wx_fmt > Content-Type > URL extension)
	// 当 HTTP 响应的实际内容类型与 URL 扩展名不一致时，用 Content-Type 覆盖
	// When actual content type differs from URL extension, override with Content-Type
	// 参考 Share to Save image-handler.ts:136-149 / Ref: Share to Save image-handler.ts:136-149
	if (options.contentType) {
		const ctExt = contentTypeToExt(options.contentType);
		if (ctExt && ext && ext !== ctExt) {
			// 剥离 filename 中旧扩展名 / Strip old extension from filename
			const dotIdx = filename.lastIndexOf('.');
			if (dotIdx > 0) filename = filename.slice(0, dotIdx);
			ext = ctExt;
		}
		// URL 未识别扩展名但 Content-Type 有值，也采用 / URL had no extension, adopt Content-Type's
		if (ctExt && !ext) {
			ext = ctExt;
		}
	}

	const safeTitle = sanitizeTitle(options.titleBase, options.fallbackName);
	const baseFilename = filename
		? (filename.includes('.') ? filename : `${filename}${ext}`)
		: `${options.fallbackName}${ext}`;
	return sanitizeFilename(`${safeTitle}-${sanitizeFilename(baseFilename)}`);
}

/**
 * 生成 URL 的短哈希（8 位十六进制），用于 mmbiz 等 /0 结尾 URL 的唯一文件名
 * Generate short URL hash (8 hex chars) for unique filenames from /0-ending URLs like mmbiz
 */
function shortHash(url: string): string {
	let hash = 0;
	for (let i = 0; i < url.length; i++) {
		hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
	}
	// 转为 8 位十六进制 + 保留原始低 8 位确保唯一性 / Convert to 8 hex chars with low bits for uniqueness
	// padStart 在部分 lib 配置下缺类型声明退化为 any，用前补零 + slice 等价实现
	// padStart lacks type decl under some lib configs degrading to any; use zero-pad + slice instead
	const unsigned: number = hash >>> 0;
	return ('00000000' + unsigned.toString(16)).slice(-8);
}

/** Markdown 链接路径含空格时用 <> 包裹 / Wrap Markdown link path with <> when it contains spaces */
export function escapePathForMarkdown(relPath: string): string {
	return relPath.includes(' ') ? `<${relPath}>` : relPath;
}

/**
 * 转义正文中非标题的 # 号，避免 Obsidian 误识别为标签
 * Escape inline # to prevent Obsidian tag misidentification
 * YAML frontmatter 区域（--- 之间）不做转义，避免破坏 URL 中的 #fragment
 * YAML frontmatter section (between ---) is skipped to avoid corrupting URL #fragments
 */
export function escapeInlineHash(text: string): string {
	let inFrontmatter = false;
	let fmDelimiterCount = 0;

	return text.split('\n').map(line => {
		if (line.trim() === '---') {
			fmDelimiterCount++;
			inFrontmatter = (fmDelimiterCount % 2 === 1);
			return line;
		}
		if (inFrontmatter) return line;
		// 行首 #{1,6} 后跟空格是标题，保留 / Line starting with #{1,6} followed by space is a heading, preserve
		if (/^#{1,6}\s/.test(line)) return line;
		// 其他 # 后跟非空格字符的，加 \ 转义 / Escape other # followed by non-space
		return line.replace(/(?<!\\)#(?!\s)/g, '\\#');
	}).join('\n');
}

/**
 * 根据 URL 猜测文件扩展名（仅检查 path + query + fragment，排除域名中的类似扩展名字符串）
 * Guess file extension from URL (only checks path + query + fragment, excluding hostname
 * to avoid false matches like .md in community.obsidian.md)
 */
export function guessFileExtension(url: string): string {
	// 微信 CDN 图片：从 wx_fmt 参数推断格式，比 pathname 和 Content-Type 更可靠（参考 Share to Save image-handler.ts:65-76）
	// WeChat CDN images: infer format from wx_fmt param, more reliable than pathname and Content-Type (ref: Share to Save image-handler.ts:65-76)
	try {
		const wxFmt = new URL(url).searchParams.get('wx_fmt');
		if (wxFmt) {
			const fmt = wxFmt.toLowerCase();
			if (fmt === 'jpeg' || fmt === 'jpg') return '.jpg';
			if (fmt === 'png') return '.png';
			if (fmt === 'gif') return '.gif';
			if (fmt === 'webp') return '.webp';
			if (fmt === 'svg') return '.svg';
		}
	} catch { /* ignore parse errors */ }

	// 仅检查 URL 的 path + query + fragment，避免域名中的 .md/.pdf 等被误匹配
	// Only check path + query + fragment, avoid false match on hostname (e.g., .md in obsidian.md)
	let target = url;
	try {
		const u = new URL(url);
		target = u.pathname + u.search + u.hash;
	} catch {
		// 非标准 URL（如纯文件名），使用原值 / Not a standard URL (e.g., plain filename), use as-is
	}

	const lower = target.toLowerCase();
	// 图片扩展名优先（guessFileExtension 主要用于图片 URL 回退场景）
	// Image extensions first (guessFileExtension is primarily used as a fallback for image URLs)
	if (lower.includes('.png')) return '.png';
	if (lower.includes('.jpg') || lower.includes('.jpeg')) return '.jpg';
	if (lower.includes('.gif')) return '.gif';
	if (lower.includes('.webp')) return '.webp';
	if (lower.includes('.svg')) return '.svg';
	// 文档扩展名 / Document extensions
	if (lower.includes('.pdf')) return '.pdf';
	if (lower.includes('.doc') || lower.includes('.docx')) return '.docx';
	if (lower.includes('.ppt') || lower.includes('.pptx')) return '.pptx';
	if (lower.includes('.xls') || lower.includes('.xlsx')) return '.xlsx';
	if (lower.includes('.txt')) return '.txt';
	if (lower.includes('.xmind')) return '.xmind';
	if (lower.includes('.md') || lower.includes('.markdown')) return '.md';
	return '';
}

// ─── 可下载文件判断 / Downloadable file detection ────────────────────────────

/** 可下载的非图片文件扩展名 / Downloadable non-image file extensions */
export const DOWNLOADABLE_FILE_EXTENSIONS = new Set([
	'.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
	'.txt', '.xmind', '.md',
]);

/** 判断 URL 是否指向可下载的非图片文件 / Check if URL points to a downloadable non-image file */
export function isDownloadableFileUrl(url: string): boolean {
	const ext = extractExtFromUrl(url) || guessFileExtension(url);
	return ext !== '' && DOWNLOADABLE_FILE_EXTENSIONS.has(ext);
}

// ─── 站点检测 / Site detection ──────────────────────────────────────────────────

/** 检测是否为小红书页面 / Check if it's a Xiaohongshu page */
export function isXiaohongshuUrl(url: string): boolean {
	return /(?:xiaohongshu\.com|xhslink\.com)/.test(url);
}

/** 检测是否为知乎页面（专栏/问答/想法/回答）/ Check if it's a Zhihu page (column/Q&A/pin/answer) */
export function isZhihuUrl(url: string): boolean {
	return /zhihu\.com\/(question|zhuanlan|pin|answer|p)/.test(url);
}

/** 内容获取策略站点分类 / Content acquisition strategy site classification */
export type SiteClass = 'wechat' | 'xhs' | 'zhihu' | 'generic';

/** 根据 URL 分类站点类型 / Classify site type by URL */
export function classifyUrl(url: string): SiteClass {
	if (/mp\.weixin\.qq\.com/.test(url)) return 'wechat';
	if (isXiaohongshuUrl(url)) return 'xhs';
	if (isZhihuUrl(url)) return 'zhihu';
	return 'generic';
}
