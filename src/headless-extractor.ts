import { Platform } from 'obsidian';
import { CHROME_UA } from './path-utils';

// ─── 常量 / Constants ──────────────────────────────────────────────────────────

/** 页面加载超时 / Page load timeout */
const LOAD_TIMEOUT_MS = 20_000;
/** 全局超时（从 extractRenderedHtml 开始计时）/ Global timeout (from extractRenderedHtml start) */
const TOTAL_TIMEOUT_MS = 30_000;
/** 信号轮询间隔 / Signal polling interval */
const POLL_INTERVAL_MS = 1_000;
/** 网络静默期：pendingCount === 0 需持续此时间才算空闲 / Network idle: pendingCount must stay 0 for this duration */
const NETWORK_IDLE_MS = 1_000;
/** DOM 稳定阈值：无 MutationObserver 变化的持续时间 / DOM stable: duration without MutationObserver changes */
const DOM_STABLE_MS = 500;
/** 内容稳定所需连续检查次数 / Consecutive stable checks required for content stability */
const CONTENT_STABLE_CHECKS = 2;

const WECHAT_PARTITION = 'persist:ima-copilot-wechat';

// ─── Electron 类型接口（编译时不可用，运行时由 Obsidian 提供）/ Electron type interfaces ──
// Electron types are unavailable at compile time; resolved by Obsidian runtime at execution

interface ElectronWebContents {
	setUserAgent(ua: string): void;
	once(event: string, callback: (...args: unknown[]) => void): void;
	executeJavaScript(code: string): Promise<unknown>;
	session?: {
		webRequest?: {
			onBeforeRequest(callback: (details: { url: string }, cb?: (opts: Record<string, unknown>) => void) => void): void;
			onCompleted(callback: (details: { url: string }) => void): void;
			onErrorOccurred(callback: (details: { url: string }) => void): void;
		};
	};
}

interface ElectronBrowserWindow {
	webContents: ElectronWebContents;
	loadURL(url: string, options?: Record<string, unknown>): Promise<void>;
	isDestroyed(): boolean;
	close(): void;
}


