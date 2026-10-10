import { App, Modal, normalizePath, Platform, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem, TextComponent } from 'obsidian';
import { ImaClient, ImaPublicClient, formatImaError } from './ima-client';
import type { SearchedKnowledgeBase, PublicKnowledgeBase } from './ima-client';
import { sanitizeFilename } from './path-utils';

// ─── 设置数据结构 / Settings data structure ────────────────────────────────

// ─── 图片链接格式 / Image link format ────────────────────────────────────────
/** auto: 跟随 Obsidian 设置 / Follow Obsidian settings
 *  wikilink: Obsidian wiki 格式 ![[file]] / Obsidian wiki format
 *  markdown: 标准 Markdown 格式 ![alt](path) / Standard Markdown format */
export type LinkFormat = 'auto' | 'wikilink' | 'markdown';

// ─── 知识库删除同步模式 / KB delete sync mode ────────────────────────────────
/** delete: 删除本地文件 / Delete local file
 *  keep: 保留本地文件 / Keep local file
 *  mark-deleted: 保留但标记 [deleted] / Keep but mark [deleted] */
export type SyncDeleteMode = 'delete' | 'keep' | 'mark-deleted';

// ─── 附件大小限制单位 / Attachment size limit unit ──────────────────────────
export type AttachmentSizeUnit = 'KB' | 'MB' | 'GB';

// ─── SecretStorage 密钥 ID / SecretStorage key IDs ──────────────────────────
/** SecretStorage 中存储 Client ID 的密钥名 / Key name for Client ID in SecretStorage */
export const SECRET_ID_CLIENT = 'ima-client-id';
/** SecretStorage 中存储 API Key 的密钥名 / Key name for API Key in SecretStorage */
export const SECRET_ID_API_KEY = 'ima-api-key';

/** 个人知识库条目 / Personal knowledge base entry */
export interface PersonalKnowledgeBase {
	/** 加密 kb_id / Encrypted kb_id */
	kbId: string;
	/** 知识库名称 / KB name */
	name: string;
}

export interface ImaPluginSettings {
	/** vault 内的同步文件夹名 / Sync folder name within vault */
	syncFolder: string;
	/** 自动同步间隔（分钟）/ Auto sync interval in minutes */
	syncIntervalMinutes: number;
	/** 是否同步 ima 笔记 / Whether to sync ima notes */
	syncNotes: boolean;
	/** 是否同步知识库 / Whether to sync knowledge base */
	syncKnowledgeBase: boolean;
	/** 要同步的个人知识库列表 / Personal KB list to sync */
	personalKnowledgeBases: PersonalKnowledgeBase[];
	/**
	 * 上次同步时间戳（毫秒），存入 data.json，不展示在 UI 中
	 * Last sync timestamp in ms, stored in data.json, not shown in UI
	 */
	lastSyncTime: number;
	/** 是否输出调试日志文件 / Whether to write debug log file */
	enableDebugLog: boolean;
	/** 图片引用链接格式 / Image link format */
	linkFormat: LinkFormat;
	/** 知识库删除同步模式 / KB delete sync mode */
	syncDeleteMode: SyncDeleteMode;
	/** 是否下载图片 / Whether to download images */
	downloadImages: boolean;
	/** 图片大小限制值（0 = 不限制）/ Image size limit value (0 = no limit) */
	imageSizeLimit: number;
	/** 图片大小限制单位 / Image size limit unit */
	imageSizeLimitUnit: AttachmentSizeUnit;
	/** 是否下载文件（docx/pdf 等）/ Whether to download files (docx, PDF, etc.) */
	downloadFiles: boolean;
	/** 文件大小限制值（0 = 不限制）/ File size limit value (0 = no limit) */
	fileSizeLimit: number;
	/** 文件大小限制单位 / File size limit unit */
	fileSizeLimitUnit: AttachmentSizeUnit;
	/** 公共/订阅知识库列表 / Public/subscribed KB list */
	publicKnowledgeBases: PublicKnowledgeBase[];
	/** ima 文件强制阅读模式 / Force reading mode for ima files */
	forceReadingMode: boolean;
	/** 下载增强（仅桌面端，含防盗链回退 + 微信文章直接 headless 渲染提取）/ Download enhancement (desktop only, includes anti-hotlink fallback + WeChat direct headless extraction) */
	downloadEnhanced: boolean;
}

export const DEFAULT_SETTINGS: ImaPluginSettings = {
	syncFolder: 'ima',
	syncIntervalMinutes: 60,
	syncNotes: false,
	syncKnowledgeBase: false,
	personalKnowledgeBases: [],
	lastSyncTime: 0,
	enableDebugLog: false,
	linkFormat: 'auto',
	syncDeleteMode: 'delete',
	downloadImages: false,
	imageSizeLimit: 0,
	imageSizeLimitUnit: 'MB',
	downloadFiles: false,
	fileSizeLimit: 0,
	fileSizeLimitUnit: 'MB',
	publicKnowledgeBases: [],
	forceReadingMode: true,
	downloadEnhanced: true,
};

// ─── 设置页描述模型 / Settings page description model ──────────────────────
/**
 * 设置页由一份描述（pageItems()）驱动，同时用于两条渲染路径：
 * 1. Obsidian 1.13+ 的声明式设置页（getSettingDefinitions()，可被设置搜索检索）
 * 2. 更早版本的 display() 回退渲染
 *
 * The settings page is driven by a single description (pageItems()) used by both
 * render paths: the declarative settings page on Obsidian 1.13+ (indexed by the
 * settings search) and the display() fallback for older versions.
 */

