import { Vault, normalizePath, requestUrl } from 'obsidian';
import type { AttachmentOptions } from './image-handler';
import type { LinkFormat } from './settings';

// ─── 共享常量 / Shared constants ─────────────────────────────────────────────

/** Chrome UA 字符串，用于反盗链伪装 / Chrome UA string for anti-hotlink spoofing */
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── 文件名清理 / Filename sanitization ──────────────────────────────────────

/** 清理文件名中的非法字符 / Sanitize illegal characters in filename */
export function sanitizeFilename(name: string): string {
	return name
		.replace(/[/\\:*?"<>|#^[\]]/g, '_')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
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

/** 提取笔记不含扩展名的基本名 / Extract note basename without extension */
export function extractNoteBasename(noteFilePath: string): string {
	return noteFilePath
		.replace(/^.*\//, '')
		.replace(/\.md$/, '');
}

/**
 * 解析附件文件夹路径：syncFolder/attachments/{kbCategory}/{kbName}
 * Resolve attachment folder path: syncFolder/attachments/{kbCategory}/{kbName}
 */
export function resolveAttachmentFolder(opts: AttachmentOptions): string {
	const base = normalizePath(`${opts.syncFolder}/attachments`);
	if (opts.kbCategory && opts.kbName) {
		return normalizePath(`${base}/${sanitizeFilename(opts.kbCategory)}/${sanitizeFilename(opts.kbName)}`);
	}
	if (opts.kbName) {
		return normalizePath(`${base}/${sanitizeFilename(opts.kbName)}`);
	}
	return base;
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

	const ups = Array(fromParts.length - common).fill('..');
	const downs = toParts.slice(common);
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
 * HEAD 请求检查附件是否超过大小限制
 * HEAD request to check if attachment exceeds size limit
 */
export async function exceedsSizeLimit(url: string, limitBytes: number, extraHeaders?: Record<string, string>): Promise<boolean> {
	try {
		const response = await requestUrl({
			url,
			method: 'HEAD',
			headers: { 'User-Agent': CHROME_UA, ...extraHeaders },
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
 * 从 URL path 提取文件名（不含签名参数），用于生成稳定的本地文件名
 * Extract filename from URL path (without signature params), for stable local filenames
 *
 * 例如 /note/abc123/photo.png?sign=xxx → "photo.png"
 */
export function extractFilenameFromUrl(url: string): string {
	try {
		const urlObj = new URL(url);
		const segments = urlObj.pathname.split('/').filter(s => s.length > 0);
		const lastSegment = segments[segments.length - 1];
		if (lastSegment) {
			return decodeURIComponent(lastSegment);
		}
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
	options: { titleBase?: string; fallbackName: string; fallbackExt?: string },
): string {
	let filename = '';
	let ext = '';
	try {
		const urlObj = new URL(url);
		const segments = urlObj.pathname.split('/').filter(s => s.length > 0);
		const lastSegment = segments[segments.length - 1];
		if (lastSegment) {
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

	const safeTitle = sanitizeTitle(options.titleBase, options.fallbackName);
	const baseFilename = filename || `${options.fallbackName}${ext}`;
	return sanitizeFilename(`${safeTitle}-${sanitizeFilename(baseFilename)}`);
}

/** 根据 URL 猜测文件扩展名 / Guess file extension from URL */
export function guessFileExtension(url: string): string {
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
