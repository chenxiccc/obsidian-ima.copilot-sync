import type { Vault } from 'obsidian';
import { normalizePath } from 'obsidian';
import {
	extractFrontmatterValue,
	extractNoteBaseName,
	isSuffixedCopyName,
	listMdPathsInFolder,
	normalizeNoteBodyForCompare,
	shortIdOf,
} from './path-utils';

// ─── 重复副本扫描 / Duplicate copy scan ─────────────────────────────────────

/** 可安全回收的重复副本 / A duplicate copy that can be safely recycled */
export interface DuplicatePair {
	/** 副本路径（「原名-同步标识后缀」）/ Copy path ("<name>-<short id>") */
	copyPath: string;
	/** 主档路径（无后缀）/ Canonical path (no suffix) */
	canonicalPath: string;
	/** 两侧一致的同步标识 / Sync id shared by both files */
	id: string;
}

/** 疑似问题 / Needs manual review */
export interface DuplicateAmbiguous {
	copyPath: string;
	reason: string;
}

/** 扫描结果 / Scan result */
export interface DuplicateScanResult {
	/** 可安全清理的成对副本 / Pairs safe to clean */
	pairs: DuplicatePair[];
	/** 有后缀但找不到主档 / Suffixed copies without a canonical file */
	unpaired: string[];
	/** 有主档但 id 不同或正文不一致 / Same-name pairs that differ in id or body */
	ambiguous: DuplicateAmbiguous[];
}

/**
 * 扫描同步文件夹，找出「已同步条目的重复副本」
 * Scan the sync folder for duplicate copies of already-synced items
 *
 * 判据（三者同时满足才可回收）/ Criteria (all three required):
 * 1. 文件名是「原名-<同步标识末12位>」/ basename is "<name>-<last-12-of-sync-id>"
 * 2. 后缀与自身 frontmatter 的 media_id/docid 末 12 位一致 / the suffix matches the file's own sync id
 * 3. 主档存在、同步标识相同、去 frontmatter/链接目标/空白后正文一致 / canonical file exists with the same id and an equivalent body
 *
 * 全程读盘（adapter.read），不依赖 metadataCache，避免索引未就绪时漏判
 * Fully disk-based (adapter.read), independent of metadataCache
 */
export async function findDuplicateCopies(vault: Vault, syncFolder: string): Promise<DuplicateScanResult> {
	const result: DuplicateScanResult = { pairs: [], unpaired: [], ambiguous: [] };
	const mdPaths = await listMdPathsInFolder(vault, normalizePath(syncFolder));
	const contentCache = new Map<string, string | null>();

	const read = async (path: string): Promise<string | null> => {
		const cached = contentCache.get(path);
		if (cached !== undefined) return cached;
		let content: string | null = null;
		try {
			content = await vault.adapter.read(path);
		} catch {
			content = null;
		}
		contentCache.set(path, content);
		return content;
	};

	for (const path of mdPaths) {
		const content = await read(path);
		if (content === null) continue;

		const id = extractFrontmatterValue(content, 'media_id') ?? extractFrontmatterValue(content, 'docid');
		if (!id) continue;

		const basename = extractNoteBaseName(path);
		if (!isSuffixedCopyName(basename, id)) continue;

		const suffix = `-${shortIdOf(id)}`;
		const canonicalBase = basename.slice(0, basename.length - suffix.length);
		const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		const canonicalPath = normalizePath(dir ? `${dir}/${canonicalBase}.md` : `${canonicalBase}.md`);

		const canonical = await read(canonicalPath);
		if (canonical === null) {
			result.unpaired.push(path);
			continue;
		}

		const canonicalId = extractFrontmatterValue(canonical, 'media_id') ?? extractFrontmatterValue(canonical, 'docid');
		if (canonicalId !== id) {
			result.ambiguous.push({ copyPath: path, reason: '主档同步标识不同' });
			continue;
		}

		if (normalizeNoteBodyForCompare(canonical) !== normalizeNoteBodyForCompare(content)) {
			result.ambiguous.push({ copyPath: path, reason: '正文与主档不一致' });
			continue;
		}

		result.pairs.push({ copyPath: path, canonicalPath, id });
	}

	return result;
}
