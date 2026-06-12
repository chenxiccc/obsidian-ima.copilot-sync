import Defuddle from 'defuddle/full';
import type { DefuddleOptions } from 'defuddle/full';
import { escapeInlineHash } from './path-utils';

// ─── HTML→Markdown 转换器（基于 defuddle）/ HTML→Markdown converter (defuddle-based) ────

/** 转换结果 / Conversion result */
export interface HtmlToMdResult {
	title: string;
	/** 作者 / Author */
	author: string;
	/** 发布时间（ISO 日期或日期时间字符串）/ Published time (ISO date or datetime string) */
	published: string;
	content: string;
	/** 标记内容来自微信 meta 提取（缺图片），调用方可添加警告 / Indicates WeChat meta-extracted content (no images) */
	fromMeta?: boolean;
}

/**
 * 将子元素移出并删除包装元素 / Move children out of wrapper and remove it
 * 等价于 defuddle 内部的 unwrapElement() / Equivalent to defuddle's internal unwrapElement()
 */
function unwrapElement(el: Element): void {
	const parent = el.parentNode;
	if (!parent) return;
	while (el.firstChild) {
		parent.insertBefore(el.firstChild, el);
	}
	parent.removeChild(el);
}

/**
 * 将 <a> 内块级子元素（<p>, <div>）展开为行内内容
 * Unwrap block-level children (<p>, <div>) inside <a> tags
 *
 * 修复从私有 defuddle fork (commit e54120c) 迁移为本地预处理。
 * 避免 Turndown 对 <a><p>text</p></a> 生成 [\\n\\ntext\\n\\n](url) 断裂 Markdown。
 * Fix ported from private defuddle fork — prevents broken multiline Markdown links.
 *
 * <a href="/x"><p>text</p></a> → <a href="/x">text</a>
 */
