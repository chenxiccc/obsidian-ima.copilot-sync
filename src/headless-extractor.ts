import { Platform } from 'obsidian';
import { CHROME_UA } from './path-utils';

// electron 已由 esbuild external，运行时由 Obsidian Electron 环境解析 / electron is external in esbuild, resolved by Obsidian's Electron runtime

const LOAD_TIMEOUT_MS = 20_000;
const CONTENT_POLL_INTERVAL_MS = 500;
const CONTENT_POLL_MAX_MS = 10_000;
const WECHAT_PARTITION = 'persist:ima-copilot-wechat';
const GENERIC_PARTITION = 'persist:ima-copilot';

/**
 * 使用隐藏 Electron BrowserWindow 提取 JS 渲染后的页面 HTML
 * Extract JS-rendered page HTML using a hidden Electron BrowserWindow
 *
 * 仅桌面端可用，移动端返回 null / Desktop only, returns null on mobile
 */
export class HeadlessExtractor {
	/**
	 * 尝试通过 headless BrowserWindow 提取渲染后的 HTML
	 * Try to extract rendered HTML via headless BrowserWindow
	 *
	 * @returns 完整的 document.documentElement.outerHTML，失败返回 null
	 */
	async extractRenderedHtml(url: string): Promise<string | null> {
		if (!Platform.isDesktop) {
		return null;
	}

		// 使用 weread-plugin 确证的 require 模式 / Use weread-plugin proven require pattern
		let RemoteBrowserWindow: any;
		try {
			const { remote } = require('electron');
			RemoteBrowserWindow = remote.BrowserWindow;
		} catch {
			return null;
		}
		if (!RemoteBrowserWindow) {
			return null;
		}

		let win: any = null;
		try {
			// 创建隐藏 BrowserWindow，参考 weread-plugin 模式
			// Create hidden BrowserWindow, following weread-plugin pattern
			win = new RemoteBrowserWindow({
				width: 1280,
				height: 720,
				show: false,
				webPreferences: {
					partition: WECHAT_PARTITION,
					nodeIntegration: false,
					contextIsolation: true,
				},
			});

			win.webContents.setUserAgent(CHROME_UA);

			await this.loadUrlWithTimeout(win, url);

			const html = await this.waitForContentAndExtract(win);
			// 验证码检测：微信反爬验证页不具备有效内容（参考 Share to Save headless-extractor.ts:117-120）
			// Captcha detection: WeChat anti-crawl page has no valid content (ref: Share to Save headless-extractor.ts:117-120)
			if (html && HeadlessExtractor.hasCaptcha(html)) {
				console.warn('ima.copilot Sync: 检测到微信验证码页面，建议稍后重试 / Detected WeChat captcha page, try again later');
				return null;
			}
			return html;
		} catch {
			return null;
		} finally {
			this.destroyWindow(win);
		}
	}

	/**
	 * 判断提取的 HTML 是否包含有效微信文章内容
	 * Check if extracted HTML contains valid WeChat article content
	 */
	static hasWeChatContent(html: string): boolean {
		// 微信公众号已知内容容器选择器 / Known WeChat content container selectors
		const selectors = [
			'js_content', 'rich_media_content', 'share_content_page',
			'js_video_page_title', 'js_audio_title', 'audio_panel_area',
			'js_text_title', 'js_novel_card', 'img-content', 'rich_media',
		];
		return selectors.some(sel => html.includes(sel));
	}

	/**
	 * 判断提取的 HTML 是否包含有效页面正文（通用检查，不依赖站点特定选择器）
	 * Check if extracted HTML contains valid page body content (generic check, no site-specific selectors)
	 */
	static hasValidContent(html: string): boolean {
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		const bodyText = (doc.body?.textContent || '').trim();
		return bodyText.length > 100;
	}

