import Defuddle from 'defuddle/full';
import type { DefuddleOptions } from 'defuddle/full';

// ─── HTML→Markdown 转换器（基于 defuddle）/ HTML→Markdown converter (defuddle-based) ────

/** 转换结果 / Conversion result */
export interface HtmlToMdResult {
	title: string;
	/** 作者 / Author */
	author: string;
	/** 发布时间（ISO 日期或日期时间字符串）/ Published time (ISO date or datetime string) */
	published: string;
	content: string;
}

/**
 * 将 HTML 转换为 Markdown
 * Convert HTML to Markdown using defuddle (built for Obsidian Web Clipper)
 *
 * @param html    原始 HTML 字符串 / Raw HTML string
 * @param options 转换选项 / Conversion options
 */
export function convertHtmlToMarkdown(
	html: string,
	options?: {
		/** 页面 URL，用于解析相对链接 / Page URL for resolving relative links */
		url?: string;
		/** 强制正文选择器，如微信文章用 '#js_content' / Force content selector, e.g. '#js_content' for WeChat */
		contentSelector?: string;
	},
): HtmlToMdResult {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	const defuddleOpts: DefuddleOptions = {
		url: options?.url,
		markdown: true,
		useAsync: false,
	};

	if (options?.contentSelector) {
		defuddleOpts.contentSelector = options.contentSelector;
	}

	const result = new Defuddle(doc, defuddleOpts).parse();

	// defuddle 可能提取不到 published，对微信文章从原始 HTML 补充提取
	// defuddle may not extract published; for WeChat articles, supplement from raw HTML
	let published = result.published ?? '';
	if (!published && options?.url && options.url.includes('mp.weixin.qq.com')) {
		published = extractWeChatPublishTime(html) ?? '';
	}

	return {
		title: result.title ?? '',
		author: result.author ?? '',
		published,
		content: result.content ?? '',
	};
}

/**
 * 从微信文章 HTML 中提取发布时间
 * Extract publish time from WeChat article HTML
 *
 * 微信文章发布时间存在于内联 JS 变量中：
 * - var ct = "1777188638" （Unix 秒时间戳，最可靠）
 * - var createTime = '2026-04-26 15:30' （预格式化字符串）
 * 以及 DOM 元素 <em id="publish_time">2026年4月26日 15:30</em>
 */
function extractWeChatPublishTime(html: string): string | null {
	// 优先从 JS 变量 ct 提取 Unix 时间戳（最可靠）
	// Prefer JS variable ct (Unix timestamp, most reliable)
	const ctMatch = html.match(/var\s+ct\s*=\s*"(\d+)"/);
	if (ctMatch?.[1]) {
		try {
			const date = new Date(Number(ctMatch[1]) * 1000);
			if (!isNaN(date.getTime())) {
				return date.toISOString().slice(0, 19);
			}
		} catch { /* ignore */ }
	}

	// 次选从 createTime 变量提取预格式化字符串
	// Fallback to createTime variable (pre-formatted string)
	const createMatch = html.match(/var\s+createTime\s*=\s*'(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})'/);
	if (createMatch?.[1]) {
		try {
			// "2026-04-26 15:30" → "2026-04-26T15:30"
			const date = new Date(createMatch[1].replace(' ', 'T'));
			if (!isNaN(date.getTime())) {
				return date.toISOString().slice(0, 19);
			}
		} catch { /* ignore */ }
	}

	return null;
}
