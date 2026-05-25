import Defuddle from 'defuddle/full';
import type { DefuddleOptions, DefuddleResponse } from 'defuddle/full';

// ─── HTML→Markdown 转换器（基于 defuddle）/ HTML→Markdown converter (defuddle-based) ────

/** defuddle npm 发布版暂缺 authorUrl 字段，本地扩展 / npm release of defuddle is missing authorUrl; local extension */
interface DefuddleResult extends DefuddleResponse {
	authorUrl?: string;
}

/** 转换结果 / Conversion result */
export interface HtmlToMdResult {
	title: string;
	/** 作者 / Author */
	author: string;
	/** 作者主页 URL / Author profile URL */
	authorUrl?: string;
	/** 发布时间（ISO 日期或日期时间字符串）/ Published time (ISO date or datetime string) */
	published: string;
	content: string;
	/** 标记内容来自微信 meta 提取（缺图片），调用方可添加警告 / Indicates WeChat meta-extracted content (no images) */
	fromMeta?: boolean;
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
		/** 预解析的 Document（避免重复 parseFromString）/ Pre-parsed Document (avoids duplicate parseFromString) */
		doc?: Document;
	},
): HtmlToMdResult {
	const doc = options?.doc ?? (() => {
		const parser = new DOMParser();
		return parser.parseFromString(html, 'text/html');
	})();

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
		authorUrl: (result as DefuddleResult).authorUrl,
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
	const ctMatch = html.match(/var\s+ct\s*=\s*["'](\d+)["']/);
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

// ─── 微信 JS 渲染文章 meta 提取 / WeChat JS-rendered article meta extraction ──

/**
 * 解码微信 meta 标签中的 C 风格转义序列（\x0a → 换行, \x26 → & 等）
 * Decode C-style escape sequences in WeChat meta tags
 * 注意：使用 String.fromCharCode 而非 decodeURIComponent，避免 UTF-8 解码破坏中文
 * Note: uses String.fromCharCode instead of decodeURIComponent to avoid corrupting CJK characters
 */
function decodeWeChatMetaEscapes(raw: string): string {
	let result = '';
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === '\\' && raw[i + 1] === 'x' && i + 4 <= raw.length) {
			const hex = raw.substring(i + 2, i + 4);
			const code = parseInt(hex, 16);
			if (!isNaN(code)) {
				result += String.fromCharCode(code);
				i += 3;
				continue;
			}
		}
		result += raw[i];
	}
	return result;
}

/**
 * 从微信 JS 渲染文章的 og:description meta 中提取正文
 * Extract article body from og:description meta in WeChat JS-rendered pages
 * 返回 null 表示：#js_content 已存在（用标准 defuddle）或 meta 标签缺失
 */
function extractWeChatMetaContent(
	doc: Document,
): { bodyHtml: string; title: string } | null {
	// #js_content 存在时走标准 defuddle，不进入 meta 提取
	// Skip meta extraction when #js_content exists (standard defuddle handles it)
	if (doc.getElementById('js_content')) return null;

	const ogDesc = doc.querySelector<HTMLMetaElement>('meta[property="og:description"]');
	if (!ogDesc?.content) return null;

	// 两层解码：\x 转义 → HTML 实体（单次正则避免顺序依赖）
	// Two-layer decode: \x escapes → HTML entities (single regex avoids ordering dependency)
	const ENTITY_MAP: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"' };
	let decoded = decodeWeChatMetaEscapes(ogDesc.content)
		.replace(/&(lt|gt|amp|quot);/g, (_, e: string) => ENTITY_MAP[e] ?? '');

	// 按双换行分段，包裹 <p> 标签
	// Split by double newlines, wrap in <p> tags
	const paragraphs = decoded.split('\n\n').filter(p => p.trim());
	const bodyParts = paragraphs.map(p => {
		const trimmed = p.trim();
		return `<p>${trimmed}</p>`;
	});

	const bodyHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><article>${bodyParts.join('\n')}</article></body></html>`;

	// 提取 og:title / Extract og:title
	const ogTitle = doc.querySelector<HTMLMetaElement>('meta[property="og:title"]');
	const title = ogTitle?.content ?? '';

	return { bodyHtml, title };
}

/**
 * 微信文章 HTML → Markdown（自动选择最优提取策略）
 * WeChat article HTML → Markdown (auto-selects best extraction strategy)
 *
 * Tier 1: #js_content 存在 → defuddle + contentSelector（完整图文）
 * Tier 2: og:description meta 提取 → defuddle（完整文本，缺图片，标记 fromMeta）
 * Tier 3: 裸 defuddle + extractWeChatPublishTime（最后尝试）
 */
/**
 * 检测微信页面中可用的内容容器选择器
 * Detect available WeChat page content container selector
 *
 * 微信文章有多种页面模板：标准 #js_content、图片分享页 .share_content_page 等
 * WeChat articles use multiple page templates: standard #js_content, image share .share_content_page, etc.
 */
function detectWeChatContentSelector(doc: Document): string | null {
	// 与 headless-extractor.ts WECHAT_CONTENT_SELECTORS 保持同步
	// Keep in sync with WECHAT_CONTENT_SELECTORS in headless-extractor.ts

	// 标准图文（需足够文本，防止空壳 div 误判）/ Standard article (must have enough text)
	const jsContent = doc.getElementById('js_content');
	if (jsContent && (jsContent.textContent?.trim().length || 0) > 50) {
		return '#js_content';
	}
	// 图片分享页（文本少但图多）/ Image share page (little text but many images)
	const shareContent = doc.querySelector('.share_content_page');
	if (shareContent) {
		const textLen = shareContent.textContent?.trim().length || 0;
		const imgCount = shareContent.querySelectorAll('img').length;
		if (textLen > 30 || imgCount >= 2) return '.share_content_page';
	}
	// 小说卡片（嵌入标准图文中）/ Novel card (embedded in standard articles)
	const novelCard = doc.getElementById('js_novel_card');
	if (novelCard && novelCard.textContent?.trim()) {
		return '#js_novel_card';
	}
	// 视频消息 — 有标题即认为有效（正文在 og:description 中）/ Video article
	const videoTitle = doc.getElementById('js_video_page_title');
	if (videoTitle && videoTitle.textContent?.trim()) {
		return '#js_video_page_title';
	}
	// 音频消息 / Audio article
	const audioTitle = doc.getElementById('js_audio_title');
	if (audioTitle && audioTitle.textContent?.trim()) {
		return '#js_audio_title';
	}
	// 富文本后备 / Rich media fallback
	const richMedia = doc.getElementById('js_image_content') || doc.querySelector('.rich_media_content');
	if (richMedia && (richMedia.textContent?.trim().length || 0) > 30) {
		return richMedia.id ? `#${richMedia.id}` : '.rich_media_content';
	}
	return null;
}