function unwrapBlockChildrenInLinks(doc: Document): void {
	doc.querySelectorAll('a').forEach(link => {
		const href = link.getAttribute('href');
		if (!href || href.startsWith('#')) return;

		const blockChildren = Array.from(link.children).filter(c => {
			const tag = c.nodeName.toLowerCase();
			return tag === 'p' || tag === 'div';
		});
		if (blockChildren.length === 0) return;

		for (const block of blockChildren) {
			// 在展开的块之间插入空格分隔符 / Insert space separator between unwrapped blocks
			const space = doc.createTextNode(' ');
			link.insertBefore(space, block);
			unwrapElement(block);
		}
	});
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
	optionsOrUrl?: {
		/** 页面 URL，用于解析相对链接 / Page URL for resolving relative links */
		url?: string;
		/** 强制正文选择器，如微信文章用 '#js_content' / Force content selector, e.g. '#js_content' for WeChat */
		contentSelector?: string;
		/** 预解析的 Document（避免重复 parseFromString）/ Pre-parsed Document (avoids duplicate parseFromString) */
		doc?: Document;
	} | string,  // 兼容简化调用 convertHtmlToMarkdown(html, url) / Compatible with simple call convertHtmlToMarkdown(html, url)
): HtmlToMdResult {
	const options = typeof optionsOrUrl === 'string' ? { url: optionsOrUrl } : optionsOrUrl;
	const doc = options?.doc ?? (() => {
		const parser = new DOMParser();
		return parser.parseFromString(html, 'text/html');
	})();

	// 预处理：展开 <a> 内块级子元素，防止断裂 Markdown 链接（私有 defuddle fork 修复迁移）
	// Preprocess: unwrap block children in <a> to prevent broken Markdown links (ported from private defuddle fork)
	unwrapBlockChildrenInLinks(doc);

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

	// 构建初始结果 / Build initial result
	const mdResult: HtmlToMdResult = {
		title: result.title ?? '',
		author: result.author ?? '',
		published,
		content: result.content ?? '',
	};

	// 元数据增强：Schema.org JSON-LD + 站点名剥离（参考 Share to Save metadata-extractor.ts）
	// Metadata enhancement: Schema.org JSON-LD + site name stripping (ref: Share to Save metadata-extractor.ts)
	return enhanceMetadata(mdResult, html, doc);
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

	// 次选从 create_time JS 变量提取（参考 Share to Save metadata-extractor.ts:230-250）
	// Fallback to create_time JS variable (ref: Share to Save metadata-extractor.ts:230-250)
	// 匹配多种赋值格式 / Match multiple assignment formats:
	//   create_time: JsDecode('1234567890')
	//   create_time: "1234567890"
	//   create_time: '1234567890'
	const ctPatterns = [
		/create_time\s*[:=]\s*JsDecode\s*\(\s*['"](\d{10})['"]\s*\)/i,
		/create_time\s*[:=]\s*['"](\d{10})['"]/i,
	];
	for (const re of ctPatterns) {
		const ctMatch = html.match(re);
		if (ctMatch?.[1]) {
			try {
				const date = new Date(Number(ctMatch[1]) * 1000);
				if (!isNaN(date.getTime())) {
					return date.toISOString().slice(0, 19);
				}
			} catch { /* ignore */ }
		}
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

// ─── 元数据增强（Schema.org + meta 标签兜底）/ Metadata enhancement ──────────

/** 增强 defuddle 元数据：站点名剥离 + Schema.org JSON-LD 兜底 */
function enhanceMetadata(result: HtmlToMdResult, html: string, doc?: Document): HtmlToMdResult {
	if (!doc) doc = new DOMParser().parseFromString(html, 'text/html');
	const schema = parseSchemaOrg(doc);
	if (result.title) {
		const siteName = getSiteName(doc, schema);
		result.title = stripSiteName(result.title, siteName);
	}
	if (!result.author) result.author = extractAuthor(doc, schema);
	if (!result.published) result.published = extractPublished(doc, schema);
	return result;
}

/** 解析页面中的 schema.org JSON-LD <script> */
function parseSchemaOrg(doc: Document): Record<string, unknown> {
	const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
	for (const script of scripts) {
		try {
			const data = JSON.parse(script.textContent || '') as Record<string, unknown>;
			const graph = data?.['@graph'];
			if (Array.isArray(graph)) {
				for (const item of graph) {
					if (isContentSchema(item)) return item;
				}
			}
			if (isContentSchema(data)) return data;
		} catch { /* JSON invalid */ }
	}
	return {};
}

function isContentSchema(data: unknown): data is Record<string, unknown> {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	const type = typeof d['@type'] === 'string' ? d['@type'] : '';
	return /Article|WebPage|BlogPosting|NewsArticle|Blog|CreativeWork/i.test(type);
}

function getMeta(doc: Document, attr: string, value: string): string {
	try { return doc.querySelector('meta[' + attr + '="' + value + '"]')?.getAttribute('content')?.trim() || ''; } catch { return ''; }
}

function getSchemaString(schema: Record<string, unknown>, path: string): string {
	let current: unknown = schema;
	for (const key of path.split('.')) {
		if (current && typeof current === 'object') {
			current = (current as Record<string, unknown>)[key];
		} else { return ''; }
	}
	return typeof current === 'string' ? current : '';
}

function getSiteName(doc: Document, schema: Record<string, unknown>): string {
	return getMeta(doc, 'property', 'og:site_name')
		|| getMeta(doc, 'name', 'application-name')
		|| getSchemaString(schema, 'publisher.name')
		|| '';
}

/** 剥离 "Title | Site" / "Site | Title" 中的站点名 */
function stripSiteName(rawTitle: string, siteName: string): string {
	if (!siteName || siteName.length < 2) return rawTitle;
	// 防 ReDoS：限制站点名长度 / ReDoS prevention: cap site name length
	if (siteName.length > 100) siteName = siteName.slice(0, 100);
	if (siteName.toLowerCase() === rawTitle.toLowerCase()) return rawTitle;
	const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const sep = '[|\\-\u2013\u2014\u00b7]';
	const suffixRe = new RegExp('\\s*' + sep + '\\s*' + escaped + '\\s*$', 'i');
	if (suffixRe.test(rawTitle)) return rawTitle.replace(suffixRe, '').trim();
	const prefixRe = new RegExp('^\\s*' + escaped + '\\s*' + sep + '\\s*', 'i');
	if (prefixRe.test(rawTitle)) return rawTitle.replace(prefixRe, '').trim();
	return rawTitle;
}

function extractAuthor(doc: Document, schema: Record<string, unknown>): string {
	const metaAuthor = getMeta(doc, 'name', 'author');
	if (metaAuthor) return metaAuthor;
	const articleAuthor = getMeta(doc, 'property', 'article:author');
	if (articleAuthor && !/^https?:\/\//i.test(articleAuthor)) return articleAuthor;
	const schemaAuthor = getSchemaString(schema, 'author.name');
	if (schemaAuthor) return schemaAuthor;
	const relAuthor = doc.querySelector('a[rel="author"]');
	if (relAuthor) { const text = (relAuthor.textContent || '').trim(); if (text && text.length < 100) return text; }
	return '';
}

function extractPublished(doc: Document, schema: Record<string, unknown>): string {
	const publishedMeta = getMeta(doc, 'property', 'article:published_time')
		|| getMeta(doc, 'name', 'publishDate') || getMeta(doc, 'name', 'sailthru.date');
	if (publishedMeta) return publishedMeta;
	const schemaDate = getSchemaString(schema, 'datePublished');
	if (schemaDate) return schemaDate;
	const timeEl = doc.querySelector('time[datetime]');
	if (timeEl) { const dt = timeEl.getAttribute('datetime'); if (dt) return dt; }
	const abbr = doc.querySelector('abbr[itemprop="datePublished"]');
	if (abbr) { const t = abbr.getAttribute('title'); if (t) return t; }
	return '';
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
 * 微信文章内容容器选择器（唯一来源，headless-extractor.ts 从此导入）
 * WeChat article content container selectors (single source, imported by headless-extractor.ts)
 */
export const WECHAT_CONTENT_SELECTORS = [
	'#js_content', '.rich_media_content',
	'.share_content_page',
	'#js_video_page_title',
	'#js_audio_title', '#audio_panel_area',
	'#js_text_title',
	'#js_novel_card',
	'#img-content', '.rich_media',
];

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
	// 参考 Share to Save: headless-extractor.ts:147-150 hasCaptcha()
	const text = doc.body?.textContent || '';
		return text.includes('环境异常')
		|| text.includes('请完成安全验证')
		|| text.includes('操作频繁')
		|| /captcha/i.test(text)
		|| /js_verify/i.test(text)
		|| /verify_container/i.test(text);
}

/**
 * 微信文章 DOM 预处理：data-src 提升、UI 移除、图片去重 → 构建干净 DOM
 * WeChat article DOM preprocessing: data-src promotion, UI removal, image dedup → clean DOM
 *
 * 参考 Share to Save: content-converter.ts:144-247 WeChatConverter.buildCleanHtml()
 * Reference: Share to Save content-converter.ts:144-247
 *
 * 在 defuddle 转换前对 DOM 克隆做预处理，将工作从 Markdown 后正则 hack 转变为转换前 DOM 操作
 * Preprocess DOM clone before defuddle conversion, shifting work from post-Markdown regex hacks
 */
function buildCleanWeChatDom(doc: Document): Document {
	const sourceBody = doc.querySelector('body');
	if (!sourceBody) return doc.implementation.createHTMLDocument('');
	const clone = sourceBody.cloneNode(true) as HTMLElement;

	// ── 1. <img data-src> → <img src>（参考 content-converter.ts:148-154）──
	// Promote data-src on img elements when src is empty/SVG placeholder/pic_blank
	clone.querySelectorAll('img').forEach(img => {
		const ds = img.getAttribute('data-src');
		if (!ds) return;
		const currentSrc = img.getAttribute('src') || '';
		if (!currentSrc || currentSrc.startsWith('data:') || currentSrc.includes('pic_blank')) {
			img.setAttribute('src', ds);
		}
	});

	// ── 2. 父级 <div data-src> → 子 <img src>（Swiper 懒加载陷阱）（参考 content-converter.ts:156-167）──
	// Promote parent <div data-src> to child <img src> for Swiper lazy-loaded images
	clone.querySelectorAll('[data-src]').forEach(el => {
		if (el.tagName === 'IMG') return;
		const ds = el.getAttribute('data-src');
		if (!ds) return;
		el.querySelectorAll('img').forEach(img => {
			if (!img.getAttribute('src') || img.src.includes('pic_blank')) {
				img.setAttribute('src', ds);
			}
		});
	});

	// ── 3. 移除微信 UI 元素（参考 content-converter.ts:169-189）──
	// Remove WeChat UI elements (reward, profile, ads, Swiper indicator, etc.)
	const uiSelectors = [
		'.reward_area', '.reward_qrcode', '.reward_setting',
		'.profile_area', '.profile_inner',
		'.rich_media_area_extra', '.rich_media_meta_list',
		'.reward_area-normal', '.reward_user',
		'#js_pc_qr_code', '.qr_code_pc_outer',
		'[class*="reward"]', '[class*="赞赏"]',
		'#js_reward_area', '#js_bottom_ad',
		'.original_panel', '.global_vip_guide',
		'mp-common-profile', 'mp-common-mpaudio',
		// Swiper 占位符和 UI 元素 / Swiper placeholder and UI elements
		'.share_media_swiper_placeholder',
		'.swiper_indicator_wrp',
		'.swiper_indicator_wrp_pc',
		'.right-bottom_area',
	];
	uiSelectors.forEach(sel => {
		try { clone.querySelectorAll(sel).forEach(n => n.remove()); } catch { /* skip */ }
	});

	// ── 4. 代码块预处理（参考 content-converter.ts:191-228）──
	// Code block preprocessing: merge multi <code>, extract data-lang, unwrap <span>, <br> → newline
	// a) code-snippet__fix 老格式：移除行号 <ul>，解包 <section>
	// Old format: remove line number <ul>, unwrap <section>
	clone.querySelectorAll('.code-snippet__fix').forEach(section => {
		section.querySelectorAll('.code-snippet__line-index').forEach(el => el.remove());
		const p = section.parentNode;
		if (p) {
			while (section.firstChild) p.insertBefore(section.firstChild, section);
			section.remove();
		}
	});
	// b) <pre> 内多 <code> 合并为单 <code> + data-lang → class
	// Merge multi <code> into single <code> + data-lang to class
	clone.querySelectorAll('pre').forEach(pre => {
		const codeEls = Array.from(pre.querySelectorAll(':scope > code'));
		if (codeEls.length > 1) {
			const lines = codeEls.map(c => c.textContent || '');
			const lang = pre.getAttribute('data-lang') || '';
			pre.innerHTML = '';
			const newCode = pre.ownerDocument.createElement('code');
			if (lang) newCode.className = `language-${lang}`;
			newCode.textContent = lines.join('\n');
			pre.appendChild(newCode);
		} else if (codeEls.length === 1 && pre.getAttribute('data-lang')) {
			(codeEls[0] as Element).classList.add(`language-${pre.getAttribute('data-lang')}`);
		}
		// c) 解包所有 <span> 标签（移除语法高亮标签）/ Unwrap all <span>
		pre.querySelectorAll('span').forEach(span => {
			const sp = span.parentNode;
			if (sp) {
				while (span.firstChild) sp.insertBefore(span.firstChild, span);
				span.remove();
			}
		});
		// d) <br> → 换行符 / <br> → newline
		pre.querySelectorAll('br').forEach(br => {
			br.replaceWith(br.ownerDocument.createTextNode('\n'));
		});
	});

	// ── 5. DOM 内图片去重：按 URL pathname，消除 Swiper 循环复制（参考 content-converter.ts:229-244）──
	// Image dedup in DOM: by URL pathname, eliminate Swiper loop duplicates
	const seenPathnames = new Set<string>();
	clone.querySelectorAll('img').forEach(img => {
		const url = img.getAttribute('src') || '';
		if (!url || !/^https?:\/\//.test(url)) return;
		try {
			const p = new URL(url);
			const key = p.hostname.endsWith('.qpic.cn') ? p.origin + p.pathname : url;
			if (seenPathnames.has(key)) {
				img.remove();
			} else {
				seenPathnames.add(key);
			}
		} catch { /* keep image if URL parse fails */ }
	});

	// ── 6. 挂载到新 Document 返回（参考 content-converter.ts:246）──
	// Mount into a new Document (ref: content-converter.ts:246)
	const newDoc = doc.implementation.createHTMLDocument('');
	newDoc.querySelector('body')!.replaceWith(clone);
	return newDoc;
}


/**
 * 标准化 mmbiz 图片 URL 用于去重（去除查询参数，统一子域名）
 * Normalize mmbiz image URL for dedup (strip query params, normalize subdomain)
 *
 * 对 qpic.cn 域名使用 origin + pathname 去重，其他域名保持原 URL
 * For qpic.cn domains, use origin + pathname for dedup; keep original URL for others
 * 参考 Share to Save: content-converter.ts:284-290 normalizeForDedup()
 */
function normalizeImgUrl(url: string): string {
	try {
		const u = new URL(url);
		// qpic.cn 域名去查询参数 / Strip query params for qpic.cn
		if (u.hostname.endsWith('.qpic.cn')) return u.origin + u.pathname;
		return url;
	} catch {
		const idx = url.indexOf('?');
		return idx >= 0 ? url.substring(0, idx) : url;
	}
}

/**
 * 全页扫描补充 Turndown/defuddle 遗漏的图片（最终安全网）
 * Full-page scan to supplement images missed by Turndown/defuddle (final safety net)
 *
 * 过滤策略（按顺序执行，参考 Share to Save: content-converter.ts:271-324 supplementImages()）：
 * Filter strategy (executed in order, ref: Share to Save content-converter.ts:271-324):
 *
 * 1. data-src 优先（懒加载），回退 src / data-src preferred (lazy load), fallback src
 * 2. 系统图排除：pic_blank.gif、res.wx.qq.com/mmbizappmsg / System image exclusion
 * 3. 域名过滤：只保留 mmbiz.qpic.cn（不依赖 URL 参数如 from=appmsg）/ Domain filter: only mmbiz.qpic.cn
 * 4. 推荐缩略图排除：<a> 内图片 / Thumbnail exclusion: images inside <a>
 * 5. 头像排除：.wx_follow_avatar、.jump_author_avatar_con 内图片 / Avatar exclusion
 * 6. 容器边界过滤（核心门槛）：只补充 .img_swiper_area 或 #js_content 内图片 / Container boundary
 * 7. seen 预填充 + URL 归一化去重，防止 Swiper 循环复制 / Seen prefill + URL norm dedup
 */
function extractWeChatImages(doc: Document, existingContent: string): string {
	const seen = new Set<string>();
	const parts: string[] = [];

	// ── 收集已有 Markdown 中的图片 URL 用于去重 / Collect existing Markdown image URLs ──
	const mdImgRegex = /!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g;
	let mdMatch: RegExpExecArray | null;
	while ((mdMatch = mdImgRegex.exec(existingContent)) !== null) {
		if (mdMatch[1]) {
			seen.add(mdMatch[1]);
			seen.add(normalizeImgUrl(mdMatch[1]));
		}
	}

	// ── seen 预填充 / Seen prefill（参考 content-converter.ts:294-301）──
	// 收集已处理容器内图片 URL，防 swiper 循环复制和 Turndown/defuddle 重复
	// Collect image URLs from processed containers to prevent swiper loop dupes
	const prefillContainers = doc.querySelectorAll('.img_swiper_area img, #js_content img');
	for (const el of Array.from(prefillContainers)) {
		const img = el as HTMLImageElement;
		const url = img.getAttribute('data-src') || img.src;
		if (url && /^https?:\/\//.test(url)) {
			seen.add(normalizeImgUrl(url));
		}
	}

	// ── DOM <img> 扫描 / DOM <img> scan（参考 content-converter.ts:304-322）──
	for (const img of Array.from(doc.querySelectorAll('img'))) {
		// 1. data-src 优先（懒加载），回退 src / data-src preferred, fallback src
		const url = img.getAttribute('data-src') || img.src;
		if (!url || !/^https?:\/\//.test(url)) continue;

		// 2. 系统图排除 / System image exclusion
		if (url.includes('pic_blank.gif')) continue;
		if (url.includes('res.wx.qq.com/mmbizappmsg')) continue;

		// 3. 域名过滤：只保留 mmbiz 图片 / Domain filter: only mmbiz images
		if (!url.includes('mmbiz.qpic.cn')) continue;

		// 4. <a> 内 → 推荐阅读缩略图 / Inside <a> → recommendation thumbnail
		if (img.closest('a')) continue;

		// 5. 头像容器内 → 头像 / Inside avatar containers → avatar
		if (img.closest('.wx_follow_avatar, .jump_author_avatar_con')) continue;

		// 6. 容器边界过滤（核心门槛）/ Container boundary (core gate)
		if (!img.closest('.img_swiper_area, #js_content')) continue;

		// 7. URL 归一化去重 / URL normalization dedup
		const dedupKey = normalizeImgUrl(url);
		if (seen.has(dedupKey)) continue;
		seen.add(dedupKey);

		const alt = img.alt || '';
		parts.push(`![${alt}](${url})`);
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

	// ── 检测两区域（参考 Share to Save content-converter.ts:48-67）──
	// Detect two areas (ref: Share to Save content-converter.ts:48-67)
	const jsContent = doc.getElementById('js_content');
	const hasJsContent = jsContent && (jsContent.textContent?.trim().length || 0) > 0;
	const imgSwiperArea = doc.querySelector('.img_swiper_area');
	const hasSwiperImages = imgSwiperArea && imgSwiperArea.querySelectorAll('img').length >= 1;

	// ── 主路径：两区域处理（headless 渲染后 HTML）──
	// Main path: two-area processing (headless-rendered HTML)
	// 区域 1 #js_content（文字 + 类型 A 图片）先于区域 2 .img_swiper_area（类型 B 图片）
	// Area 1 #js_content (text + Type A images) before Area 2 .img_swiper_area (Type B images)
	if (hasJsContent || hasSwiperImages) {
		// DOM 预处理 / DOM preprocessing (ref: buildCleanWeChatDom)
		const cleanedDoc = buildCleanWeChatDom(doc);
		const parts: string[] = [];

		let area1Meta: HtmlToMdResult | null = null;

		// 区域 1: #js_content — 文字 + 类型 A 图片（先入队）
		// Area 1: #js_content — text + Type A images (first in queue)
		if (hasJsContent) {
			area1Meta = convertHtmlToMarkdown(html, { url, contentSelector: '#js_content', doc: cleanedDoc });
			if (area1Meta.content?.trim()) {
				parts.push(area1Meta.content);
			}
		}

		// 区域 2: .img_swiper_area — 类型 B 图片（后入队，确保图片在文字后面）
		// Area 2: .img_swiper_area — Type B images (second in queue, ensures images after text)
		if (hasSwiperImages) {
			const swiperImgs = extractSwiperAreaImages(cleanedDoc);
			if (swiperImgs) {
				parts.push(swiperImgs);
			}
		}

		if (parts.length > 0) {
			const publishTime = extractWeChatPublishTime(html);
			// 作者补充：defuddle 可能提取不到，从 .wx_follow_nickname 补充（参考 content-converter.ts:90-95）
			// Author supplement: defuddle may miss it; use .wx_follow_nickname (ref: content-converter.ts:90-95)
			let author = area1Meta?.author || '';
			if (!author) {
				author = doc.querySelector('.wx_follow_nickname')?.textContent?.trim()
					|| doc.querySelector('#js_name')?.textContent?.trim()
					|| '';
			}

			const result: HtmlToMdResult = {
				title: area1Meta?.title || '',
				author,
				published: area1Meta?.published || publishTime || '',
				content: parts.join('\n'),
			};

			// 安全网：全页补充遗漏图片 / Safety net: supplement missed images
			const imagesMarkdown = extractWeChatImages(doc, result.content);
			if (imagesMarkdown && result.content) {
				result.content = result.content.trimEnd() + '\n' + imagesMarkdown;
			}

			return result;
		}
	}

	// ── 回退路径：无 headless 渲染（静态 HTML 提取）──
	// Fallback path: no headless render (static HTML extraction)
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
	const imagesMarkdown = extractWeChatImages(doc, resultContent);
	if (imagesMarkdown && resultContent) {
		result.content = result.content.trimEnd() + '\n' + imagesMarkdown;
		// Tier 2 (og:description) 补到图后清除 fromMeta，避免 headless 冗余触发
		// Tier 2 recovery: clear fromMeta if images were supplemented
		if (result.fromMeta) {
			result.fromMeta = false;
		}
	}

	// 作者补充（回退路径也适用）/ Author supplement (applies to fallback paths too)
	if (!result.author) {
		result.author = doc.querySelector('.wx_follow_nickname')?.textContent?.trim()
			|| doc.querySelector('#js_name')?.textContent?.trim()
			|| '';
	}

	return result;
}

/**
 * 从预处理后的 DOM 提取 .img_swiper_area 内的图片 URL → Markdown
 * Extract image URLs from .img_swiper_area in preprocessed DOM → Markdown
 *
 * .img_swiper_area 内只有图片，无需要保留的文字，直接用 URL 生成 Markdown
 * .img_swiper_area only contains images, no text worth preserving; generate Markdown directly
 */
function extractSwiperAreaImages(doc: Document): string {
	const swiperArea = doc.querySelector('.img_swiper_area');
	if (!swiperArea) return '';

	const parts: string[] = [];
	const imgs = swiperArea.querySelectorAll('img');
	for (const img of Array.from(imgs)) {
		const url = img.getAttribute('src') || '';
		if (!url || !/^https?:\/\//.test(url)) continue;
		if (url.includes('pic_blank.gif')) continue;
		if (!url.includes('mmbiz.qpic.cn')) continue;
		const alt = img.alt || '';
		parts.push(`![${alt}](${url})`);
	}
	return parts.length > 0 ? parts.join('\n') + '\n' : '';
}



// ─── 小红书文章提取 / Xiaohongshu article extraction ─────────────────────────

// isXiaohongshuUrl 已移至 path-utils.ts 统一管理，此处重新导出以保持向后兼容
// isXiaohongshuUrl moved to path-utils.ts for unified site detection, re-export for backward compat
export { isXiaohongshuUrl } from './path-utils';

/** 小红书 __INITIAL_STATE__ 中的笔记结构 / XHS note structure from __INITIAL_STATE__ */
interface XhsNote {
	type?: string;              // 'video' | 'normal'
	title?: string;
	desc?: string | string[];
	imageList?: Array<{ urlDefault?: string; url?: string }>;
	user?: { nickname?: string; userId?: string };
	time?: number;              // 毫秒 Unix 时间戳 / ms Unix timestamp
}

/**
 * 解析小红书 __INITIAL_STATE__ JSON，返回完整笔记数据
 * Parse Xiaohongshu __INITIAL_STATE__ JSON, returns full note data
 *
 * 采用 share-to-save 的更稳健方式（lines 575-607）：
 * - 贪婪匹配到行尾，lastIndexOf('}') 截断，undefined/NaN 清理
 * Robust parsing per share-to-save approach (lines 575-607):
 * - Greedy match to end, lastIndexOf('}') truncation, undefined/NaN cleanup
 */
function parseXiaohongshuInitialState(html: string): XhsNote | null {
	const match = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*)$/);
	if (!match?.[1]) return null;

	try {
		let jsonStr = match[1].trim();
		// 去掉末尾分号 / Strip trailing semicolon
		jsonStr = jsonStr.replace(/;\s*$/, '');
		// 取最后一个 } 截断，去掉 JSON 后的多余 JS 代码
		// Truncate at last } to remove trailing JS code
		const lastBrace = jsonStr.lastIndexOf('}');
		if (lastBrace >= 0) jsonStr = jsonStr.slice(0, lastBrace + 1);
		// 替换 JSON 中非法的 JS 字面量 / Replace illegal JS literals
		const cleaned = jsonStr.replace(/undefined/g, 'null').replace(/\bNaN\b/g, 'null');
		const json = JSON.parse(cleaned) as Record<string, unknown>;
		const noteDetailMap = (json).note as Record<string, unknown> | undefined;
		const ndm = noteDetailMap?.noteDetailMap as Record<string, unknown> | undefined;
		if (!ndm) return null;
		const noteId = Object.keys(ndm)[0];
		if (!noteId) return null;
		const noteDetail = ndm[noteId] as Record<string, unknown> | undefined;
		return (noteDetail?.note as XhsNote) || null;
	} catch {
		return null;
	}
}

/**
 * 小红书文章 HTML → Markdown
 * Xiaohongshu article HTML → Markdown
 *
 * 优先级：__INITIAL_STATE__（最完整）→ defuddle + contentSelector 回退
 * Priority: __INITIAL_STATE__ (most complete) → defuddle + contentSelector fallback
 *
 * 参考 Share to Save content-converter.ts XiaohongshuConverter (lines 473-618)
 */
export function convertXiaohongshuHtmlToMarkdown(html: string, url?: string): HtmlToMdResult {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');
	const note = parseXiaohongshuInitialState(html);

	if (note) {
		const parts: string[] = [];

		// 视频笔记标记 / Video note indicator
		if (note.type === 'video') {
			parts.push('> [!NOTE] 视频笔记 / Video Note\n');
		}

		// 正文 / Content
		if (note.desc) {
			let text = Array.isArray(note.desc) ? note.desc.join('\n') : String(note.desc);
			// 去除 XHS 话题标记 / Remove XHS topic markers
			text = text.replace(/\[话题\]#?/g, '');
			// 转义 # 防止 Obsidian 标签误识别 / Escape # for Obsidian tag safety
			text = escapeInlineHash(text);
			parts.push(text);
		}

		// 图片 / Images
		const images = (note.imageList || [])
			.map(img => img.urlDefault || img.url || '')
			.filter(Boolean);
		if (images.length > 0) {
			parts.push('');
			parts.push(images.map(u => `![](${u})`).join('\n'));
		}

		const content = parts.join('\n');

		// 元数据 / Metadata
		let title = note.title || '';
		let author = note.user?.nickname || '';
		let published = '';

		// 标题回退：<title> 标签，剥离 " - 小红书" 后缀
		if (!title) {
			const rawTitle = doc.querySelector('title')?.textContent?.trim() || '';
			title = rawTitle.replace(/\s*-\s*小红书\s*$/, '').trim();
		}

		// 发布时间：毫秒时间戳 → 北京时间
		if (note.time != null && note.time > 0) {
			const ms = note.time > 1e12 ? note.time : note.time * 1000;
			const beijing = new Date(ms + 8 * 60 * 60 * 1000);
			if (!isNaN(beijing.getTime())) {
				published = beijing.toISOString().slice(0, 19);
			}
		}

		// 站点名剥离 / Site name stripping
		if (title) {
			title = title.replace(/\s*[-|]\s*小红书\s*$/, '').trim();
		}

		// 仍走 enhanceMetadata 做通用增强（站点名剥离、Schema.org 兜底）
		// Still apply enhanceMetadata for generic improvements (site name stripping, Schema.org fallback)
		const enhanced = enhanceMetadata({ title, author, published, content, fromMeta: false }, html);
		return enhanced;
	}

	// 回退：INITIAL_STATE 解析失败时使用 defuddle（保持原有逻辑）
	// Fallback: use defuddle when INITIAL_STATE parsing fails
	const desc = doc.querySelector('#detail-desc');
	const contentSelector = desc ? '#detail-desc' : '.note-content';
	return convertHtmlToMarkdown(html, { url, contentSelector, doc });
}
// ─── 知乎文章提取 / Zhihu article extraction ──────────────────────────────

// isZhihuUrl 已由 path-utils.ts 导出 / isZhihuUrl exported by path-utils.ts

/**
 * 知乎 js-initialData SSR JSON 结构（精简版，仅时间提取所需字段）
 * Zhihu js-initialData SSR JSON structure (minimal, only fields needed for time extraction)
 *
 * 参考 Share to Save content-converter.ts ZhihuInitialData (lines 471-492)
 */
interface ZhihuInitialData {
	initialState?: {
		entities?: {
			articles?: Record<string, ZhihuArticleInfo>;
			answers?: Record<string, ZhihuAnswerInfo>;
		};
	};
}

interface ZhihuArticleInfo {
	created: number;
	updated: number;
	ipInfo: string;
}

interface ZhihuAnswerInfo {
	createdTime: number;
	updatedTime: number;
	ipInfo: string;
}

// ── 知乎 DOM 预处理 / Zhihu DOM Preprocessing ─────────────────────────────

/** 剥离知乎实体链接 a.RichContent-EntityWord → 纯文本 */
function stripZhihuEntityLinks(doc: Document): void {
	doc.querySelectorAll('a.RichContent-EntityWord').forEach(el => {
		const text = el.textContent || '';
		el.replaceWith(doc.createTextNode(text));
	});
}

/** 移除知乎登录弹窗 / Remove Zhihu login modals */
function removeZhihuLoginModals(doc: Document): void {
	const selectors = ['.signFlowModal', '.Question-mainColumnLogin'];
	selectors.forEach(sel => {
		try { doc.querySelectorAll(sel).forEach(n => n.remove()); } catch { /* skip */ }
	});
}

/**
 * 移除知乎噪声元素：热榜、广告、推荐阅读（安全网，覆盖 sibling 遍历未能处理的场景）
 * Remove Zhihu noise elements: hot list, ads, recommended reading
 * (safety net for cases where sibling traversal misses nested elements)
 */
function removeZhihuNoiseElements(doc: Document): void {
	// 热榜 / Hot search list
	const hotSelectors = [
		'.HotSearchCard', '.HotSearchCard-list', '.HotSearchCard-header',
		'.HotSearchCard-title', '.HotSearchCard-change', '.HotSearchCard-item',
		'.HotSearchCard-itemLink', '.HotSearchCard-heat',
	];
	// 广告容器 / Ad containers
	const adSelectors = [
		'.pc-article-answer-big-img', '.pc-article-answer-text-chain',
	];
	// 推荐阅读 / Recommended reading
	const recSelectors = ['.Recommendations-Main', '.Post-Sub', '.Post-NormalSub'];

	const allSelectors = [...hotSelectors, ...adSelectors, ...recSelectors];
	allSelectors.forEach(sel => {
		try { doc.querySelectorAll(sel).forEach(n => n.remove()); } catch { /* skip */ }
	});
}

/**
 * 知乎 DOM 加粗元素规范化：扁平化嵌套 + bold 后补空格
 * Zhihu DOM bold element normalization: flatten nesting + space after bold
 *
 * 防止 Defuddle 输出 **text**nextChar 导致 Obsidian Live Preview 无法识别关闭 ** 分隔符
 * Prevents **text**nextChar in Defuddle output from breaking Obsidian Live Preview delimiter recognition
 *
 * 参考 Share to Save text-utils.ts:264-289 normalizeBoldElements
 */
function normalizeZhihuBoldElements(doc: Document): void {
	// a. 扁平化嵌套的 strong/b 标签 / Flatten nested strong/b tags
	doc.querySelectorAll('strong strong, strong b, b strong, b b').forEach(el => {
		const parent = el.parentNode;
		if (!parent) return;
		while (el.firstChild) parent.insertBefore(el.firstChild, el);
		el.remove();
	});
	// b. 确保 bold 结束标签后有空格 / Ensure space after bold closing tag
	doc.querySelectorAll('strong, b').forEach(el => {
		const next = el.nextSibling;
		if (!next) return;
		// 文本节点：检查是否以非空白开头 / Text node: check if starts with non-whitespace
		if (next.nodeType === 3) {
			const text = next.textContent || '';
			if (text && !/^\s/.test(text)) {
				next.textContent = ' ' + text;
			}
			return;
		}
		// 元素节点：el.nextSibling === next 表示中间没有文本节点 / no text node between
		if (next.nodeType === 1 && el.nextSibling === next) {
			el.parentNode?.insertBefore(doc.createTextNode(' '), next);
		}
	});
}

/** 判断文本是否像代码（用于代码块识别） */
function isCodeLike(text: string): boolean {
	return /^\s*(?:from\s+|import\s+|def\s+|class\s+|print\s*\(|#\s|if\s+|for\s+|while\s+|\w+\s*=\s*)/m.test(text)
		|| (text.split('\n').length >= 3 && /[=){}[\]]/.test(text));
}

/** 专栏代码块规范化：<th> 代码表 → <pre><code> */
function normalizeTableCodeBlocks(doc: Document): void {
	doc.querySelectorAll('table[data-draft-type="table"]').forEach(table => {
		const cells = Array.from(table.querySelectorAll('th, td'))
			.filter(cell => cell.closest('table') === table);
		if (cells.length !== 1) return;

		const cell = cells[0] as Element;
		const html = cell.innerHTML;
		const codeText = html
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '')
			.replace(/&amp;/g, '&');

		if (!isCodeLike(codeText)) return;
		if (!codeText.trim()) return;

		const pre = doc.createElement('pre');
		const code = doc.createElement('code');
		code.textContent = codeText;
		pre.appendChild(code);
		table.replaceWith(pre);
	});
}

/** 知乎专栏预处理：内容限定 + 代码块规范化 */
function preprocessZhuanlan(doc: Document): void {
	const article = doc.querySelector('article.Post-Main');
	if (article) {
		// .ContentItem-time 作为锚点，删除其后的广告/推荐兄弟；元素本身保留在 article 内
		// Use .ContentItem-time as anchor to remove ad/recommendation siblings; keep the element itself
		const editTime = article.querySelector('.ContentItem-time');
		if (editTime) {
			let sibling: ChildNode | null = editTime.nextSibling;
			while (sibling) {
				const next: ChildNode | null = sibling.nextSibling;
				sibling.remove();
				sibling = next;
			}
		}
		doc.body.innerHTML = '';
		doc.body.appendChild(article);
	}
	normalizeTableCodeBlocks(doc);
}

/** 定位知乎问答页回答正文容器（三层选择器回退） */
function findAnswerContent(doc: Document): Element | null {
	const selectors = [
		'span.RichText.ztext',
		'.RichContent-inner .RichText',
		'.AnswerItem .RichText',
	];
	for (const sel of selectors) {
		const el = doc.querySelector(sel);
		if (el && el.textContent && el.textContent.length > 100) return el;
	}
	return null;
}

/** 问答代码块规范化：div.highlight 去包裹 */
function normalizeHighlightCodeBlocks(doc: Document): void {
	doc.querySelectorAll('div.highlight').forEach(highlight => {
		const pre = highlight.querySelector('pre');
		if (!pre) return;
		const code = pre.querySelector('code');
		if (!code) return;

		// 语言类名从 code → pre，确保 defuddle 识别
		const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
		if (langClass && !pre.classList.contains(langClass)) {
			pre.classList.add(langClass);
		}
		highlight.replaceWith(pre);
	});
}

/** 懒加载图片修复：data-actualsrc → src */
function normalizeZhihuLazyImages(doc: Document): void {
	doc.querySelectorAll('img[data-actualsrc]').forEach(img => {
		const actualSrc = img.getAttribute('data-actualsrc');
		const currentSrc = img.getAttribute('src') || '';
		if (actualSrc && (currentSrc.startsWith('data:') || !currentSrc)) {
			img.setAttribute('src', actualSrc);
		}
	});
}

/**
 * 知乎问答预处理：内容定位 + 正文时间行注入 + 代码块 + 懒加载图片
 * Zhihu answer preprocessing: content scoping + body time injection + code blocks + lazy images
 *
 * bodyText 由 extractZhihuTimeFromInitialData 从 SSR JSON 构建，作为 <span>
 * 注入 answerContent 内部，由 Defuddle 统一输出。替代旧的 .ContentItem-time DOM 克隆。
 * bodyText is built by extractZhihuTimeFromInitialData from SSR JSON, injected as <span>
 * inside answerContent for Defuddle to output. Replaces old .ContentItem-time DOM cloning.
 */
function preprocessAnswer(doc: Document, bodyText?: string): void {
	const answerContent = findAnswerContent(doc);
	if (answerContent) {
		// 从 js-initialData 拼接正文时间行 / Append body time text from SSR
		if (bodyText) {
			const timeSpan = doc.createElement('span');
			timeSpan.textContent = bodyText;
			answerContent.appendChild(timeSpan);
		}
		doc.body.innerHTML = '';
		doc.body.appendChild(answerContent);
	}
	normalizeHighlightCodeBlocks(doc);
	normalizeZhihuLazyImages(doc);
}

/**
 * 知乎 DOM 预处理入口：根据 URL 类型分发
 * Zhihu DOM preprocessing entry: dispatch by URL type
 *
 * 时间提取已迁移至 extractZhihuTimeFromInitialData（SSR 统一入口），
 * 此函数仅负责 DOM 清理和内容限定。bodyText 透传给 preprocessAnswer 注入正文。
 * Time extraction moved to extractZhihuTimeFromInitialData (unified SSR entry);
 * this function handles only DOM cleanup and content scoping. bodyText passed through to preprocessAnswer.
 */
function preprocessZhihuDom(doc: Document, url: string, bodyText?: string): void {
	// 通用清理 / Shared cleanup
	stripZhihuEntityLinks(doc);
	removeZhihuLoginModals(doc);
	removeZhihuNoiseElements(doc);
	normalizeZhihuBoldElements(doc);

	// 按页面类型分发 / Dispatch by page type
	if (/zhuanlan\.zhihu\.com/.test(url)) {
		preprocessZhuanlan(doc);
	} else {
		preprocessAnswer(doc, bodyText);
	}
}

// ── 知乎 SSR 时间提取 / Zhihu SSR Time Extraction ─────────────────────────

/**
 * 从 js-initialData SSR JSON 提取时间信息（专栏和回答统一入口）
 * Extract time info from js-initialData SSR JSON (unified entry for zhuanlan & answer)
 *
 * 返回 / Returns { published, bodyText } | null:
 *   published  — updated/updatedTime → 北京时间 YYYY-MM-DDTHH:mm:ss / Beijing time ISO
 *   bodyText   — "发布于 {created} [{编辑于} {updated}]・{ipInfo}"
 *
 * 参考 Share to Save content-converter.ts extractTimeFromInitialData (lines 856-884)
 */
function extractZhihuTimeFromInitialData(doc: Document, url: string): { published: string; bodyText: string } | null {
	const scriptEl = doc.getElementById('js-initialData');
	if (!scriptEl?.textContent) return null;

	try {
		const data = JSON.parse(scriptEl.textContent) as ZhihuInitialData;
		const entities = data?.initialState?.entities || {};

		// 专栏 / zhuanlan: entities.articles[id]
		const articleMatch = url.match(/\/p\/(\d+)/);
		if (articleMatch?.[1]) {
			const article = entities.articles?.[articleMatch[1]];
			if (article?.created && article?.updated) {
				return buildZhihuTimeResult(article.created, article.updated, article.ipInfo || '');
			}
		}

		// 回答 / answer: entities.answers[id]
		const answerMatch = url.match(/\/answer\/(\d+)/);
		if (answerMatch?.[1]) {
			const answer = entities.answers?.[answerMatch[1]];
			if (answer?.createdTime && answer?.updatedTime) {
				return buildZhihuTimeResult(answer.createdTime, answer.updatedTime, answer.ipInfo || '');
			}
		}
	} catch { /* JSON parse failed */ }

	return null;
}

/**
 * Unix 秒时间戳 → { published, bodyText }
 * Unix seconds timestamps → { published, bodyText }
 *
 * 参考 Share to Save content-converter.ts buildTimeResult (lines 890-908)
 */
function buildZhihuTimeResult(created: number, updated: number, ipInfo: string): { published: string; bodyText: string } {
	// 时间戳 +8h → UTC 方法输出 = 北京时间 / Timestamp +8h → UTC methods output = Beijing time
	const fmtTs = (ts: number) => new Date(ts * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
	const fmtDisplay = (ts: number) => {
		const d = new Date(ts * 1000 + 8 * 60 * 60 * 1000);
		// 用 getUTC* 系列方法，因为 +8h 已做偏移，UTC 方法输出即为北京时间
		// Use getUTC* methods — +8h offset already applied, UTC output = Beijing time
		return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
	};

	const published = fmtTs(updated);
	let bodyText = `发布于 ${fmtDisplay(created)}`;
	if (created !== updated) {
		bodyText += ` 编辑于 ${fmtDisplay(updated)}`;
	}
	bodyText += `・${ipInfo}`;

	return { published, bodyText };
}

/**
 * 折叠知乎 Markdown 链接文本中的换行为空格
 * Collapse newlines in Zhihu Markdown link text to spaces
 *
 * 当 Defuddle 遇到 <a><p>text</p></a> 时（<p> 被 flattenWrapperElements 展开），
 * 会产生 [\n\ntext\n\n](url) 断裂链接。此函数折叠链接文本中的空白为单行。
 * When Defuddle encounters <a><p>text</p></a> (<p> expanded by flattenWrapperElements),
 * it produces [\n\ntext\n\n](url) broken links. This collapses whitespace to single line.
 *
 * 参考 Share to Save text-utils.ts:307-318 normalizeMultilineLinks
 */
function collapseZhihuMultilineLinks(md: string): string {
	// 快速路径：没有紧跟在 [ 之后的换行 → 不存在断裂链接 / no broken links
	if (!/\[\s*\n/.test(md)) return md;

	return md.replace(
		/\[([^\]]*\n[^\]]*)\]\(([^)\n]+)\)/g,
		(_full: string, text: string, url: string) => {
			const cleaned = text.replace(/\s+/g, ' ').trim();
			return `[${cleaned}](${url})`;
		}
	);
}

/**
 * 知乎文章 HTML → Markdown
 * Zhihu article HTML → Markdown
 *
 * 架构对齐 Share to Save ZhihuConverter.convert()：
 * 1. DOMParser → doc
 * 2. unwrapBlockChildrenInLinks（共享 DOM 预处理）
 * 3. extractZhihuTimeFromInitialData（SSR 统一提取时间，专栏+回答）
 * 4. preprocessZhihuDom（DOM 清理 + 内容限定 + bodyText 注入）
 * 5. Defuddle(doc).parse()（同一 doc，无重解析）
 * 6. enhanceMetadata + collapseZhihuMultilineLinks（共享后处理）
 *
 * Architecture aligned with Share to Save ZhihuConverter.convert():
 * 1. DOMParser → doc
 * 2. unwrapBlockChildrenInLinks (shared DOM preprocessing)
 * 3. extractZhihuTimeFromInitialData (unified SSR time extraction for zhuanlan + answer)
 * 4. preprocessZhihuDom (DOM cleanup + content scoping + bodyText injection)
 * 5. Defuddle(doc).parse() (same doc, no re-parse)
 * 6. enhanceMetadata + collapseZhihuMultilineLinks (shared post-processing)
 *
 * 参考 Share to Save content-converter.ts ZhihuConverter.convert() (lines 715-752)
 */
export function convertZhihuHtmlToMarkdown(html: string, url?: string): HtmlToMdResult {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// 1. 共享 DOM 预处理 / Shared DOM preprocessing
	unwrapBlockChildrenInLinks(doc);

	// 2. 从 js-initialData SSR JSON 提取时间（专栏+回答统一入口）
	// Extract time from js-initialData SSR JSON (unified for zhuanlan & answer)
	const timeInfo = extractZhihuTimeFromInitialData(doc, url || '');

	// 3. 知乎 DOM 预处理（bodyText 传给 preprocessAnswer 注入正文时间行）
	// Zhihu DOM preprocessing (bodyText passed to preprocessAnswer for time text injection)
	preprocessZhihuDom(doc, url || '', timeInfo?.bodyText);

	// 4. 同一 doc 直接交 Defuddle / Same doc goes directly to Defuddle
	const result = new Defuddle(doc, { url, markdown: true, useAsync: false }).parse();

	// 5. published: SSR 优先，Defuddle 兜底 / SSR takes priority, Defuddle fallback
	const published = timeInfo?.published || result.published || '';

	const mdResult: HtmlToMdResult = {
		title: result.title ?? '',
		author: result.author ?? '',
		published,
		content: result.content ?? '',
	};

	// 6. 共享后处理 / Shared post-processing
	const enhanced = enhanceMetadata(mdResult, html, doc);
	enhanced.content = collapseZhihuMultilineLinks(enhanced.content);

	return enhanced;
}