// ─── HeadlessExtractor / 无头提取器 ──────────────────────────────────────────

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
		let RemoteBrowserWindow: { new (options: Record<string, unknown>): ElectronBrowserWindow } | undefined;
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- Electron is external in esbuild, resolved by Obsidian runtime at execution
			RemoteBrowserWindow = require('electron').remote.BrowserWindow;
		} catch {
			return null;
		}
		if (!RemoteBrowserWindow) {
			return null;
		}

		// 局部状态变量，每次调用独立（参考 Share to Save headless-extractor.ts:78）
		// Local state, independent per call (ref: Share to Save headless-extractor.ts:78)
		const networkState = { pendingCount: 0, lastZeroTime: null as number | null, enabled: false };
		const startTime = Date.now();

		let win: ElectronBrowserWindow | null = null;
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

			// 1. 注册网络监听器（必须在 loadURL 之前，参考 Share to Save headless-extractor.ts:94）
			// Register network listeners (must be before loadURL, ref: Share to Save headless-extractor.ts:94)
			this.registerNetworkListeners(win, networkState);

			// 2. 加载 URL / Load URL
			await this.loadUrlWithTimeout(win, url);

			// 3. 三信号轮询等待页面就绪（参考 Share to Save headless-extractor.ts:100）
			// Three-signal polling wait for page ready (ref: Share to Save headless-extractor.ts:100)
			await this.waitForPageReady(win, networkState, startTime);

			// 4. 触发懒加载 / Trigger lazy loading
			await this.scrollToTriggerLazyLoad(win);

			// 5. 计算样式戳记，使 defuddle hidden.ts 在 DOMParser 上下文中也能检测隐藏元素
			// Stamp computed visibility as inline style for defuddle hidden.ts in DOMParser context
			// 参考 Share to Save headless-extractor.ts:486-504
			await this.stampComputedProperties(win);

			// 6. 提取 HTML / Extract HTML
			const html = await this.extractHtml(win);

			// 7. 验证码检测：微信反爬验证页不具备有效内容（参考 Share to Save headless-extractor.ts:113-116）
			// Captcha detection: WeChat anti-crawl page has no valid content (ref: Share to Save headless-extractor.ts:113-116)
			if (html && HeadlessExtractor.hasCaptcha(html)) {
				console.warn('ima.copilot Sync: 检测到微信验证码页面，建议稍后重试 / Detected WeChat captcha page, try again later');
				return null;
			}
			return html;
		} catch {
			return null;
		} finally {
			// 清理顺序：observer.disconnect → removeNetworkListeners → destroyWindow
			// Cleanup order: observer.disconnect → removeNetworkListeners → destroyWindow
			await this.cleanup(win, networkState);
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
			'cf-browser-verification',        // Cloudflare JS Challenge
			'cf-challenge-running',           // Cloudflare
			'challenges.cloudflare.com',      // Cloudflare Turnstile (ref: Scrapling)
			'cf-turnstile',                   // Cloudflare Turnstile widget
			'g-recaptcha',                    // Google reCAPTCHA (ref: Scrapling)
			'recaptcha/api.js',               // Google reCAPTCHA API
			'grecaptcha',                     // Google reCAPTCHA JS
			'hcaptcha.com',                   // hCaptcha (ref: Scrapling)
			'h-captcha',                      // hCaptcha
			'datadome',                       // DataDome
			'akamai-bot-manager',            // Akamai
			'_abck',                          // Akamai cookie
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

	// ── 网络监听器 / Network Listeners ──────────────────────────────────────

	/**
	 * 注册 webRequest 监听器，跟踪未完成请求计数。
	 * Register webRequest listeners to track pending request count.
	 *
	 * 必须在 loadURL 之前调用，否则丢失初始请求。
	 * Must be called before loadURL, otherwise initial requests are missed.
	 *
	 * 如果 Electron API 不支持 webRequest，则 networkState.enabled 保持 false，
	 * checkNetworkIdle 始终返回 true（不阻塞网络等待）。
	 * If Electron API doesn't support webRequest, networkState.enabled stays false,
	 * checkNetworkIdle always returns true (don't block on network).
	 *
	 * 参考 Share to Save headless-extractor.ts:205-231
	 */
	private registerNetworkListeners(
		win: ElectronBrowserWindow,
		state: { pendingCount: number; lastZeroTime: number | null; enabled: boolean },
	): void {
		try {
			const session = win.webContents.session;
			if (!session?.webRequest) return;

			const onBefore = (_details: unknown, cb?: (opts: Record<string, unknown>) => void) => {
				state.pendingCount++;
				if (cb) cb({});
			};
			const onDone = () => { state.pendingCount = Math.max(0, state.pendingCount - 1); };

			session.webRequest.onBeforeRequest(onBefore);
			session.webRequest.onCompleted(onDone);
			session.webRequest.onErrorOccurred(onDone);

			state.enabled = true;

			// 保存回调引用供 removeNetworkListeners 使用
			// Save callback references for removeNetworkListeners
			(state as unknown as Record<string, unknown>)._onBefore = onBefore;
			(state as unknown as Record<string, unknown>)._onDone = onDone;
		} catch {
			// webRequest 不可用时，不阻塞网络等待 / If webRequest unavailable, don't block on network
		}
	}

	/**
	 * 移除 webRequest 监听器。
	 * Remove webRequest listeners.
	 *
	 * 参考 Share to Save headless-extractor.ts:243-268
	 */
	private removeNetworkListeners(
		win: ElectronBrowserWindow | null,
		state: { pendingCount: number; lastZeroTime: number | null; enabled: boolean },
	): void {
		if (!win || !state.enabled) return;
		try {
			const session = win.webContents.session;
			if (!session?.webRequest) return;

			const s = state as unknown as Record<string, unknown>;
			const onBefore = s._onBefore as ((details: { url: string }) => void) | undefined;
			const onDone = s._onDone as ((details: { url: string }) => void) | undefined;

			const wr = session.webRequest as unknown as Record<string, unknown>;
			if (typeof wr.removeBeforeRequestListener === 'function' && onBefore) {
				(wr.removeBeforeRequestListener as (cb: (details: { url: string }) => void) => void)(onBefore);
			}
			if (typeof wr.removeCompletedListener === 'function' && onDone) {
				(wr.removeCompletedListener as (cb: (details: { url: string }) => void) => void)(onDone);
			}
			if (typeof wr.removeErrorOccurredListener === 'function' && onDone) {
				(wr.removeErrorOccurredListener as (cb: (details: { url: string }) => void) => void)(onDone);
			}
			state.enabled = false;
		} catch { /* ignore */ }
	}

	/**
	 * 即时检查网络是否空闲。
	 * Check if network is currently idle.
	 *
	 * 规则：pendingCount === 0 持续 NETWORK_IDLE_MS 以上。
	 * 若 webRequest 未启用（enabled === false），始终返回 true。
	 *
	 * 参考 Share to Save headless-extractor.ts:282-294
	 */
	private checkNetworkIdle(state: { pendingCount: number; lastZeroTime: number | null; enabled: boolean }): boolean {
		if (!state.enabled) return true;

		if (state.pendingCount === 0) {
			if (state.lastZeroTime === null) {
				state.lastZeroTime = Date.now();
			}
			return (Date.now() - state.lastZeroTime) >= NETWORK_IDLE_MS;
		} else {
			state.lastZeroTime = null;
			return false;
		}
	}

	// ── DOM 稳定检查 / DOM Stable Check ────────────────────────────────────

	/**
	 * 注入 MutationObserver 到页面 JS 上下文（主循环开始前调用一次）。
	 * Inject MutationObserver into page JS context (called once before main loop).
	 *
	 * 参考 Share to Save headless-extractor.ts:302-312
	 */
	private async injectDomObserver(win: ElectronBrowserWindow): Promise<void> {
		try {
			await win.webContents.executeJavaScript(
				'if (!window.__sts_observer) {' +
				'  window.__sts_lastChange = Date.now();' +
				'  window.__sts_observer = new MutationObserver(function() { window.__sts_lastChange = Date.now(); });' +
				'  window.__sts_observer.observe(document, { childList: true, subtree: true, characterData: true });' +
				'}'
			);
		} catch { /* ignore */ }
	}

	/**
	 * 即时检查 DOM 是否稳定（DOM_STABLE_MS 内无变化）。
	 * Check if DOM is currently stable (no changes in DOM_STABLE_MS).
	 *
	 * 参考 Share to Save headless-extractor.ts:318-327
	 */
	private async checkDomStable(win: ElectronBrowserWindow): Promise<boolean> {
		try {
			const stable: boolean = await win.webContents.executeJavaScript(
				'typeof window.__sts_lastChange === "number" && (Date.now() - window.__sts_lastChange) > ' + DOM_STABLE_MS
			) as boolean;
			return stable;
		} catch {
			return false;
		}
	}

	// ── 内容稳定检查 / Content Stable Check ──────────────────────────────

	/**
	 * 即时检查页面内容是否稳定（body.innerText.length 停止增长）。
	 * Check if page content is currently stable (body.innerText.length stops growing).
	 *
	 * 参考 Share to Save headless-extractor.ts:342-360
	 */
	private async checkContentStable(
		win: ElectronBrowserWindow,
		state: { lastLen: number; stableCount: number },
	): Promise<boolean> {
		try {
			const currentLen: number = await win.webContents.executeJavaScript(
				'((document.body && document.body.innerText) || "").trim().length'
			) as number;
			if (currentLen === state.lastLen) {
				state.stableCount++;
			} else {
				state.stableCount = 0;
			}
			state.lastLen = currentLen;
			return state.stableCount >= CONTENT_STABLE_CHECKS;
		} catch {
			return false;
		}
	}

	// ── 主轮询循环 / Main Polling Loop ─────────────────────────────────────

	/**
	 * 主轮询循环：每 POLL_INTERVAL_MS 检查三种信号，满足条件时返回。
	 * Main polling loop: check three signals every POLL_INTERVAL_MS, return when condition met.
	 *
	 * 内容就绪使用内容稳定检测（body.innerText 停止增长），无固定字符数阈值。
	 *
	 * 参考 Share to Save headless-extractor.ts:373-412
	 */
	private async waitForPageReady(
		win: ElectronBrowserWindow,
		networkState: { pendingCount: number; lastZeroTime: number | null; enabled: boolean },
		startTime: number,
	): Promise<void> {
		// 注入 MutationObserver（只执行一次）/ Inject MutationObserver (once)
		await this.injectDomObserver(win);

		// 内容稳定状态 / Content stability state
		const contentState = { lastLen: 0, stableCount: 0 };

		while (true) {
			await new Promise(r => window.setTimeout(r, POLL_INTERVAL_MS));

			const elapsed = Date.now() - startTime;

			const networkIdle = this.checkNetworkIdle(networkState);
			const domStable = await this.checkDomStable(win);
			const contentStable = await this.checkContentStable(win, contentState);

			// 条件 1：全部就绪 → 立即返回
			// Condition 1: all ready → return immediately
			if (networkIdle && domStable && contentStable) {
				return;
			}

			// 条件 2：DOM 稳定 + 内容稳定（网络可能长连接/WebSocket 永不空闲）
			// Condition 2: DOM stable + content stable (network may never idle due to WebSocket/long-poll)
			if (domStable && contentStable) {
				await new Promise(r => window.setTimeout(r, 2000));
				return;
			}

			// 条件 3：全局超时 30s（从 startTime 算起，非主循环开始）
			// Condition 3: global timeout 30s (from startTime, not from polling start)
			if (elapsed > TOTAL_TIMEOUT_MS) {
				return;
			}
		}
	}

	// ── 页面加载 / Page Loading ──────────────────────────────────────────────

	/**
	 * 加载 URL 并等待 did-finish-load 或超时。
	 * Load URL and wait for did-finish-load or timeout.
	 */
	private loadUrlWithTimeout(win: ElectronBrowserWindow, url: string): Promise<void> {
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

			win.webContents.once('did-fail-load', (_event: unknown, _errorCode: number, _errorDescription: string) => {
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

	// ── 滚动触发懒加载 / Scroll to Trigger Lazy Load ────────────────────────

	/**
	 * 分步滚动触发懒加载。
	 * Step scroll to trigger lazy loading.
	 * 先快速滚到底部 → 等 800ms（给图片加载时间）→ 瞬间跳回顶部 → 等 500ms。
	 * Scroll to bottom → wait 800ms → instant jump to top → wait 500ms.
	 */
	private async scrollToTriggerLazyLoad(win: ElectronBrowserWindow): Promise<void> {
		try {
			await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight)');
			await new Promise(r => window.setTimeout(r, 800));
			await win.webContents.executeJavaScript('window.scrollTo(0, 0)');
			await new Promise(r => window.setTimeout(r, 500));
		} catch {
			// 滚动失败不影响提取 / Scroll failure doesn't block extraction
		}
	}

	// ── Computed 隐藏样式注入 / Computed Hidden Style Stamping ──────────────

	/**
	 * 在提取 HTML 前，将 computed 隐藏状态注入为 inline style。
	 * defuddle 的 hidden.ts 中有无条件的 inline style 检测。DOMParser 上下文中
	 * defaultView=null，无法通过 getComputedStyle 获取 CSS 隐藏元素。此方法提前
	 * 把 computed display/visibility/opacity 写入 inline style，使 defuddle 的
	 * inline style 检测路径能捕获 CSS 隐藏的噪声元素（侧栏、弹窗、cookie 横幅等）。
	 *
	 * Stamp computed visibility as inline styles before extracting HTML.
	 * defuddle's hidden.ts has an unconditional inline style check. In DOMParser
	 * context defaultView=null prevents getComputedStyle from detecting CSS-hidden
	 * elements. This stamps computed display/visibility/opacity as inline styles
	 * so defuddle's inline style detection captures CSS-hidden noise (sidebars,
	 * popups, cookie banners, etc.).
	 *
	 * 参考 Share to Save headless-extractor.ts:486-504
	 */
	private async stampComputedProperties(win: ElectronBrowserWindow): Promise<void> {
		try {
			await win.webContents.executeJavaScript(
				'(function(){' +
				'var all=document.querySelectorAll("*");' +
				'for(var i=0;i<all.length;i++){try{' +
				'var el=all[i];' +
				'var cs=getComputedStyle(el);' +
				// 隐藏状态 → inline style / Hidden states → inline style
				'if(cs.display==="none")el.style.display="none";' +
				'if(cs.visibility==="hidden")el.style.visibility="hidden";' +
				'if(cs.opacity==="0")el.style.opacity="0";' +
				'}catch(e){}}' +
				'})();'
			);
		} catch {
			/* stamp 失败不阻塞提取 / stamp failure doesn't block extraction */
		}
	}

	// ── HTML 提取 / HTML Extraction ──────────────────────────────────────────

	/**
	 * 提取 documentElement.outerHTML。
	 * Extract documentElement.outerHTML.
	 *
	 * 参考 Share to Save headless-extractor.ts:512-520
	 */
	private async extractHtml(win: ElectronBrowserWindow): Promise<string | null> {
		try {
			const html = await win.webContents.executeJavaScript(
				'document.documentElement.outerHTML',
			) as string;
			return html;
		} catch {
			return null;
		}
	}

	// ── 清理 / Cleanup ──────────────────────────────────────────────────────

	/**
	 * 清理资源：MutationObserver disconnect → 网络监听器移除 → 窗口销毁
	 * Clean up resources in order: observer disconnect → remove network listeners → destroy window
	 */
	private async cleanup(win: ElectronBrowserWindow | null, networkState: { pendingCount: number; lastZeroTime: number | null; enabled: boolean }): Promise<void> {
		try {
			await win?.webContents.executeJavaScript(
				'if (window.__sts_observer) { window.__sts_observer.disconnect(); delete window.__sts_observer; delete window.__sts_lastChange; }'
			);
		} catch { /* ignore */ }
		this.removeNetworkListeners(win, networkState);
		this.destroyWindow(win);
	}

	/**
	 * 销毁 BrowserWindow / Destroy BrowserWindow
	 */
	private destroyWindow(win: ElectronBrowserWindow | null): void {
		if (!win || win.isDestroyed()) return;
		try {
			win.close();
		} catch {
			// 忽略关闭时的错误 / Ignore errors on close
		}
	}
}
