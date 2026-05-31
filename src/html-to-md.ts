import Defuddle from 'defuddle/full';
import type { DefuddleOptions, DefuddleResponse } from 'defuddle/full';

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
function buildCleanWeChatDom(doc: Document): string {
	const clone = doc.documentElement.cloneNode(true) as HTMLElement;

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
			const newCode = document.createElement('code');
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
			br.replaceWith(document.createTextNode('\n'));
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

	// ── 6. 包装为完整 HTML 返回（参考 content-converter.ts:246）──
	// Wrap as complete HTML document
	return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>' + clone.querySelector('body')!.innerHTML + '</body></html>';
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
function extractWeChatImages(html: string, doc: Document, existingContent: string): string {
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
		const cleanedHtml = buildCleanWeChatDom(doc);
		const cleanedDoc = parser.parseFromString(cleanedHtml, 'text/html');
		const parts: string[] = [];

		let area1Meta: HtmlToMdResult | null = null;

		// 区域 1: #js_content — 文字 + 类型 A 图片（先入队）
		// Area 1: #js_content — text + Type A images (first in queue)
		if (hasJsContent) {
			area1Meta = convertHtmlToMarkdown(cleanedHtml, { url, contentSelector: '#js_content', doc: cleanedDoc });
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
			const imagesMarkdown = extractWeChatImages(html, doc, result.content);
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
	const imagesMarkdown = extractWeChatImages(html, doc, resultContent);
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
		const alt = (img as HTMLImageElement).alt || '';
		parts.push(`![${alt}](${url})`);
	}
	return parts.length > 0 ? parts.join('\n') + '\n' : '';
}



// ─── 小红书文章提取 / Xiaohongshu article extraction ─────────────────────────

/**
 * 检测是否为小红书页面 / Check if it's a Xiaohongshu page
 */
export function isXiaohongshuUrl(url: string): boolean {
	return /(?:xiaohongshu\.com|xhslink\.com)/.test(url);
}

/**
 * 从小红书 __INITIAL_STATE__ JSON 提取图片 URL
 * Extract image URLs from Xiaohongshu __INITIAL_STATE__ JSON
 */
function extractXiaohongshuImages(html: string): string[] {
	const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(.+?)<\/script>/);
	if (!match?.[1]) return [];

	try {
		const json = JSON.parse(match[1].replace(/undefined/g, 'null'));
		const noteId = Object.keys(json.note?.noteDetailMap || {})[0];
		if (!noteId) return [];
		const noteDetail = (json.note?.noteDetailMap as Record<string, unknown>)?.[noteId as string] as { note?: { imageList?: Array<{ urlDefault?: string }> } } | undefined;
		const imageList = noteDetail?.note?.imageList || [];
		return imageList
			.map((img: { urlDefault?: string }) => img.urlDefault || '')
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * 小红书文章 HTML → Markdown
 * Xiaohongshu article HTML → Markdown
 *
 * 文本通过 defuddle + contentSelector 提取，图片从 __INITIAL_STATE__ JSON 提取
 * Text extracted via defuddle + contentSelector, images from __INITIAL_STATE__ JSON
 */
export function convertXiaohongshuHtmlToMarkdown(html: string, url?: string): HtmlToMdResult {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, 'text/html');

	// 文本提取 / Text extraction
	const desc = doc.querySelector('#detail-desc');
	const contentSelector = desc ? '#detail-desc' : '.note-content';
	const result = convertHtmlToMarkdown(html, { url, contentSelector, doc });

	// 图片补充 / Image supplement
	const images = extractXiaohongshuImages(html);
	if (images.length > 0 && result.content) {
		result.content = result.content.trimEnd() + '\n' + images.map(u => `![](${u})`).join('\n') + '\n';
	}

	return result;
}