/**
 * 检测是否为微信验证/拦截页（非真实文章）
 * Check if the page is a WeChat verification/block page (not a real article)
 */
function isWeChatBlockPage(doc: Document): boolean {
	return !!doc.querySelector('.weui-msg')
		|| (doc.body?.textContent || '').includes('环境异常')
		|| /TCaptcha/i.test(doc.body?.innerHTML || '');
}

/**
 * 从微信 HTML 中提取正文内的图片 URL 并转为 Markdown
 * Extract in-content image URLs from WeChat HTML and convert to Markdown
 *
 * 用于弥补 defuddle 对图片分享页等格式过滤图片的缺陷
 * Compensates for defuddle filtering images in formats like image share pages
 */
function extractWeChatImages(html: string, doc: Document, existingContent: string): string {
	const seen = new Set<string>();
	const parts: string[] = [];

	// 先收集已有 Markdown 中的图片 URL 用于去重 / Collect existing Markdown image URLs for dedup
	const mdImgRegex = /!\[.*\]\((https?:\/\/[^)]+)\)/g;
	let mdMatch: RegExpExecArray | null;
	while ((mdMatch = mdImgRegex.exec(existingContent)) !== null) {
		if (mdMatch[1]) seen.add(mdMatch[1]);
	}

	// 全 DOM 搜索 img 标签 / Search all img tags in DOM
	for (const img of Array.from(doc.querySelectorAll('img'))) {
		const imgUrl = img.getAttribute('data-src') || img.src;
		if (!imgUrl || !/^https?:\/\//.test(imgUrl)) continue;
		// 过滤系统资源 / Filter system resources
		if (imgUrl.includes('pic_blank.gif')) continue;
		if (imgUrl.includes('res.wx.qq.com/mmbizappmsg')) continue;
		if (seen.has(imgUrl)) continue;
		seen.add(imgUrl);
		parts.push(`![${(img as HTMLImageElement).alt || ''}](${imgUrl})`);
	}

	// data-src 模式补充（可能在非 img 标签内）/ data-src supplement (may be in non-img tags)
	const dataSrcRegex = /data-src="(https?:\/\/[^"]+?(?:mmbiz|qpic)[^"]+?)"/gi;
	let dsMatch;
	while ((dsMatch = dataSrcRegex.exec(html)) !== null) {
		const imgUrl = dsMatch[1] as string;
		if (!seen.has(imgUrl)) {
			seen.add(imgUrl);
			parts.push(`![](${imgUrl})`);
		}
	}

	return parts.length > 0 ? parts.join('\n') + '\n' : '';
}

