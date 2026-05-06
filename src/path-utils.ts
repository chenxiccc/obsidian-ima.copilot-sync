import { Vault, normalizePath, requestUrl } from 'obsidian';
import type { AttachmentOptions } from './image-handler';

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
 * 根据模式解析附件文件夹的实际路径
 * Resolve the actual attachment folder path based on mode
 */
export function resolveAttachmentFolder(vault: Vault, noteFilePath: string, opts: AttachmentOptions): string {
	const noteDir = extractNoteDir(noteFilePath);
	const noteBasename = extractNoteBasename(noteFilePath);

	switch (opts.pathMode) {
		case 'subfolder':
			return normalizePath(`${opts.syncFolder}/${opts.subfolderName || 'attachments'}`);
		case 'obsidian': {
			const setting: string =
				(vault as unknown as { getConfig(k: string): string }).getConfig('attachmentFolderPath')
				?? 'attachments';
			if (!setting || setting === '/') return normalizePath('/');
			if (setting.startsWith('./')) {
				return normalizePath(`${noteDir}/${setting.slice(2)}`);
			}
			return normalizePath(setting);
		}
		case 'samename':
			return normalizePath(`${opts.syncFolder}/${noteBasename}`);
		default:
			return normalizePath(`${opts.syncFolder}/attachments`);
	}
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
