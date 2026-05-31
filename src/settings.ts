import { App, Modal, normalizePath, Platform, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
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

// ─── 确认对话框（取消/删除知识库时询问是否清理本地文件）/ Confirm modal for KB removal ──

class ConfirmModal extends Modal {
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

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin as unknown as Plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('同步设置').setHeading();

		// ── 认证凭证（灰色分组框）/ Credentials (grouped box) ─────────────────

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
					frag.createEl('span', {
						text: '凭证格式：API Key: xxx\\nClient ID: xxx',
						attr: { style: 'color: var(--text-muted); font-size: 0.85em;' },
					});
					frag.createEl('br');
					frag.createEl('span', {
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

						this.display();
						new Notice('凭证已配置至安全存储');
					}),
			);

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
			});

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
							const notes = await client.listAllNotes();
							new Notice(`连接成功，共找到 ${notes.length} 篇笔记`);
						} catch (err) {
							new Notice(`连接失败：${formatImaError(err)}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('测试');
						}
					}),
			);

		// ── 同步内容选择 / Sync content selection ──────────────────────────────

		new Setting(containerEl)
			.setName('同步 ima 笔记')
			.setDesc('同步 ima 个人笔记本中的笔记')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.syncNotes)
					.onChange(async value => {
						this.plugin.settings.syncNotes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('同步知识库')
			.setDesc('同步知识库中的条目（支持笔记、网页、微信文章、PDF、Word 等多种类型）')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.syncKnowledgeBase)
					.onChange(async value => {
						this.plugin.settings.syncKnowledgeBase = value;
						await this.plugin.saveSettings();
						kbBox.toggleClass('ima-hidden', !value);
					}),
			);

		// ── 知识库分组框（受开关控制显隐）/ KB group box (visibility controlled by toggle) ──

		const kbBox = containerEl.createDiv({ cls: 'ima-kb-box' });

		if (!this.plugin.settings.syncKnowledgeBase) {
			kbBox.addClass('ima-hidden');
		}

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
					const idSpan = label.createEl('span', { cls: 'ima-kb-id' });
					idSpan.textContent = `  (${base.content_count} 个内容)`;

					const removePersonal = async (deleteFiles: boolean) => {
						if (deleteFiles) {
							const syncFolder = this.plugin.settings.syncFolder;
							const safeName = sanitizeFilename(base.kb_name);
							const kbFolder = normalizePath(`${syncFolder}/个人知识库/${safeName}`);
							const attachFolder = normalizePath(`${syncFolder}/attachments/个人知识库/${safeName}`);
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
					const infoSpan = label.createEl('span', { cls: 'ima-kb-id' });
					infoSpan.textContent = `  (${base.content_count} 个内容, ${base.member_count} 人订阅)`;

					const removeSubscribed = async (deleteFiles: boolean) => {
						if (deleteFiles) {
							const syncFolder = this.plugin.settings.syncFolder;
							const safeName = sanitizeFilename(base.kb_name);
							const kbFolder = normalizePath(`${syncFolder}/订阅和公共知识库/${safeName}`);
							const attachFolder = normalizePath(`${syncFolder}/attachments/订阅和公共知识库/${safeName}`);
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
				const nameSpan = row.createEl('span', { cls: 'ima-pubkb-name' });
				nameSpan.textContent = base.name;
				const timeSpan = row.createEl('span', { cls: 'ima-pubkb-time' });
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
							const attachFolder = normalizePath(`${syncFolder}/attachments/${category}/${safeName}`);
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

		// ── ima 删除同步 / ima delete sync ──────────────────────────────────

		new Setting(containerEl)
			.setName('ima 删除同步')
			.setDesc('ima 笔记或知识库中删除条目后，本地文件的处理方式')
			.addDropdown(drop => {
				drop
					.addOption('delete', '删除本地文件')
					.addOption('keep', '保留本地文件')
					.addOption('mark-deleted', '标记 [deleted]（保留文件，标题加后缀）')
					.setValue(this.plugin.settings.syncDeleteMode)
					.onChange(async value => {
						this.plugin.settings.syncDeleteMode = value as SyncDeleteMode;
						await this.plugin.saveSettings();
					});
			});

		// ── 附件下载设置 / Attachment download settings ──────────────────────

		this.addDownloadToggleWithSizeLimit(containerEl, {
			toggleName: '下载知识库图片',
			toggleDesc: '个人笔记中的图片默认下载到本地（在线图片链接有时效签名，约 8 小时过期），此处仅控制知识库中的图片是否下载到本地',
			limitName: '图片大小限制',
			limitDesc: '超过限制的图片保留原始链接，不下载（0 = 不限制）',
			toggleKey: 'downloadImages',
			limitKey: 'imageSizeLimit',
			unitKey: 'imageSizeLimitUnit',
		});

		this.addDownloadToggleWithSizeLimit(containerEl, {
			toggleName: '下载知识库文件',
			toggleDesc: '个人笔记中的文件默认下载到本地（在线文件链接有时效签名，约 8 小时过期），此处仅控制知识库中的 docx、PDF 等文件是否下载到本地',
			limitName: '文件大小限制',
			limitDesc: '超过限制的文件保留原始链接，不下载（0 = 不限制）',
			toggleKey: 'downloadFiles',
			limitKey: 'fileSizeLimit',
			unitKey: 'fileSizeLimitUnit',
		});

		// ── 下载增强（仅桌面端）/ Download enhancement (desktop only) ──────────

		new Setting(containerEl)
			.setName('下载增强（仅限桌面端）')
			.setDesc('对防盗链图片/文件和微信公众号内容非常有效。开启后下载失败时自动使用 Node.js 回退重试；微信文章直接使用无头浏览器渲染提取完整内容（不再尝试静态抓取）')
			.addToggle(toggle => {
				toggle
					.setValue(Platform.isDesktop ? this.plugin.settings.downloadEnhanced : false)
					.setDisabled(!Platform.isDesktop)
					.onChange(async value => {
						this.plugin.settings.downloadEnhanced = value;
						await this.plugin.saveSettings();
					});
			});

		// ── 同步设置 / Sync settings ─────────────────────────────────────────

		new Setting(containerEl)
			.setName('同步文件夹')
			.setDesc('笔记同步到 vault 根目录下的文件夹名（默认：ima）。修改后会自动迁移现有文件。')
			.addText(text =>
				text
					.setPlaceholder('ima')
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async value => {
						const newFolder = value.trim() || 'ima';
						const oldFolder = this.plugin.settings.syncFolder;
						if (newFolder === oldFolder) return;

						try {
							await this.plugin.migrateSyncFolder(oldFolder, newFolder);
						} catch (err) {
							new Notice(`文件夹迁移失败：${err instanceof Error ? err.message : String(err)}`);
							text.setValue(oldFolder);
							return;
						}

						this.plugin.settings.syncFolder = newFolder;
						await this.plugin.saveSettings();
						new Notice(`同步文件夹已从 "${oldFolder}" 迁移至 "${newFolder}"`);
					}),
			);

		new Setting(containerEl)
			.setName('同步间隔（分钟）')
			.setDesc('自动同步的时间间隔，最小 1 分钟')
			.addText(text =>
				text
					.setPlaceholder('60')
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async value => {
						const minutes = parseInt(value, 10);
						if (!isNaN(minutes) && minutes >= 1) {
							this.plugin.settings.syncIntervalMinutes = minutes;
							await this.plugin.saveSettings();
						}
					}),
			);

		// ── 图片链接格式 / Image link format ─────────────────────────────────

		new Setting(containerEl)
			.setName('图片引用格式')
			.setDesc('同步后笔记中图片链接的格式')
			.addDropdown(drop => {
				drop
					.addOption('auto', '跟随 Obsidian 设置')
					.addOption('wikilink', 'Obsidian 格式  ![[image.png]]')
					.addOption('markdown', 'Markdown 标准格式  ![alt](path)')
					.setValue(this.plugin.settings.linkFormat)
					.onChange(async value => {
						this.plugin.settings.linkFormat = value as LinkFormat;
						await this.plugin.saveSettings();
					});
			});

		// ── 强制阅读模式 / Force reading mode ───────────────────────────────

		new Setting(containerEl)
			.setName('强制阅读模式')
			.setDesc('ima 同步文件默认以阅读模式打开，防止误编辑被同步覆盖')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.forceReadingMode)
					.onChange(async value => {
						this.plugin.settings.forceReadingMode = value;
						await this.plugin.saveSettings();
					}),
			);

		// ── 手动同步 / Manual sync ──────────────────────────────────────────

		new Setting(containerEl)
			.setName('立即同步')
			.setDesc('手动触发一次全量同步')
			.addButton(btn =>
				btn
					.setButtonText('立即同步')
					.onClick(async () => {
						this.plugin.settings.lastSyncTime = 0;
						await this.plugin.saveSettings();
						await this.plugin.triggerSync();
					}),
			);

		// ── 调试日志 / Debug log ─────────────────────────────────────────────

		new Setting(containerEl)
			.setName('输出调试日志')
			.setDesc('将 API 请求和响应记录到插件目录下的 ima-debug.log 文件（默认关闭，排查问题时开启）')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.enableDebugLog)
					.onChange(async value => {
						this.plugin.settings.enableDebugLog = value;
						await this.plugin.saveSettings();
					}),
			);
	}
	private addDownloadToggleWithSizeLimit(
		containerEl: HTMLElement,
		config: {
			toggleName: string;
			toggleDesc: string;
			limitName: string;
			limitDesc: string;
			toggleKey: 'downloadImages' | 'downloadFiles';
			limitKey: 'imageSizeLimit' | 'fileSizeLimit';
			unitKey: 'imageSizeLimitUnit' | 'fileSizeLimitUnit';
		},
	): void {
		let limitContainer: HTMLDivElement | null = null;

		new Setting(containerEl)
			.setName(config.toggleName)
			.setDesc(config.toggleDesc)
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings[config.toggleKey])
					.onChange(async value => {
						this.plugin.settings[config.toggleKey] = value;
						await this.plugin.saveSettings();
						if (limitContainer) {
							limitContainer.toggleClass('ima-hidden', !value);
						}
					}),
		);

		limitContainer = containerEl.createDiv();
		if (!this.plugin.settings[config.toggleKey]) {
			limitContainer.addClass('ima-hidden');
		}

		new Setting(limitContainer)
			.setName(config.limitName)
			.setDesc(config.limitDesc)
			.addText(text =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings[config.limitKey]))
					.onChange(async value => {
						const num = parseFloat(value);
						this.plugin.settings[config.limitKey] = isNaN(num) ? 0 : Math.max(0, num);
						await this.plugin.saveSettings();
					}),
			)
			.addDropdown(drop =>
				drop
					.addOption('KB', 'KB')
					.addOption('MB', 'MB')
					.addOption('GB', 'GB')
					.setValue(this.plugin.settings[config.unitKey])
					.onChange(async value => {
						this.plugin.settings[config.unitKey] = value as AttachmentSizeUnit;
						await this.plugin.saveSettings();
					}),
		);
	}
}