export function convertWeChatHtmlToMarkdown(html: string, url?: string): HtmlToMdResult {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// 拦截页快速返回空内容，让调用方进入 headless 或兜底
	// Block page fast return empty content, let caller fall back to headless or placeholder
	if (isWeChatBlockPage(doc)) {
		return { title: '', author: '', published: '', content: '' };
	}

	let result: HtmlToMdResult;

	// Tier 1: 已知内容容器 / Known content containers
	const selector = detectWeChatContentSelector(doc);
	if (selector) {
		result = convertHtmlToMarkdown(html, { url, contentSelector: selector, doc });
	} else {
		// Tier 2: og:description meta 提取 / meta tag extraction
		const metaResult = extractWeChatMetaContent(doc);
		if (metaResult) {
			const r = convertHtmlToMarkdown(metaResult.bodyHtml, { url });
			const publishedFromCt = extractWeChatPublishTime(html);
			result = {
				title: r.title || metaResult.title,
				author: r.author,
				authorUrl: r.authorUrl,
				published: r.published || publishedFromCt || '',
				content: r.content,
				fromMeta: true,
			};
		} else {
			// Tier 3: 裸 defuddle（内部已对微信 URL 调用 extractWeChatPublishTime）
			// Tier 3: bare defuddle (internally calls extractWeChatPublishTime for WeChat URLs)
			result = convertHtmlToMarkdown(html, { url });
		}
	}

	// 所有路径统一补充图片 + 去重 / Supplement images for ALL paths with dedup
	const resultContent = result.content || '';
	const imagesMarkdown = extractWeChatImages(html, doc, resultContent);
	if (imagesMarkdown && resultContent) {
		result.content = result.content.trimEnd() + '\n' + imagesMarkdown;
		// Tier 2 (og:description) 补到图后清除 fromMeta，避免 headless 冗余触发
		// Tier 2 (og:description) got images — clear fromMeta to avoid redundant headless
		// Tier 1/3 的 fromMeta 保持原值（undefined），让 hasOrphanImages 继续生效
		// Tier 1/3 keep original fromMeta (undefined) so hasOrphanImages can still trigger headless
		if (result.fromMeta) {
			result.fromMeta = false;
		}
	}

	return result;
}
