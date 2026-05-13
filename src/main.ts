import { Plugin, MarkdownView, normalizePath } from 'obsidian';
import { DEFAULT_SETTINGS, ImaPluginSettings, ImaSettingTab, SECRET_ID_CLIENT, SECRET_ID_API_KEY } from './settings';
import { SyncManager } from './sync-manager';
import { initDebugLog, setDebugLogEnabled } from './ima-client';

// ─── 插件主类 / Main plugin class ────────────────────────────────────────────

export default class ImaPlugin extends Plugin {
	settings: ImaPluginSettings = { ...DEFAULT_SETTINGS };
	private syncManager!: SyncManager;

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
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (!this.settings.forceReadingMode) return;
				if (!leaf?.view || !(leaf.view instanceof MarkdownView)) return;
				const file = leaf.view.file;
				if (!file) return;

				const syncFolder = normalizePath(this.settings.syncFolder);
				const isImaFile = file.path.startsWith(syncFolder + '/');
				const state = leaf.getViewState();

				if (isImaFile) {
					// IMA 文件：强制阅读模式 / IMA file: force reading mode
					if (state.state?.mode === 'preview') return;
					state.state = { ...state.state, mode: 'preview', source: false };
					void leaf.setViewState(state);
				} else if (state.state?.mode === 'preview' && state.state?.source === false) {
					// 非 IMA 文件：恢复编辑模式（仅当之前被强制切到阅读模式时）
					// Non-IMA file: restore editing mode (only if we forced preview earlier)
					state.state = { ...state.state, mode: 'source', source: false };
					void leaf.setViewState(state);
				}
			}),
		);

		// ── 启动时同步（等待 workspace 准备完毕后延迟 2 秒，避免阻塞启动）
		// ── Sync on startup (delay 2s after workspace ready to avoid blocking startup)
		this.app.workspace.onLayoutReady(() => {
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
