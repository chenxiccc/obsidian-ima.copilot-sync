import { Plugin, Notice } from 'obsidian';
import { DEFAULT_SETTINGS, ImaPluginSettings, ImaSettingTab } from './settings';
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
			this.app.vault,
			this.settings,
			() => this.saveSettings(),
		);

		// ── Ribbon 手动同步按钮 / Ribbon manual sync button ─────────────────
		this.addRibbonIcon('refresh-cw', 'IMA Sync：立即同步', () => {
			void this.triggerSync();
		});

		// ── 命令面板 / Command palette ───────────────────────────────────────
		this.addCommand({
			id: 'ima-sync-now',
			name: '立即同步 IMA 笔记',
			callback: () => {
				void this.triggerSync();
			},
		});

		// ── 设置界面 / Settings tab ──────────────────────────────────────────
		this.addSettingTab(new ImaSettingTab(this.app, this));

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
}
