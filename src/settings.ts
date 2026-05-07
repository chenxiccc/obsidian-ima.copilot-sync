import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ImaPlugin from './main';
import { ImaClient, ImaPublicClient } from './ima-client';
import type { SearchedKnowledgeBase, PublicKnowledgeBase } from './ima-client';

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
	/** 是否同步 IMA 笔记 / Whether to sync IMA notes */
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
	/** 是否下载附件（图片、PDF 等）/ Whether to download attachments (images, PDF, etc.) */
	downloadAttachments: boolean;
	/** 附件大小限制值（0 = 不限制）/ Attachment size limit value (0 = no limit) */
	attachmentSizeLimit: number;
	/** 附件大小限制单位 / Attachment size limit unit */
	attachmentSizeLimitUnit: AttachmentSizeUnit;
	/** 公共/订阅知识库列表 / Public/subscribed KB list */
	publicKnowledgeBases: PublicKnowledgeBase[];
	/** IMA 文件强制阅读模式 / Force reading mode for IMA files */
	forceReadingMode: boolean;
}

export const DEFAULT_SETTINGS: ImaPluginSettings = {
	syncFolder: 'ima',
	syncIntervalMinutes: 60,
	syncNotes: true,
	syncKnowledgeBase: false,
	personalKnowledgeBases: [],
	lastSyncTime: 0,
	enableDebugLog: false,
	linkFormat: 'auto',
	syncDeleteMode: 'delete',
	downloadAttachments: false,
	attachmentSizeLimit: 0,
	attachmentSizeLimitUnit: 'MB',
	publicKnowledgeBases: [],
	forceReadingMode: true,
};

// ─── 设置界面 / Settings UI ─────────────────────────────────────────────────

export class ImaSettingTab extends PluginSettingTab {
	plugin: ImaPlugin;