/** 标量设置键（经 getControlValue/setControlValue 读写）/ Scalar setting keys (read/written via getControlValue/setControlValue) */
const SCALAR_KEYS = [
	'syncNotes',
	'syncKnowledgeBase',
	'syncDeleteMode',
	'downloadImages',
	'imageSizeLimit',
	'imageSizeLimitUnit',
	'downloadFiles',
	'fileSizeLimit',
	'fileSizeLimitUnit',
	'downloadEnhanced',
	'syncFolder',
	'syncIntervalMinutes',
	'linkFormat',
	'forceReadingMode',
	'enableDebugLog',
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

function isScalarKey(key: string): key is ScalarKey {
	return SCALAR_KEYS.some(candidate => candidate === key);
}

/** 标量控件描述 / Scalar control description */
type ControlSpec =
	| { type: 'toggle'; key: ScalarKey; disabled?: () => boolean }
	| { type: 'dropdown'; key: ScalarKey; options: Record<string, string>; defaultValue?: string }
	| { type: 'text'; key: ScalarKey; placeholder?: string }
	| { type: 'number'; key: ScalarKey; min?: number; placeholder?: string };

/**
 * 设置页条目 / Settings page item
 *
 * - row：普通设置行（名称/描述 + 控件），控件由 applyControl() 构建
 * - block：整块自绘（凭证框、知识库选择框等），仍带 name/aliases 供设置搜索检索
 */
type PageItem =
	| { kind: 'row'; name: string; desc: string; visible?: () => boolean; render: (setting: Setting, refresh: () => void) => void }
	| { kind: 'block'; name: string; aliases?: string[]; searchable?: boolean; visible?: () => boolean; build: (containerEl: HTMLElement, refresh: () => void) => void };

/** 下拉选项 / Dropdown options */
const SIZE_UNIT_OPTIONS: Record<string, string> = { KB: 'KB', MB: 'MB', GB: 'GB' };

const LINK_FORMAT_OPTIONS: Record<string, string> = {
	auto: '跟随 Obsidian 设置',
	wikilink: 'Obsidian 格式  ![[image.png]]',
	markdown: 'Markdown 标准格式  ![alt](path)',
};

const DELETE_MODE_OPTIONS: Record<string, string> = {
	delete: '删除本地文件',
	keep: '保留本地文件',
	'mark-deleted': '标记 [deleted]（保留文件，标题加后缀）',
};

/** 控件值 → 数字（非法值回退 0）/ Control value → number (invalid → 0) */
function toNumber(value: unknown): number {
	const num = typeof value === 'number' ? value : parseFloat(String(value));
	return Number.isFinite(num) ? num : 0;
}

/** 控件值 → 非负大小限制 / Control value → non-negative size limit */
function toSizeLimit(value: unknown): number {
	return Math.max(0, toNumber(value));
}

/** 控件值 → 附件大小单位（非法值回退 MB）/ Control value → size unit (invalid → MB) */
function toUnit(value: unknown): AttachmentSizeUnit {
	return value === 'KB' || value === 'GB' ? value : 'MB';
}

/** 控件值 → 删除同步模式（非法值回退 delete）/ Control value → delete mode (invalid → delete) */
function toDeleteMode(value: unknown): SyncDeleteMode {
	return value === 'keep' || value === 'mark-deleted' ? value : 'delete';
}

/** 控件值 → 输入框显示文本（仅处理标量，其他回退默认值）/ Control value → input text (scalars only, otherwise the fallback) */
function toDisplayText(value: unknown, fallback: string): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return fallback;
}

/** 控件值 → 图片链接格式（非法值回退 auto）/ Control value → link format (invalid → auto) */
function toLinkFormat(value: unknown): LinkFormat {
	return value === 'wikilink' || value === 'markdown' ? value : 'auto';
}

// ─── 确认对话框（取消/删除知识库时询问是否清理本地文件）/ Confirm modal for KB removal ──

export class ConfirmModal extends Modal {
	// 'confirmed' | 'cancelled' | 'dismissed'
	private result: 'confirmed' | 'cancelled' | 'dismissed' = 'dismissed';

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmLabel: string,
		private readonly cancelLabel: string,
		private readonly onConfirm: () => void,
		private readonly onCancel: () => void,
		private readonly onDismiss?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });
		contentEl.createEl('p', { text: this.message });

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });

		const confirmBtn = btnRow.createEl('button', { cls: 'mod-warning', text: this.confirmLabel });
		confirmBtn.addEventListener('click', () => {
			this.result = 'confirmed';
			this.close();
		});

		const cancelBtn = btnRow.createEl('button', { text: this.cancelLabel });
		cancelBtn.addEventListener('click', () => {
			this.result = 'cancelled';
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.result === 'confirmed') {
			this.onConfirm();
		} else if (this.result === 'cancelled') {
			this.onCancel();
		} else {
			// 直接关窗，不做任何操作 / Dismissed without choosing — revert to previous state
			this.onDismiss?.();
		}

}
}

// ─── 设置界面 / Settings UI ─────────────────────────────────────────────────

/** 设置页需要的插件接口，避免循环依赖 main.ts / Plugin interface for settings tab */
interface SettingsHost {
	settings: ImaPluginSettings;
	saveSettings(): Promise<void>;
	deleteKbFolder(...paths: string[]): Promise<void>;
	migrateSyncFolder(oldFolder: string, newFolder: string): Promise<void>;
	triggerSync(): Promise<void>;
}

