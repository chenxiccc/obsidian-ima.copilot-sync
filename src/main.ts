import { Plugin, MarkdownView, WorkspaceLeaf, normalizePath, addIcon } from 'obsidian';
import { DEFAULT_SETTINGS, ImaPluginSettings, ImaSettingTab, SECRET_ID_CLIENT, SECRET_ID_API_KEY } from './settings';
import { SyncManager } from './sync-manager';

// ─── 插件主类 / Main plugin class ────────────────────────────────────────────

/** Ribbon 自定义图标 ID / Custom ribbon icon ID */
const RIBBON_ICON_ID = 'ima-sync-icon';

/** 切换图标 SVG：panda（空闲时显示）+ refresh-cw（同步时显示并旋转）/ Toggle icon SVG: panda (shown when idle) + refresh-cw (shown and rotating when syncing) */
const RIBBON_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <g class="ima-sync-panda">
    <path d="M11.25 17.25h1.5L12 18z"/>
    <path d="m15 12 2 2"/>
    <path d="M18 6.5a.5.5 0 0 0-.5-.5"/>
    <path d="M20.69 9.67a4.5 4.5 0 1 0-7.04-5.5 8.35 8.35 0 0 0-3.3 0 4.5 4.5 0 1 0-7.04 5.5C2.49 11.2 2 12.88 2 14.5 2 19.47 6.48 22 12 22s10-2.53 10-7.5c0-1.62-.48-3.3-1.3-4.83"/>
    <path d="M6 6.5a.495.495 0 0 1 .5-.5"/>
    <path d="m9 12-2 2"/>
  </g>
  <g class="ima-sync-refresh">
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
    <path d="M21 3v5h-5"/>
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
    <path d="M8 16H3v5"/>
  </g>