	constructor(app: App, plugin: ImaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'IMA Sync 设置' });

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
			.setDesc('IMA OpenAPI 的 Client ID（安全存储于 Obsidian 钥匙串）')
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
			.setDesc('IMA OpenAPI 的 API Key（安全存储于 Obsidian 钥匙串）')
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
							new Notice(`连接失败：${err instanceof Error ? err.message : String(err)}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('测试');
						}
					}),
			);

		// ── 同步内容选择 / Sync content selection ──────────────────────────────

		new Setting(containerEl)
			.setName('同步 IMA 笔记')
			.setDesc('同步 IMA 个人笔记本中的笔记')
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
		const renderKbList = (bases: SearchedKnowledgeBase[]) => {
			kbListContainer.empty();
			kbListContainer.removeClass('ima-hidden');

			// 按类型分组：个人在前，订阅在后 / Group by type: personal first, subscribed after
			const personal = bases.filter(b => b.base_type === '个人知识库');
			const subscribed = bases.filter(b => b.base_type !== '个人知识库');

			if (personal.length > 0) {
				const header = kbListContainer.createDiv({ cls: 'ima-kb-group-header' });
				header.textContent = '个人知识库';
				for (const base of personal) {
					const row = kbListContainer.createDiv({ cls: 'ima-kb-row' });
					const checkbox = row.createEl('input') as HTMLInputElement;
					checkbox.type = 'checkbox';
					checkbox.className = 'ima-kb-checkbox';
					checkbox.checked = this.plugin.settings.personalKnowledgeBases.some(
						p => p.kbId === base.kb_id,
					);

					const label = row.createEl('label');
					label.textContent = `${base.kb_name}`;
					const idSpan = label.createEl('span', { cls: 'ima-kb-id' });
					idSpan.textContent = `  (${base.content_count} 个内容)`;

					const onToggle = async () => {
						if (checkbox.checked) {
							this.plugin.settings.personalKnowledgeBases.push({
								kbId: base.kb_id,
								name: base.kb_name,
							});
						} else {
							this.plugin.settings.personalKnowledgeBases =
								this.plugin.settings.personalKnowledgeBases.filter(
									p => p.kbId !== base.kb_id,
								);
						}
						await this.plugin.saveSettings();
						updateKbDesc();
					};
					checkbox.addEventListener('change', onToggle);
					label.addEventListener('click', () => {
						checkbox.checked = !checkbox.checked;
						onToggle();
					});
				}
			}

			if (subscribed.length > 0) {
				const header = kbListContainer.createDiv({ cls: 'ima-kb-group-header' });
				header.textContent = '我加入的订阅知识库';
				for (const base of subscribed) {
					const row = kbListContainer.createDiv({ cls: 'ima-kb-row' });
					const checkbox = row.createEl('input') as HTMLInputElement;
					checkbox.type = 'checkbox';
					checkbox.className = 'ima-kb-checkbox';
					checkbox.checked = this.plugin.settings.publicKnowledgeBases.some(
						p => p.encryptedKbId === base.kb_id,
					);

					const label = row.createEl('label');
					label.textContent = `${base.kb_name}`;
					const infoSpan = label.createEl('span', { cls: 'ima-kb-id' });
					infoSpan.textContent = `  (${base.content_count} 个内容, ${base.member_count} 人订阅)`;

					const onToggle = async () => {
						if (checkbox.checked) {
							this.plugin.settings.publicKnowledgeBases.push({
								encryptedKbId: base.kb_id,
								numericKbId: '',
								shareId: '',
								name: base.kb_name,
								lastSyncTime: 0,
								kbCategory: '订阅和公共知识库',
							});
						} else {
							this.plugin.settings.publicKnowledgeBases =
								this.plugin.settings.publicKnowledgeBases.filter(
									p => p.encryptedKbId !== base.kb_id,
								);
						}
						await this.plugin.saveSettings();
						updateKbDesc();
						renderPublicKbList();
					};
					checkbox.addEventListener('change', onToggle);
					label.addEventListener('click', () => {
						checkbox.checked = !checkbox.checked;
						onToggle();
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
							renderKbList(bases);
							btn.setButtonText('收起列表');
						}
					} catch (err) {
						new Notice(`获取知识库失败：${err instanceof Error ? err.message : String(err)}`);
						btn.setButtonText('查看并选择知识库');
					} finally {
						btn.setDisabled(false);
					}
				}),
		);

		// ── 手动添加公共知识库（在 kbBox 内）/ Manually add public KB (inside kbBox) ──

		new Setting(kbBox)
			.setName('添加公共知识库')
			.setDesc('粘贴分享链接或 shareId，如 https://ima.qq.com/wiki/?shareId=xxx')
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
				delBtn.addEventListener('click', async () => {
					this.plugin.settings.publicKnowledgeBases =
						this.plugin.settings.publicKnowledgeBases.filter(
							p => p !== base,
						);
					await this.plugin.saveSettings();
					renderPublicKbList();
				});
			}
		};
		renderPublicKbList();

		// ── 知识库删除同步 / KB delete sync ────────────────────────────────

		new Setting(containerEl)
			.setName('知识库删除同步')
			.setDesc('IMA 知识库中删除条目后，本地文件的处理方式')
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

		let sizeLimitContainer: HTMLDivElement | null = null;

		new Setting(containerEl)
			.setName('下载附件')
			.setDesc('将图片、PDF 等附件下载到本地（关闭则保留原始链接）')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.downloadAttachments)
					.onChange(async value => {
						this.plugin.settings.downloadAttachments = value;
						await this.plugin.saveSettings();
						if (sizeLimitContainer) {
							sizeLimitContainer.toggleClass('ima-hidden', !value);
						}
					}),
			);

		sizeLimitContainer = containerEl.createDiv();
		if (!this.plugin.settings.downloadAttachments) {
			sizeLimitContainer.addClass('ima-hidden');
		}

		new Setting(sizeLimitContainer)
			.setName('附件大小限制')
			.setDesc('超过限制的附件保留原始链接，不下载（0 = 不限制）')
			.addText(text =>
				text
					.setPlaceholder('0')
					.setValue(String(this.plugin.settings.attachmentSizeLimit))
					.onChange(async value => {
						const num = parseFloat(value);
						this.plugin.settings.attachmentSizeLimit = isNaN(num) ? 0 : Math.max(0, num);
						await this.plugin.saveSettings();
					}),
			)
			.addDropdown(drop =>
				drop
					.addOption('KB', 'KB')
					.addOption('MB', 'MB')
					.addOption('GB', 'GB')
					.setValue(this.plugin.settings.attachmentSizeLimitUnit)
					.onChange(async value => {
						this.plugin.settings.attachmentSizeLimitUnit = value as AttachmentSizeUnit;
						await this.plugin.saveSettings();
					}),
			);

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
			.setDesc('IMA 同步文件默认以阅读模式打开，防止误编辑被同步覆盖')
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
}