export class ImaSettingTab extends PluginSettingTab {
	plugin: SettingsHost;
	/**
	 * 行可见性绑定（等价于声明式的 visible，但兼容 1.13 以下版本）
	 * Row visibility bindings (equivalent to the declarative `visible`, but works below 1.13)
	 */
	private readonly visibilityBindings: Array<{ el: HTMLElement; visible: () => boolean }> = [];
	/** 同步文件夹输入框（迁移失败时回滚显示）/ Sync folder input (reverted when migration fails) */
	private syncFolderInput: TextComponent | null = null;

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin as unknown as Plugin);
		this.plugin = plugin;
	}

	// ── 声明式设置页（Obsidian 1.13+）/ Declarative settings page (Obsidian 1.13+) ──

	/**
	 * 声明式设置页定义：1.13+ 由框架渲染，并用于设置搜索索引
	 * Declarative settings definitions: rendered by the framework on 1.13+ and used for settings search
	 *
	 * 返回非空数组时 1.13+ 不再调用 display()，display() 仅作为旧版本回退保留
	 * When a non-empty array is returned, display() is no longer called on 1.13+;
	 * display() is kept only as the fallback for older versions
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const refresh = (): void => this.applyVisibility();
		// 重新渲染时丢弃上一轮的行绑定 / Drop the previous render's row bindings
		this.visibilityBindings.length = 0;
		return [
			{
				// 顶部说明（整块自绘，不参与搜索）/ Top notice (custom block, excluded from search)
				name: '',
				searchable: false,
				render: setting => {
					// 标记说明所在的隐式分组卡片，去掉它的底色/边框，避免说明框外多一圈灰底
					// Mark the implicit group card holding the notice so CSS can strip its fill/border
					setting.settingEl.closest<HTMLElement>('.setting-items')?.addClass('ima-notice-card');
					this.renderAsBlock(setting, containerEl => this.renderMobileNotice(containerEl));
				},
			},
			{
				type: 'group',
				heading: '同步设置',
				items: this.pageItems().map(item => this.toDefinition(item, refresh)),
			},
		];
	}

	/** 把一个设置页条目转成声明式定义 / Convert a page item into a declarative definition */
	private toDefinition(item: PageItem, refresh: () => void): SettingDefinition {
		if (item.kind === 'row') {
			return {
				name: item.name,
				desc: item.desc,
				render: setting => {
					if (item.visible) this.bindVisibility(setting.settingEl, item.visible);
					item.render(setting, refresh);
				},
			};
		}
		return {
			name: item.name,
			aliases: item.aliases,
			searchable: item.searchable,
			render: setting => {
				if (item.visible) this.bindVisibility(setting.settingEl, item.visible);
				this.renderAsBlock(setting, containerEl => item.build(containerEl, refresh));
			},
		};
	}

	/**
	 * 整块自绘：清掉框架生成的名称/描述占位，把整行交给插件自定义渲染
	 * Take over a whole row: drop the framework's name/desc placeholders and render custom content
	 */
	private renderAsBlock(setting: Setting, build: (containerEl: HTMLElement) => void): void {
		setting.settingEl.empty();
		setting.settingEl.addClass('ima-settings-block');
		build(setting.settingEl);
	}

	/**
	 * 读取标量设置值（声明式控件与旧版渲染共用）
	 * Read a scalar setting value (shared by the declarative controls and the legacy renderer)
	 */
	getControlValue(key: string): unknown {
		if (!isScalarKey(key)) return undefined;
		// 移动端不支持下载增强，界面显示为关闭 / Download enhancement is desktop-only, shown as off on mobile
		if (key === 'downloadEnhanced' && !Platform.isDesktop) return false;
		return this.plugin.settings[key];
	}

	/**
	 * 写入并持久化标量设置值 / Write and persist a scalar setting value
	 *
	 * 覆盖基类实现：统一走 saveSettings()（含调试日志开关等副作用），
	 * 并对同步文件夹迁移与枚举类取值做收敛
	 * Overrides the base implementation so writes go through saveSettings()
	 * (which applies side effects such as the debug-log toggle) and so the sync
	 * folder migration and enum-like values are normalized
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isScalarKey(key)) return;
		const settings = this.plugin.settings;

		// 同步文件夹：先迁移文件再落盘，失败则回滚界面
		// Sync folder: migrate files before persisting, revert the UI on failure
		if (key === 'syncFolder') {
			const newFolder = String(value).trim() || 'ima';
			const oldFolder = settings.syncFolder;
			if (newFolder === oldFolder) return;

			try {
				await this.plugin.migrateSyncFolder(oldFolder, newFolder);
			} catch (err) {
				new Notice(`文件夹迁移失败：${err instanceof Error ? err.message : String(err)}`);
				this.syncFolderInput?.setValue(oldFolder);
				return;
			}

			settings.syncFolder = newFolder;
			await this.plugin.saveSettings();
			new Notice(`同步文件夹已从 "${oldFolder}" 迁移至 "${newFolder}"`);
			return;
		}

		switch (key) {
			case 'syncNotes': settings.syncNotes = Boolean(value); break;
			case 'syncKnowledgeBase': settings.syncKnowledgeBase = Boolean(value); break;
			case 'syncDeleteMode': settings.syncDeleteMode = toDeleteMode(value); break;
			case 'downloadImages': settings.downloadImages = Boolean(value); break;
			case 'imageSizeLimit': settings.imageSizeLimit = toSizeLimit(value); break;
			case 'imageSizeLimitUnit': settings.imageSizeLimitUnit = toUnit(value); break;
			case 'downloadFiles': settings.downloadFiles = Boolean(value); break;
			case 'fileSizeLimit': settings.fileSizeLimit = toSizeLimit(value); break;
			case 'fileSizeLimitUnit': settings.fileSizeLimitUnit = toUnit(value); break;
			case 'downloadEnhanced':
				// 移动端不落盘（界面也不可编辑）/ Not persisted on mobile (the control is disabled there)
				if (!Platform.isDesktop) return;
				settings.downloadEnhanced = Boolean(value);
				break;
			case 'syncIntervalMinutes': settings.syncIntervalMinutes = Math.max(1, Math.round(toNumber(value))); break;
			case 'linkFormat': settings.linkFormat = toLinkFormat(value); break;
			case 'forceReadingMode': settings.forceReadingMode = Boolean(value); break;
			case 'enableDebugLog': settings.enableDebugLog = Boolean(value); break;
			default: return;
		}

		await this.plugin.saveSettings();
	}

	/**
	 * 绑定一行/一块的可见性谓词，并立即应用一次
	 * Bind a row/block visibility predicate and apply it once
	 */
	private bindVisibility(el: HTMLElement, visible: () => boolean): void {
		this.visibilityBindings.push({ el, visible });
		this.applyVisibility();
	}

	/**
	 * 按谓词显隐所有已绑定的行/块（声明式与旧版共用；等价于声明式 visible）
	 * Show/hide every bound row/block per its predicate (shared by both paths; mirrors the declarative `visible`)
	 */
	private applyVisibility(): void {
		for (const binding of this.visibilityBindings) {
			binding.el.toggleClass('ima-hidden', !binding.visible());
		}
	}

	// ── 设置页描述 / Page description ────────────────────────────────────────

	/**
	 * 设置页条目（唯一的 UI 权威描述，两条渲染路径共用）
	 * Settings page items — the single source of truth for both render paths
	 */
	private pageItems(): PageItem[] {
		const settings = this.plugin.settings;
		return [
			// ── 认证凭证（灰色分组框）/ Credentials (grouped box) ──
			{
				kind: 'block',
				name: '凭证与连接',
				aliases: ['Client ID', 'API Key', '测试连接', 'ima OpenAPI', '凭证'],
				build: containerEl => this.renderCredentialBlock(containerEl),
			},

			// ── 同步内容选择 / Sync content selection ──
			this.controlRow('同步 ima 笔记', '同步 ima 个人笔记本中的笔记', { type: 'toggle', key: 'syncNotes' }),
			this.controlRow('同步知识库', '同步知识库中的条目（支持笔记、网页、微信文章、PDF、Word 等多种类型）', { type: 'toggle', key: 'syncKnowledgeBase' }),
			{
				kind: 'block',
				name: '选择要同步的知识库',
				aliases: ['个人知识库', '订阅知识库', '公共知识库', 'shareId'],
				visible: () => settings.syncKnowledgeBase,
				build: containerEl => this.renderKnowledgeBaseBlock(containerEl),
			},

			// ── 删除同步 / Delete sync ──
			this.controlRow('ima 删除同步', 'ima 笔记或知识库中删除条目后，本地文件的处理方式', {
				type: 'dropdown',
				key: 'syncDeleteMode',
				options: DELETE_MODE_OPTIONS,
			}),

			// ── 附件下载 / Attachment downloads ──
			this.controlRow('下载知识库图片', '个人笔记中的图片默认下载到本地（在线图片链接有时效签名，约 8 小时过期），此处仅控制知识库中的图片是否下载到本地', { type: 'toggle', key: 'downloadImages' }),
			this.sizeLimitRow('图片大小限制', '超过限制的图片保留原始链接，不下载（0 = 不限制）', 'imageSizeLimit', 'imageSizeLimitUnit', () => settings.downloadImages),
			this.controlRow('下载知识库文件', '个人笔记中的文件默认下载到本地（在线文件链接有时效签名，约 8 小时过期），此处仅控制知识库中的 docx、PDF 等文件是否下载到本地', { type: 'toggle', key: 'downloadFiles' }),
			this.sizeLimitRow('文件大小限制', '超过限制的文件保留原始链接，不下载（0 = 不限制）', 'fileSizeLimit', 'fileSizeLimitUnit', () => settings.downloadFiles),
			this.controlRow('下载增强（仅限桌面端）', '对防盗链图片/文件和微信公众号内容非常有效。开启后下载失败时自动使用 Node.js 回退重试；微信文章直接使用无头浏览器渲染提取完整内容（不再尝试静态抓取）', {
				type: 'toggle',
				key: 'downloadEnhanced',
				disabled: () => !Platform.isDesktop,
			}),

			// ── 同步设置 / Sync settings ──
			this.controlRow('同步文件夹', '笔记同步到 vault 根目录下的文件夹名（默认：ima）。修改后会自动迁移现有文件。', { type: 'text', key: 'syncFolder', placeholder: 'ima' }),
			this.controlRow('同步间隔（分钟）', '自动同步的时间间隔，最小 1 分钟', { type: 'number', key: 'syncIntervalMinutes', min: 1, placeholder: '60' }),
			this.controlRow('图片引用格式', '同步后笔记中图片链接的格式', { type: 'dropdown', key: 'linkFormat', options: LINK_FORMAT_OPTIONS }),
			this.controlRow('强制阅读模式', 'ima 同步文件默认以阅读模式打开，防止误编辑被同步覆盖', { type: 'toggle', key: 'forceReadingMode' }),

			// ── 手动同步 / Manual sync ──
			{ kind: 'row', name: '立即同步', desc: '手动触发一次全量同步', render: setting => this.renderManualSyncButton(setting) },

			// ── 调试日志 / Debug log ──
			this.controlRow('输出调试日志', '将 API 请求和响应记录到插件目录下的 ima-debug.log 文件（默认关闭，排查问题时开启）', { type: 'toggle', key: 'enableDebugLog' }),
		];
	}

	/** 生成标量设置行 / Build a scalar settings row */
	private controlRow(name: string, desc: string, control: ControlSpec, visible?: () => boolean): PageItem {
		return {
			kind: 'row',
			name,
			desc,
			visible,
			render: (setting, refresh) => this.applyControl(setting, control, refresh),
		};
	}

	/** 生成「大小限制 + 单位」行（同一行内文本输入 + 下拉，与原 UI 一致）/ Build a size-limit row (input + unit dropdown on one row, as before) */
	private sizeLimitRow(name: string, desc: string, limitKey: ScalarKey, unitKey: ScalarKey, visible: () => boolean): PageItem {
		return {
			kind: 'row',
			name,
			desc,
			visible,
			render: (setting, refresh) => {
				this.applyControl(setting, { type: 'number', key: limitKey, min: 0, placeholder: '0' }, refresh);
				this.applyControl(setting, { type: 'dropdown', key: unitKey, options: SIZE_UNIT_OPTIONS }, refresh);
			},
		};
	}

	/** 立即同步按钮 / Manual sync button */
	private renderManualSyncButton(setting: Setting): void {
		setting.addButton(btn =>
			btn
				.setButtonText('立即同步')
				.onClick(async () => {
					this.plugin.settings.lastSyncTime = 0;
					await this.plugin.saveSettings();
					await this.plugin.triggerSync();
				}),
		);
	}

	/**
	 * 在设置行上构建标量控件，读写统一走 getControlValue/setControlValue
	 * Build a scalar control on a settings row; reads/writes always go through getControlValue/setControlValue
	 */
	private applyControl(setting: Setting, control: ControlSpec, refresh: () => void): void {
		const current = this.getControlValue(control.key);
		const apply = (value: unknown): void => {
			void Promise.resolve(this.setControlValue(control.key, value)).then(refresh);
		};

		if (control.type === 'toggle') {
			const disabled = control.disabled?.() ?? false;
			setting.addToggle(toggle => {
				toggle.setValue(Boolean(current)).setDisabled(disabled);
				// 移动端禁用时不注册变更回调，避免误写入 / Skip the change handler when disabled to avoid writes
				if (!disabled) toggle.onChange(value => apply(value));
			});
			return;
		}

		if (control.type === 'dropdown') {
			const options = control.options;
			setting.addDropdown(drop => {
				for (const value of Object.keys(options)) drop.addOption(value, options[value] ?? value);
				drop.setValue(toDisplayText(current, control.defaultValue ?? ''));
				drop.onChange(value => apply(value));
			});
			return;
		}

		if (control.type === 'text') {
			setting.addText(text => {
				text.setPlaceholder(control.placeholder ?? '');
				text.setValue(toDisplayText(current, ''));
				// 记录同步文件夹输入框，迁移失败时回滚显示 / Keep the sync-folder input to revert it when migration fails
				if (control.key === 'syncFolder') this.syncFolderInput = text;
				text.onChange(value => apply(value));
			});
			return;
		}

		setting.addText(text => {
			text.setPlaceholder(control.placeholder ?? '0');
			text.setValue(toDisplayText(current, '0'));
			text.onChange(value => apply(value));
		});
	}

	// ── 旧版回退渲染（Obsidian < 1.13）/ Legacy fallback renderer (Obsidian < 1.13) ──

	/**
	 * 旧版 Obsidian 的渲染入口：按同一份描述构建界面
	 * Legacy render entry point: builds the same page from the same description
	 *
	 * 1.13+ 返回非空的 getSettingDefinitions() 后此方法不再被调用
	 * Not called on 1.13+, where the non-empty getSettingDefinitions() takes over
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 可见性绑定在 1.13+ 由框架触发的渲染中同样使用 / Visibility bindings are shared with the declarative render path
		this.visibilityBindings.length = 0;
		const refresh = (): void => this.applyVisibility();

		this.renderMobileNotice(containerEl);

		new Setting(containerEl).setName('同步设置').setHeading();

		for (const item of this.pageItems()) {
			if (item.kind === 'row') {
				const setting = new Setting(containerEl).setName(item.name).setDesc(item.desc);
				if (item.visible) this.bindVisibility(setting.settingEl, item.visible);
				item.render(setting, refresh);
				continue;
			}
			const wrapper = containerEl.createDiv();
			if (item.visible) this.bindVisibility(wrapper, item.visible);
			item.build(wrapper, refresh);
		}

		refresh();
	}

	// ── 自绘内容块 / Custom blocks ──────────────────────────────────────────

	/** 顶部说明块（仅中文，插件未做多语言适配）/ Top notice block (Chinese only; the plugin has no i18n) */
	private renderMobileNotice(containerEl: HTMLElement): void {
		const noticeBox = containerEl.createDiv({ cls: 'ima-notice-box' });
		noticeBox.createEl('p', {
			text: '📢 强烈建议在桌面端使用。桌面端独有的「下载增强」功能可显著提升微信公众号内容和防盗链图片的下载成功率。',
		});
	}

	/** 凭证块（说明 + 一键粘贴 + Client ID / API Key + 测试连接）/ Credential block */
	private renderCredentialBlock(containerEl: HTMLElement): void {
		const credBox = containerEl.createDiv({ cls: 'ima-cred-box' });

		// ── 凭证获取说明 + 一键粘贴 / Credential instructions + paste button ──

		new Setting(credBox)
			.setName('如何获取凭证')
			.setDesc(
				createFragment(frag => {
					frag.appendText('访问 ');
					const link = frag.createEl('a', {
						text: 'https://ima.qq.com/agent-interface',
						href: 'https://ima.qq.com/agent-interface',
					});
					link.target = '_blank';
					frag.appendText(' 获取 Client ID 和 API Key。');
					frag.createEl('br');
					frag.appendText('复制页面上的凭证文本后，点击右侧按钮可自动解析填入。');
					frag.createEl('br');
					frag.createSpan({
						text: '凭证格式：API Key: xxx\\nClient ID: xxx',
						attr: { style: 'color: var(--text-muted); font-size: 0.85em;' },
					});
					frag.createEl('br');
					frag.createSpan({
						text: '凭证将安全存储于 Obsidian 钥匙串中，不会以明文保存在配置文件里。',
						attr: { style: 'color: var(--text-muted); font-size: 0.85em;' },
					});
				}),
			)
			.addButton(btn =>
				btn
					.setButtonText('粘贴并解析凭证')
					.onClick(async () => {
						let text: string;
						try {
															// 读取剪贴板用于粘贴 IMA API 凭证（client_id / api_key），非读取用户笔记内容
								// Read clipboard to paste IMA API credentials, not user note content
								text = await navigator.clipboard.readText();
						} catch {
							new Notice('无法读取剪贴板，请检查浏览器/系统权限');
							return;
						}

						const apiKeyMatch = text.match(/API\s*Key\s*[:：]\s*(.+)/i);
						const clientIdMatch = text.match(/Client\s*ID\s*[:：]\s*(.+)/i);

						if (!apiKeyMatch && !clientIdMatch) {
							new Notice('未识别到有效凭证，请确认格式为 "API Key: xxx" 和 "Client ID: xxx"');
							return;
						}

						if (clientIdMatch) {
							this.app.secretStorage.setSecret(SECRET_ID_CLIENT, clientIdMatch[1]?.trim() ?? '');
						}
						if (apiKeyMatch) {
							this.app.secretStorage.setSecret(SECRET_ID_API_KEY, apiKeyMatch[1]?.trim() ?? '');
						}

						// 直接刷新输入框，避免整体重渲染 / Refresh the inputs in place instead of re-rendering the tab
						if (clientIdMatch) clientIdInput?.setValue(clientIdMatch[1]?.trim() ?? '');
						if (apiKeyMatch) apiKeyInput?.setValue(apiKeyMatch[1]?.trim() ?? '');
						new Notice('凭证已配置至安全存储');
					}),
			);

		let clientIdInput: TextComponent | null = null;
		new Setting(credBox)
			.setName('Client ID')
			.setDesc('ima OpenAPI 的 Client ID（安全存储于 Obsidian 钥匙串）')
			.addText(text => {
				text
					.setPlaceholder('输入 Client ID')
					.setValue(this.app.secretStorage.getSecret(SECRET_ID_CLIENT) ?? '')
					.onChange(async value => {
						this.app.secretStorage.setSecret(SECRET_ID_CLIENT, value.trim());
					});
				text.inputEl.addClass('ima-input-wide');
				clientIdInput = text;
			});

		let apiKeyInput: TextComponent | null = null;
		new Setting(credBox)
			.setName('API Key')
			.setDesc('ima OpenAPI 的 API Key（安全存储于 Obsidian 钥匙串）')
			.addText(text => {
				text
					.setPlaceholder('输入 API Key')
					.setValue(this.app.secretStorage.getSecret(SECRET_ID_API_KEY) ?? '')
					.onChange(async value => {
						this.app.secretStorage.setSecret(SECRET_ID_API_KEY, value.trim());
					});
				text.inputEl.type = 'password';
				text.inputEl.addClass('ima-input-wide');
				apiKeyInput = text;
			});

		// ── 测试连接 / Test connection ──────────────────────────────────────

		new Setting(credBox)
			.setName('测试连接')
			.setDesc('验证 Client ID 和 API Key 是否有效')
			.addButton(btn =>
				btn
					.setButtonText('测试')
					.onClick(async () => {
						const clientId = this.app.secretStorage.getSecret(SECRET_ID_CLIENT);
						const apiKey = this.app.secretStorage.getSecret(SECRET_ID_API_KEY);
						if (!clientId || !apiKey) {
							new Notice('请先填写 Client ID 和 API Key');
							return;
						}
						btn.setDisabled(true);
						btn.setButtonText('测试中…');
						try {
							const client = new ImaClient(clientId, apiKey);
							// 仅探测连通性，不遍历全部笔记，避免触发网关限频 (200001)
							// Probe connectivity only, do not fetch all notes, avoid gateway rate limit (200001)
							// 加 15s 超时兜底：postOnce 不退避，但网络慢时仍可能久卡，超时给出明确提示
							// 15s timeout fallback: postOnce has no backoff, but a slow network may still hang;
							// the timeout gives a clear message instead of an indefinite "测试中…"
							const timeout = new Promise<never>((_, reject) =>
								window.setTimeout(() => reject(new Error('测试连接超时（15s），请检查网络后重试 / Test connection timed out (15s), check network and retry')), 15_000),
							);
							await Promise.race([client.testConnection(), timeout]);
							new Notice('连接成功');
						} catch (err) {
							new Notice(`连接失败：${formatImaError(err)}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('测试');
						}
					}),
			);
	}

	/**
	 * 知识库选择块（个人 + 订阅 + 手动添加公共知识库）
	 * Knowledge base selection block (personal + subscribed + manually added public KB)
	 */
	private renderKnowledgeBaseBlock(containerEl: HTMLElement): void {
		const kbBox = containerEl.createDiv({ cls: 'ima-kb-box' });

		// ── 知识库选择（个人 + 订阅）/ KB selection (personal + subscribed) ──

		const kbSelectedSetting = new Setting(kbBox)
			.setName('选择要同步的个人和订阅知识库')
			.setDesc(
				this.plugin.settings.personalKnowledgeBases.length > 0
					? `已选 ${this.plugin.settings.personalKnowledgeBases.length} 个个人知识库，${this.plugin.settings.publicKnowledgeBases.length} 个公共/订阅知识库`
					: '未选择知识库',
			);

		// 知识库列表容器（默认隐藏，在 kbBox 内）/ KB list container (hidden by default, inside kbBox)
		const kbListContainer = kbBox.createDiv({ cls: 'ima-kb-list ima-hidden' });

		/** 更新已选描述 / Update selection description */
		const updateKbDesc = () => {
			const p = this.plugin.settings.personalKnowledgeBases.length;
			const s = this.plugin.settings.publicKnowledgeBases.length;
			kbSelectedSetting.setDesc(p > 0 || s > 0 ? `已选 ${p} 个个人知识库，${s} 个公共/订阅知识库` : '未选择知识库');
		};

		/** 渲染知识库选项列表（分组：个人 + 订阅）/ Render KB list (grouped: personal + subscribed) */
		const renderKbList = (bases: SearchedKnowledgeBase[], client: ImaClient) => {
			kbListContainer.empty();
			kbListContainer.removeClass('ima-hidden');

			// 按类型分组：个人/共享在前（走 openapi），订阅在后（走 cgi-bin）
			// Group by type: personal/shared first (openapi), subscribed last (cgi-bin)
			const personal = bases.filter(b => b.base_type === '个人知识库' || b.base_type === '共享知识库');
			const subscribed = bases.filter(b => b.base_type === '我加入的订阅知识库');

			if (personal.length > 0) {
				const header = kbListContainer.createDiv({ cls: 'ima-kb-group-header' });
				header.textContent = '个人知识库 / 共享知识库';
				const note = kbListContainer.createDiv({ cls: 'ima-kb-group-note' });
				note.textContent = '支持完整同步笔记、网页、微信文章和文件';
				for (const base of personal) {
					const row = kbListContainer.createDiv({ cls: 'ima-kb-row' });
					const checkbox = row.createEl('input');
					checkbox.type = 'checkbox';
					checkbox.className = 'ima-kb-checkbox';
					checkbox.checked = this.plugin.settings.personalKnowledgeBases.some(
						p => p.kbId === base.kb_id,
					);

					const label = row.createEl('label');
					label.textContent = `${base.kb_name}`;
					const idSpan = label.createSpan({ cls: 'ima-kb-id' });
					idSpan.textContent = `  (${base.content_count} 个内容)`;

					const removePersonal = async (deleteFiles: boolean) => {
						if (deleteFiles) {
							const syncFolder = this.plugin.settings.syncFolder;
							const safeName = sanitizeFilename(base.kb_name);
							const kbFolder = normalizePath(`${syncFolder}/个人知识库/${safeName}`);
							const attachFolder = normalizePath(`${syncFolder}/个人知识库/${safeName}/attachments`);
							await this.plugin.deleteKbFolder(kbFolder, attachFolder);
						}
						this.plugin.settings.personalKnowledgeBases =
							this.plugin.settings.personalKnowledgeBases.filter(
								p => p.kbId !== base.kb_id,
							);
						await this.plugin.saveSettings();
						updateKbDesc();
					};

					const onToggle = async () => {
						if (checkbox.checked) {
							this.plugin.settings.personalKnowledgeBases.push({
								kbId: base.kb_id,
								name: base.kb_name,
							});
							await this.plugin.saveSettings();
							updateKbDesc();
						} else {
							new ConfirmModal(
								this.app,
								'删除本地已同步文件？',
								`取消同步「${base.kb_name}」后，本地已同步的文件是否一并移入回收站？`,
								'移入回收站',
								'保留本地文件',
								() => void removePersonal(true),
								() => void removePersonal(false),
								() => { checkbox.checked = true; },
							).open();
						}
					};
					checkbox.addEventListener('change', () => void onToggle());
					label.addEventListener('click', () => {
						checkbox.checked = !checkbox.checked;
						void onToggle();
					});
				}
			}

			if (subscribed.length > 0) {
				const header = kbListContainer.createDiv({ cls: 'ima-kb-group-header' });
				header.textContent = '我加入的订阅知识库';
				const warning = kbListContainer.createDiv({ cls: 'ima-kb-group-note ima-kb-group-note--warning' });
				warning.textContent = '⚠ 笔记仅同步约 300 字预览；微信文章桌面端可完整获取（需开启下载增强），移动端仅同步摘要；文件仅同步 AI 摘要，无法下载原件';
				for (const base of subscribed) {
					const row = kbListContainer.createDiv({ cls: 'ima-kb-row' });
					const checkbox = row.createEl('input');
					checkbox.type = 'checkbox';
					checkbox.className = 'ima-kb-checkbox';
					checkbox.checked = this.plugin.settings.publicKnowledgeBases.some(
						p => p.encryptedKbId === base.kb_id,
					);

					const label = row.createEl('label');
					label.textContent = `${base.kb_name}`;
					const infoSpan = label.createSpan({ cls: 'ima-kb-id' });
					infoSpan.textContent = `  (${base.content_count} 个内容, ${base.member_count} 人订阅)`;

					const removeSubscribed = async (deleteFiles: boolean) => {
						if (deleteFiles) {
							const syncFolder = this.plugin.settings.syncFolder;
							const safeName = sanitizeFilename(base.kb_name);
							const kbFolder = normalizePath(`${syncFolder}/订阅和公共知识库/${safeName}`);
							const attachFolder = normalizePath(`${syncFolder}/订阅和公共知识库/${safeName}/attachments`);
							await this.plugin.deleteKbFolder(kbFolder, attachFolder);
						}
						this.plugin.settings.publicKnowledgeBases =
							this.plugin.settings.publicKnowledgeBases.filter(
								p => p.encryptedKbId !== base.kb_id,
							);
						await this.plugin.saveSettings();
						updateKbDesc();
						renderPublicKbList();
					};

					const onToggle = async () => {
						if (checkbox.checked) {
							// 尝试通过私有 API 获取根文件夹 ID（用于 cgi-bin 接口）
							// Try to get root folder_id via private API (for cgi-bin)
							let numericKbId = '';
							try {
								numericKbId = await client.getKbFolderId(base.kb_id);
							} catch {
								// 获取失败时保持为空，同步时会再次尝试 / Keep empty on failure, retry on sync
							}
							this.plugin.settings.publicKnowledgeBases.push({
								encryptedKbId: base.kb_id,
								numericKbId,
								shareId: '',
								name: base.kb_name,
								lastSyncTime: 0,
								kbCategory: '订阅和公共知识库',
							});
							await this.plugin.saveSettings();
							updateKbDesc();
							renderPublicKbList();
						} else {
							new ConfirmModal(
								this.app,
								'删除本地已同步文件？',
								`取消同步「${base.kb_name}」后，本地已同步的文件是否一并移入回收站？`,
								'移入回收站',
								'保留本地文件',
								() => void removeSubscribed(true),
								() => void removeSubscribed(false),
								() => { checkbox.checked = true; },
							).open();
						}
					};
					checkbox.addEventListener('change', () => void onToggle());
					label.addEventListener('click', () => {
						checkbox.checked = !checkbox.checked;
						void onToggle();
					});
				}
			}

		};

		kbSelectedSetting.addButton(btn =>
			btn
				.setButtonText('查看并选择知识库')
				.onClick(async () => {
					// 收起列表 / Collapse list
					if (!kbListContainer.hasClass('ima-hidden')) {
						kbListContainer.addClass('ima-hidden');
						btn.setButtonText('查看并选择知识库');
						return;
					}

					const clientId = this.app.secretStorage.getSecret(SECRET_ID_CLIENT);
					const apiKey = this.app.secretStorage.getSecret(SECRET_ID_API_KEY);
					if (!clientId || !apiKey) {
						new Notice('请先填写 Client ID 和 API Key');
						return;
					}
					btn.setDisabled(true);
					btn.setButtonText('加载中…');
					try {
						const client = new ImaClient(clientId, apiKey);
						const bases = await client.searchKnowledgeBases();
						if (bases.length === 0) {
							new Notice('未找到任何知识库');
							btn.setButtonText('查看并选择知识库');
						} else {
							renderKbList(bases, client);
							btn.setButtonText('收起列表');
						}
					} catch (err) {
						new Notice(`获取知识库失败：${formatImaError(err)}`);
						btn.setButtonText('查看并选择知识库');
					} finally {
						btn.setDisabled(false);
					}
				}),
		);

		// ── 手动添加公共知识库（在 kbBox 内）/ Manually add public KB (inside kbBox) ──

		new Setting(kbBox)
			.setName('添加公共知识库')
			.setDesc('粘贴分享链接或 shareId，如 https://ima.qq.com/wiki/?shareId=xxx（⚠ 笔记仅同步约 300 字预览；微信文章桌面端可完整获取；文件仅同步 AI 摘要）')
			.addText(text => {
				text.setPlaceholder('粘贴分享链接或 shareId');
				text.inputEl.addClass('ima-input-wide');
			})
			.addButton(btn =>
				btn
					.setButtonText('添加')
					.onClick(async () => {
						const input = btn.buttonEl.parentElement?.querySelector('input') as HTMLInputElement;
						const rawInput = input?.value ?? '';
						const shareId = ImaPublicClient.parseShareId(rawInput);
						if (!shareId) {
							new Notice('无法解析分享链接，请确认格式正确');
							return;
						}
						// 检查是否已添加 / Check if already added
						if (this.plugin.settings.publicKnowledgeBases.some(p => p.shareId === shareId)) {
							new Notice('该知识库已添加');
							return;
						}
						btn.setDisabled(true);
						btn.setButtonText('添加中…');
						try {
							const pubClient = new ImaPublicClient();
							const result = await pubClient.getShareInfo(shareId);
							const kbInfo = pubClient.extractKBInfo(result);
							this.plugin.settings.publicKnowledgeBases.push({
								encryptedKbId: '',
								numericKbId: kbInfo.id,
								shareId,
								name: kbInfo.name,
								lastSyncTime: 0,
								kbCategory: '订阅和公共知识库',
							});
							await this.plugin.saveSettings();
							input.value = '';
							new Notice(`已添加公共知识库：${kbInfo.name}`);
							renderPublicKbList();
						} catch (err) {
							new Notice(`添加失败：${err instanceof Error ? err.message : String(err)}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('添加');
						}
					}),
			);

		// 已添加的公共知识库列表（在 kbBox 内）/ Added public KB list (inside kbBox)
		const publicKbListContainer = kbBox.createDiv({ cls: 'ima-pubkb-list' });

		/** 渲染已添加的公共知识库列表 / Render added public KB list */
		const renderPublicKbList = () => {
			publicKbListContainer.empty();
			const bases = this.plugin.settings.publicKnowledgeBases;
			if (bases.length === 0) return;

			const header = publicKbListContainer.createDiv({ cls: 'ima-kb-group-header' });
			header.textContent = '已配置的公共知识库';

			for (const base of bases) {
				const row = publicKbListContainer.createDiv({ cls: 'ima-pubkb-row' });
				const nameSpan = row.createSpan({ cls: 'ima-pubkb-name' });
				nameSpan.textContent = base.name;
				const timeSpan = row.createSpan({ cls: 'ima-pubkb-time' });
				timeSpan.textContent = base.lastSyncTime > 0
					? `上次同步：${new Date(base.lastSyncTime).toLocaleString()}`
					: '从未同步';

				const delBtn = row.createEl('button', { cls: 'ima-pubkb-del' });
				delBtn.textContent = '删除';
				delBtn.addEventListener('click', () => {
					const removePublic = async (deleteFiles: boolean) => {
						if (deleteFiles) {
							const syncFolder = this.plugin.settings.syncFolder;
							const category = sanitizeFilename(base.kbCategory ?? '订阅和公共知识库');
							const safeName = sanitizeFilename(base.name);
							const kbFolder = normalizePath(`${syncFolder}/${category}/${safeName}`);
							const attachFolder = normalizePath(`${syncFolder}/${category}/${safeName}/attachments`);
							await this.plugin.deleteKbFolder(kbFolder, attachFolder);
						}
						this.plugin.settings.publicKnowledgeBases =
							this.plugin.settings.publicKnowledgeBases.filter(
								p => p !== base,
							);
						await this.plugin.saveSettings();
						renderPublicKbList();
					};
					new ConfirmModal(
						this.app,
						'删除本地已同步文件？',
						`删除「${base.name}」后，本地已同步的文件是否一并移入回收站？`,
						'移入回收站',
						'保留本地文件',
						() => void removePublic(true),
						() => void removePublic(false),
					).open();
				});
			}
		};
		renderPublicKbList();
	}
}