</svg>`;

export default class ImaPlugin extends Plugin {
	settings: ImaPluginSettings = { ...DEFAULT_SETTINGS };
	private syncManager!: SyncManager;
	/** 进入 IMA 文件夹前用户的编辑器状态（用于切出时恢复） / User's editor state before entering IMA */
	private preImaEditorState: { mode: string; source: boolean | undefined } | null = null;
	/** 当前活跃 leaf 是否在 IMA 文件夹内 / Whether the active leaf is currently inside an IMA file */
	private isInImaFolder = false;
	/** Ribbon 图标 DOM 元素（用于旋转动画）/ Ribbon icon DOM element (for rotation animation) */
	private ribbonIconEl!: HTMLElement;
	async onload(): Promise<void> {
		await this.loadSettings();

		// 初始化同步管理器 / Initialize sync manager
		this.syncManager = new SyncManager(
			this.app,
			this.app.vault,
			this.settings,
			() => this.saveSettings(),
			() => this.resolveCredentials(),
			(syncing: boolean) => {
				if (syncing) {
					this.ribbonIconEl.classList.add("ima-ribbon-syncing");
				} else {
					this.ribbonIconEl.classList.remove("ima-ribbon-syncing");
				}
			},
		);

		// ── Ribbon 手动同步按钮 / Ribbon manual sync button ─────────────────
		addIcon(RIBBON_ICON_ID, RIBBON_ICON_SVG);
		this.ribbonIconEl = this.addRibbonIcon(RIBBON_ICON_ID, '🐼 ima.copilot sync：立即同步', () => {
			void this.triggerSync();
		});

		// ── 命令面板 / Command palette ───────────────────────────────────────
		this.addCommand({
			id: 'ima-sync-now',
			name: '立即同步 ima.copilot 笔记',
			callback: () => {
				void this.triggerSync();
			},
		});

		// ── 设置界面 / Settings tab ──────────────────────────────────────────
		this.addSettingTab(new ImaSettingTab(this.app, this));

		// ── IMA 文件强制阅读模式 / Force reading mode for IMA files ────────
		// active-leaf-change：用户主动切换标签页，包含状态保存/恢复
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.enforceWithRestore(leaf);
			}),
		);

		// layout-change：分屏/布局变化 + 捕获用户在文件内切换视图模式
		// layout-change: split/layout changes + capture in-file view mode switches
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
					this.enforceImaPreviewOnly(leaf);
				});
				// 用户在非 IMA 文件内通过按钮/Ctrl+E 切换视图模式时，
				// 不会触发 active-leaf-change，在此补捕获
				// When user switches view mode within a non-IMA file via button/Ctrl+E,
				// active-leaf-change doesn't fire; capture it here
				this.captureCurrentEditorState();
			}),
		);

		// ── 启动时同步（等待 workspace 准备完毕后延迟 2 秒，避免阻塞启动）
		// ── Sync on startup (delay 2s after workspace ready to avoid blocking startup)
		this.app.workspace.onLayoutReady(() => {
			// 启动时处理活跃 leaf（IMA → 强设阅读；非 IMA → 保存状态）
			// Handle active leaf on startup (IMA → force reading; non-IMA → save state)
			this.enforceWithRestore(this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null);
			window.setTimeout(() => void this.syncManager.syncOnce(), 2000);
		});

		// ── 定时同步 / Periodic sync ─────────────────────────────────────────
		// 注：间隔变更需重启插件生效 / Note: interval changes require plugin restart
		this.registerInterval(
			window.setInterval(
				() => void this.syncManager.syncOnce(),
				this.settings.syncIntervalMinutes * 60 * 1000,
			),
		);
	}

	onunload(): void {
		// Obsidian 自动清理 registerInterval 注册的定时器
		// Obsidian automatically cleans up intervals registered via registerInterval
	}

	/**
	 * 仅强制 IMA 文件为阅读模式，不涉及状态保存/恢复。
	 * 供 layout-change 全量扫描使用。
	 * Only forces IMA files to preview mode; no state save/restore.
	 * Used by layout-change for bulk scanning.
	 */
	private enforceImaPreviewOnly(leaf: WorkspaceLeaf): void {
		if (!this.settings.forceReadingMode) return;
		if (!leaf?.view || !(leaf.view instanceof MarkdownView)) return;
		const file = leaf.view.file;
		if (!file) return;

		if (!this.isPathInSyncFolder(file.path)) return;

		const view = leaf.view;
		if (view.getMode() === 'preview') return;
		// 活跃 leaf 由 active-leaf-change 处理，放行用户手动切换到编辑模式
		// Active leaf is handled by active-leaf-change; allow manual edit mode switch
		if (leaf.view === this.app.workspace.getActiveViewOfType(MarkdownView)) return;
		void view.setState({ mode: 'preview' }, { history: false });
	}

	/**
	 * 保存 MarkdownView 的编辑器状态到 preImaEditorState。
	 * 抽取公共逻辑供 captureCurrentEditorState 和 enforceWithRestore 复用。
	 * Save MarkdownView editor state to preImaEditorState.
	 * Shared helper for captureCurrentEditorState and enforceWithRestore.
	 */
	private saveEditorState(view: MarkdownView): void {
		const mode = view.getMode();
		const mdState = view.getState() as { mode: string; source?: boolean };
		this.preImaEditorState = {
			mode: mode || 'source',
			source: mode === 'source' ? mdState.source : false,
		};
	}

	/**
	 * 捕获当前活跃 leaf 的编辑器状态（仅限非 IMA 文件）。
	 * 用于在 layout-change 和启动时补捕获视图模式切换，
	 * 解决 Ctrl+E/工具栏按钮切换模式不触发 active-leaf-change 的问题。
	 * Captures current active leaf editor state (non-IMA files only).
	 * Supplements active-leaf-change by catching in-file mode switches
	 * (Ctrl+E / toolbar button) which don't fire active-leaf-change.
	 */
	private captureCurrentEditorState(): void {
		if (this.isInImaFolder) return;
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;
		const file = activeView.file;
		if (!file) return;

		if (this.isPathInSyncFolder(file.path)) return;

		this.saveEditorState(activeView);
	}

	/**
	 * 用户主动切换标签页时调用：包含强制阅读 + 状态保存/恢复。
	 * 供 active-leaf-change 使用。
	 * Called when user actively switches tabs: force reading mode + state save/restore.
	 * Used by active-leaf-change.
	 */
	private enforceWithRestore(leaf: WorkspaceLeaf | null): void {
		if (!this.settings.forceReadingMode) return;
		if (!leaf?.view || !(leaf.view instanceof MarkdownView)) return;
		const file = leaf.view.file;
		if (!file) return;

		const isImaFile = this.isPathInSyncFolder(file.path);
		const view = leaf.view;

		if (isImaFile) {
			// 进入 IMA：标记，强制阅读模式 / Entering IMA: mark and force preview
			this.isInImaFolder = true;
			if (view.getMode() === 'preview') return;
			void view.setState({ mode: 'preview' }, { history: false });
		} else {
			// 非 IMA 文件 / Non-IMA file
			if (this.isInImaFolder) {
				// 刚从 IMA 切出来，恢复到进入 IMA 前的状态
				// Just left IMA: restore to pre-IMA state
				this.isInImaFolder = false;
				if (this.preImaEditorState) {
					const curMode = view.getMode();
					if (curMode !== this.preImaEditorState.mode) {
						void view.setState({
							mode: this.preImaEditorState.mode as 'source' | 'preview',
							source: this.preImaEditorState.source,
						}, { history: false });
					}
				} else if (view.getMode() === 'preview') {
					// 无保存状态时默认恢复到 Live Preview
					// Default to Live Preview when no saved state
					void view.setState({ mode: 'source', source: false }, { history: false });
				}
				return;
			}
			// 自由浏览非 IMA 文件时，保存当前状态作为下次进入 IMA 的恢复目标
			// Freely browsing non-IMA files: save current state as the restore target
			this.saveEditorState(view);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ImaPluginSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 设置保存时同步更新日志开关 / Sync debug log toggle when settings saved
		this.syncManager.setDebugEnabled(this.settings.enableDebugLog);
	}

	/**
	 * 从 SecretStorage 解析凭证 / Resolve credentials from SecretStorage
	 */
	resolveCredentials(): { clientId: string | null; apiKey: string | null } {
		return {
			clientId: this.app.secretStorage.getSecret(SECRET_ID_CLIENT),
			apiKey: this.app.secretStorage.getSecret(SECRET_ID_API_KEY),
		};
	}

	/**
	 * 判断给定路径是否在 ima 同步文件夹下 / Check if path is under IMA sync folder
	 */
	private isPathInSyncFolder(filePath: string): boolean {
		const syncFolder = normalizePath(this.settings.syncFolder);
		return filePath.startsWith(syncFolder + '/') || filePath === syncFolder;
	}

	/**
	 * 触发一次同步，供外部（设置界面、Ribbon）调用
	 * Trigger a sync, called externally (settings tab, ribbon)
	 */
	async triggerSync(): Promise<void> {
		// 设置变更后重建 client（确保使用最新凭证）
		// Rebuild client after settings change (ensure latest credentials)
		this.syncManager.rebuildClient();
		await this.syncManager.syncOnce();
	}

	/**
	 * 迁移同步文件夹，供设置界面调用
	 * Migrate sync folder, called from settings tab
	 */
	async migrateSyncFolder(oldFolder: string, newFolder: string): Promise<void> {
		await this.syncManager.migrateSyncFolder(oldFolder, newFolder);
	}

	/**
	 * 将指定知识库文件夹下的所有文件移入回收站，供设置界面调用
	 * Move all files under the specified KB folder to trash, called from settings tab
	 */
	async deleteKbFolder(...folderPaths: string[]): Promise<void> {
		await this.syncManager.deleteKbFolder(...folderPaths);
	}
}
