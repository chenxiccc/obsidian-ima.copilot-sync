import { Platform } from 'obsidian';
import { CHROME_UA } from './path-utils';
import { WECHAT_CONTENT_SELECTORS } from './html-to-md';

// electron 已由 esbuild external，运行时由 Obsidian Electron 环境解析 / electron is external in esbuild, resolved by Obsidian's Electron runtime

const LOAD_TIMEOUT_MS = 20_000;
const CONTENT_POLL_INTERVAL_MS = 500;
const CONTENT_POLL_MAX_MS = 10_000;
const WECHAT_PARTITION = 'persist:ima-copilot-wechat';

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
		} catch (e) {
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
				width: 1,
				height: 1,
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
		for (const sel of WECHAT_CONTENT_SELECTORS) {
			// 简单检查选择器中的关键标识是否出现在 HTML 中
			// Simple check if the selector's key identifier appears in HTML
			const key = sel.replace(/^[#.]/, '');
			if (html.includes(key)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * 检测 HTML 是否为微信验证码/反爬拦截页（参考 Share to Save headless-extractor.ts:147-150）
	 * Check if HTML is a WeChat captcha/anti-crawl block page (ref: Share to Save headless-extractor.ts:147-150)
	 */
	static hasCaptcha(html: string): boolean {
		const indicators = ['js_verify', 'verify_container', '环境异常', '请完成安全验证', '操作频繁'];
		return indicators.some(ind => html.includes(ind));
	}

	/**
	 * 加载 URL 并等待页面完成 / Load URL and wait for page to finish
	 */
	private loadUrlWithTimeout(win: any, url: string): Promise<void> {
		return new Promise<void>((resolve, _reject) => {
			const timer = setTimeout(() => {
				// 超时不 reject，仍尝试提取当前 DOM / Don't reject on timeout, still try to extract current DOM
				resolve();
			}, LOAD_TIMEOUT_MS);

			let finished = false;

			win.webContents.once('did-finish-load', () => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				resolve();
			});

			win.webContents.once('did-fail-load', (_event: any, _errorCode: number, _errorDescription: string) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
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
	 * 轮询多种内容容器出现后提取 outerHTML
	 * Poll for any known content container then extract outerHTML
	 */
	private async waitForContentAndExtract(win: any): Promise<string | null> {
		const start = Date.now();

		while (Date.now() - start < CONTENT_POLL_MAX_MS) {
			try {
				const hasContent: boolean = await win.webContents.executeJavaScript(
					`(function() {
						var selectors = ${JSON.stringify(WECHAT_CONTENT_SELECTORS)};
						for (var i = 0; i < selectors.length; i++) {
							var el = document.querySelector(selectors[i]);
							if (!el) continue;
							var textLen = (el.textContent || '').trim().length;
							var imgCount = el.querySelectorAll('img').length;
							// 有足够文本或多张图片 / Has enough text or multiple images
							if (textLen > 30 || imgCount >= 2) return true;
						}
						return false;
					})()`,
				);
				if (hasContent) break;
			} catch {
				// executeJavaScript 在页面未就绪时可能抛异常 / executeJavaScript may throw if page isn't ready
			}
			await new Promise(r => setTimeout(r, CONTENT_POLL_INTERVAL_MS));
		}

		// 触发基础懒加载：快速滚动触发图片 data-src 填充（参考 Share to Save headless-extractor.ts:222-225）
		// Trigger basic lazy load: quick scroll triggers image data-src fill (ref: Share to Save headless-extractor.ts:222-225)
		try {
			await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
			await new Promise(r => setTimeout(r, 300));
			await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
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
