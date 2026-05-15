import { Plugin, MarkdownView, WorkspaceLeaf, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, ImaPluginSettings, ImaSettingTab, SECRET_ID_CLIENT, SECRET_ID_API_KEY } from './settings';
import { SyncManager } from './sync-manager';
import { initDebugLog, setDebugLogEnabled } from './ima-client';

// ─── 插件主类 / Main plugin class ────────────────────────────────────────────

export default class ImaPlugin extends Plugin {
	settings: ImaPluginSettings = { ...DEFAULT_SETTINGS };
	private syncManager!: SyncManager;
	/** 进入 IMA 文件夹前用户的编辑器状态（用于切出时恢复） / User's editor state before entering IMA */
	private preImaEditorState: { mode: string; source: boolean | undefined } | null = null;
	/** 当前活跃 leaf 是否在 IMA 文件夹内 / Whether the active leaf is currently inside an IMA file */
	private isInImaFolder = false;
	async onload(): Promise<void> {
		await this.loadSettings();

		// 初始化调试日志路径，并按设置同步开关状态
		// Initialize debug log path and sync toggle state from settings
		initDebugLog(this);
		setDebugLogEnabled(this.settings.enableDebugLog);

		// 初始化同步管理器 / Initialize sync manager
		this.syncManager = new SyncManager(
			this.app,
			this.app.vault,
			this.settings,
			() => this.saveSettings(),
			() => this.resolveCredentials(),
		);

		// ── Ribbon 手动同步按钮 / Ribbon manual sync button ─────────────────
		this.addRibbonIcon('refresh-cw', 'ima.copilot Sync：立即同步', () => {
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
			this.enforceWithRestore(this.app.workspace.activeLeaf);
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

		const syncFolder = normalizePath(this.settings.syncFolder);
		if (!file.path.startsWith(syncFolder + '/')) return;

		const view = leaf.view as MarkdownView;
		if (view.getMode() === 'preview') return;
		// 活跃 leaf 由 active-leaf-change 处理，放行用户手动切换到编辑模式
		// Active leaf is handled by active-leaf-change; allow manual edit mode switch
		if (leaf === this.app.workspace.activeLeaf) return;
		view.setState({ mode: 'preview' }, { history: false });
	}

	/**
	 * 保存 MarkdownView 的编辑器状态到 preImaEditorState。
	 * 抽取公共逻辑供 captureCurrentEditorState 和 enforceWithRestore 复用。
	 * Save MarkdownView editor state to preImaEditorState.
	 * Shared helper for captureCurrentEditorState and enforceWithRestore.
	 */
	private saveEditorState(view: MarkdownView): void {
		const mode = view.getMode();
		this.preImaEditorState = {
			mode: mode || 'source',
			source: mode === 'source' ? (view.getState() as any).source : false,
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
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf?.view || !(activeLeaf.view instanceof MarkdownView)) return;
		const file = activeLeaf.view.file;
		if (!file) return;

		const syncFolder = normalizePath(this.settings.syncFolder);
		if (file.path.startsWith(syncFolder + '/')) return;

		this.saveEditorState(activeLeaf.view as MarkdownView);
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

		const syncFolder = normalizePath(this.settings.syncFolder);
		const isImaFile = file.path.startsWith(syncFolder + '/');
		const view = leaf.view as MarkdownView;

		if (isImaFile) {
			// 进入 IMA：标记，强制阅读模式 / Entering IMA: mark and force preview
			this.isInImaFolder = true;
			if (view.getMode() === 'preview') return;
			view.setState({ mode: 'preview' }, { history: false });
		} else {
			// 非 IMA 文件 / Non-IMA file
			if (this.isInImaFolder) {
				// 刚从 IMA 切出来，恢复到进入 IMA 前的状态
				// Just left IMA: restore to pre-IMA state
				this.isInImaFolder = false;
				if (this.preImaEditorState) {
					const curMode = view.getMode();
					if (curMode !== this.preImaEditorState.mode) {
						view.setState({
							mode: this.preImaEditorState.mode as 'source' | 'preview',
							source: this.preImaEditorState.source,
						}, { history: false });
					}
				} else if (view.getMode() === 'preview') {
					// 无保存状态时默认恢复到 Live Preview
					// Default to Live Preview when no saved state
					view.setState({ mode: 'source', source: false }, { history: false });
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
		setDebugLogEnabled(this.settings.enableDebugLog);
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