	/**
	 * 多信号验证码检测：服务签名 → 页面标题 → 关键词（参考 Share to Save headless-extractor.ts:148-179）
	 * Multi-signal captcha detection: service signatures → page title → keywords (ref: Share to Save headless-extractor.ts:148-179)
	 *
	 * 服务签名：各验证码厂商注入的唯一 DOM 标记，误报率为零 / Service signatures: unique DOM markers, zero false positives
	 * 页面标题：验证码页面标题高度固定，正常文章不会匹配 / Page title: captcha titles are formulaic, articles won't match
	 * 关键词：覆盖中英文常见验证码提示语，作为最终安全网 / Keywords: cover common CN/EN captcha prompts, final safety net
	 */
	static hasCaptcha(html: string): boolean {
		// Signal 1: 已知验证码服务签名（语言无关，零误报）/ Known captcha service signatures (language-independent, zero false positives)
		const serviceSignatures = [
			'cf-browser-verification',   // Cloudflare
			'cf-challenge-running',      // Cloudflare
			'datadome',                   // DataDome
			'akamai-bot-manager',        // Akamai
			'_abck',                      // Akamai cookie
		];
		if (serviceSignatures.some(s => html.includes(s))) return true;

		// Signal 2: 页面标题检测（公式化表达，误报风险极低）/ Page title detection (formulaic, very low false positive risk)
		const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
		const title = titleMatch?.[1]?.trim() || '';
		const captchaTitles = [
			'just a moment', 'attention required', 'security check',
			'verify you are a human', 'are you a robot',
			'请完成安全验证', '环境异常', '人机验证',
		];
		if (captchaTitles.some(t => title.toLowerCase().includes(t))) return true;

		// Signal 3: 关键词匹配（中英文覆盖，作为最终安全网）/ Keyword matching (CN/EN coverage, final safety net)
		const keywords = [
			'js_verify', 'verify_container',
			'环境异常', '请完成安全验证', '操作频繁',
			'please verify you are a human', 'unusual traffic',
		];
		return keywords.some(k => html.includes(k));
	}

	/**
	 * 加载 URL 并等待页面完成 / Load URL and wait for page to finish
	 */
	private loadUrlWithTimeout(win: any, url: string): Promise<void> {
		return new Promise<void>((resolve, _reject) => {
			const timer = window.setTimeout(() => {
				// 超时不 reject，仍尝试提取当前 DOM / Don't reject on timeout, still try to extract current DOM
				resolve();
			}, LOAD_TIMEOUT_MS);

			let finished = false;

			win.webContents.once('did-finish-load', () => {
				if (finished) return;
				finished = true;
				window.clearTimeout(timer);
				resolve();
			});

			win.webContents.once('did-fail-load', (_event: any, _errorCode: number, _errorDescription: string) => {
				if (finished) return;
				finished = true;
				window.clearTimeout(timer);
				resolve();
			});

			void win.loadURL(url, {
				userAgent: CHROME_UA,
				extraHeaders: [
					'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
				].join('\n'),
			});
		});
	}

	/**
	 * 轮询页面正文出现后提取 outerHTML（通用检测，不依赖站点特定选择器）
	 * Poll for page body content then extract outerHTML (generic detection, no site-specific selectors)
	 */
	private async waitForContentAndExtract(win: any): Promise<string | null> {
		const start = Date.now();

		while (Date.now() - start < CONTENT_POLL_MAX_MS) {
			try {
				const bodyLen: number = await win.webContents.executeJavaScript(
					'(document.body?.innerText || "").trim().length',
				);
				if (bodyLen > 100) break;
			} catch {
				// executeJavaScript 在页面未就绪时可能抛异常 / executeJavaScript may throw if page isn't ready
			}
			await new Promise(r => window.setTimeout(r, CONTENT_POLL_INTERVAL_MS));
		}

		// 触发懒加载：滚到底部触发图片 data-src 填充（参考 Share to Save headless-extractor.ts:448-461）
		// Trigger lazy load: scroll to bottom to trigger image data-src fill (ref: Share to Save headless-extractor.ts:448-461)
		try {
			await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
			await new Promise(r => window.setTimeout(r, 800));
			await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
			await new Promise(r => window.setTimeout(r, 500));
		} catch {
			// 滚动失败不影响提取 / Scroll failure doesn't block extraction
		}

		try {
			const html: string = await win.webContents.executeJavaScript(
				'document.documentElement.outerHTML',
			);
			return html;
		} catch {
			return null;
		}
	}
	/**
	 * 销毁 BrowserWindow / Destroy BrowserWindow
	 */
	private destroyWindow(win: any): void {
		if (!win || win.isDestroyed()) return;
		try {
			win.close();
		} catch {
			// 忽略关闭时的错误 / Ignore errors on close
		}
	}
}
