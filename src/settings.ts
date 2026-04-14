import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ImaPlugin from './main';
import { ImaClient } from './ima-client';

// ─── 设置数据结构 / Settings data structure ────────────────────────────────

// ─── 附件路径模式 / Attachment path mode ────────────────────────────────────
/** subfolder: 同步目录下固定子文件夹 / Fixed subfolder under sync dir
 *  obsidian: 跟随 Obsidian 附件设置 / Follow Obsidian attachment settings
 *  samename: 同步目录下与笔记同名的文件夹 / Folder named after note under sync dir */
export type AttachmentPathMode = 'subfolder' | 'obsidian' | 'samename';

// ─── 图片链接格式 / Image link format ────────────────────────────────────────
/** auto: 跟随 Obsidian 设置 / Follow Obsidian settings
 *  wikilink: Obsidian wiki 格式 ![[file]] / Obsidian wiki format
 *  markdown: 标准 Markdown 格式 ![alt](path) / Standard Markdown format */
export type LinkFormat = 'auto' | 'wikilink' | 'markdown';

export interface ImaPluginSettings {
	/** IMA OpenAPI Client ID */
	clientId: string;
	/** IMA OpenAPI API Key */
	apiKey: string;
	/** vault 内的同步文件夹名 / Sync folder name within vault */
	syncFolder: string;
	/** 自动同步间隔（分钟）/ Auto sync interval in minutes */
	syncIntervalMinutes: number;
	/** 是否同步 IMA 笔记 / Whether to sync IMA notes */
	syncNotes: boolean;
	/** 是否同步知识库（笔记类条目）/ Whether to sync knowledge base (note-type items) */
	syncKnowledgeBase: boolean;
	/** 要同步的知识库 ID / Knowledge base ID to sync */
	knowledgeBaseId: string;
	/**
	 * 上次同步时间戳（毫秒），存入 data.json，不展示在 UI 中
	 * Last sync timestamp in ms, stored in data.json, not shown in UI
	 */
	lastSyncTime: number;
	/** 是否输出调试日志文件 / Whether to write debug log file */
	enableDebugLog: boolean;
	/** 附件保存路径模式 / Attachment save path mode */
	attachmentPathMode: AttachmentPathMode;
	/** 附件子文件夹名（subfolder 模式下使用）/ Attachment subfolder name (used in subfolder mode) */
	attachmentSubfolderName: string;
	/** 图片引用链接格式 / Image link format */
	linkFormat: LinkFormat;
}

export const DEFAULT_SETTINGS: ImaPluginSettings = {
	clientId: '',
	apiKey: '',
	syncFolder: 'ima',
	syncIntervalMinutes: 60,
	syncNotes: true,
	syncKnowledgeBase: false,
	knowledgeBaseId: '',
	lastSyncTime: 0,
	enableDebugLog: false,
	attachmentPathMode: 'subfolder',
	attachmentSubfolderName: 'attachments',
	linkFormat: 'auto',
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

		const credBox = containerEl.createDiv();
		Object.assign(credBox.style, {
			background: 'var(--background-secondary)',
			borderRadius: '8px',
			padding: '4px 0',
			marginBottom: '16px',
		});

		new Setting(credBox)
			.setName('Client ID')
			.setDesc('IMA OpenAPI 的 Client ID')
			.addText(text => {
				text
					.setPlaceholder('输入 Client ID')
					.setValue(this.plugin.settings.clientId)
					.onChange(async value => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					});
				// 拉长输入框，适应 100 字符 / Widen input to fit 100 chars
				text.inputEl.style.width = '400px';
			}).settingEl.style.borderTop = 'none';

		new Setting(credBox)
			.setName('API Key')
			.setDesc('IMA OpenAPI 的 API Key')
			.addText(text => {
				text
					.setPlaceholder('输入 API Key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async value => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
				// 隐藏输入内容 / Hide input content
				text.inputEl.type = 'password';
				// 拉长输入框，适应 100 字符 / Widen input to fit 100 chars
				text.inputEl.style.width = '400px';
			}).settingEl.style.borderTop = 'none';

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

						// 解析格式：API Key: xxx 和 Client ID: xxx（顺序无关）
						// Parse format: API Key: xxx and Client ID: xxx (order-independent)
						const apiKeyMatch = text.match(/API\s*Key\s*[:：]\s*(.+)/i);
						const clientIdMatch = text.match(/Client\s*ID\s*[:：]\s*(.+)/i);

						if (!apiKeyMatch && !clientIdMatch) {
							new Notice('未识别到有效凭证，请确认格式为 "API Key: xxx" 和 "Client ID: xxx"');
							return;
						}

						if (apiKeyMatch) {
							this.plugin.settings.apiKey = apiKeyMatch[1]?.trim() ?? '';
						}
						if (clientIdMatch) {
							this.plugin.settings.clientId = clientIdMatch[1]?.trim() ?? '';
						}

						await this.plugin.saveSettings();
						// 刷新页面以更新输入框显示 / Refresh page to update input display
						this.display();
						new Notice('凭证已填入');
					}),
			).settingEl.style.borderTop = 'none';

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
			.setDesc('同步知识库中的笔记类条目（仅支持笔记类型，其他格式如 PDF、网页暂不支持）')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.syncKnowledgeBase)
					.onChange(async value => {
						this.plugin.settings.syncKnowledgeBase = value;
						await this.plugin.saveSettings();
					}),
			);

		// 已选知识库展示行 / Currently selected knowledge base display row
		const kbSelectedSetting = new Setting(containerEl)
			.setName('选择要同步的知识库')
			.setDesc(
				this.plugin.settings.knowledgeBaseId
					? `当前已选：${this.plugin.settings.knowledgeBaseId}`
					: '未选择知识库',
			);

		// 知识库列表容器（默认隐藏）/ Knowledge base list container (hidden by default)
		const kbListContainer = containerEl.createDiv({ cls: 'ima-kb-list' });
		kbListContainer.style.display = 'none';
		kbListContainer.style.marginLeft = '0';
		kbListContainer.style.marginBottom = '12px';

		/** 渲染知识库选项列表 / Render knowledge base option list */
		const renderKbList = (bases: Array<{ id: string; name: string }>) => {
			kbListContainer.empty();
			kbListContainer.style.display = 'block';

			for (const base of bases) {
				const row = kbListContainer.createDiv({ cls: 'ima-kb-row' });
				row.style.display = 'flex';
				row.style.alignItems = 'center';
				row.style.gap = '8px';
				row.style.padding = '4px 0';

				const radio = row.createEl('input') as HTMLInputElement;
				radio.type = 'radio';
				radio.name = 'ima-kb-radio';
				radio.value = base.id;
				radio.checked = base.id === this.plugin.settings.knowledgeBaseId;

				const label = row.createEl('label');
				label.textContent = `${base.name}`;
				label.style.cursor = 'pointer';
				const idSpan = label.createEl('span');
				idSpan.textContent = `  (${base.id})`;
				idSpan.style.color = 'var(--text-muted)';
				idSpan.style.fontSize = '0.85em';

				// 点击整行也可以选中 / Clicking the whole row selects
				const select = async () => {
					radio.checked = true;
					this.plugin.settings.knowledgeBaseId = base.id;
					await this.plugin.saveSettings();
					kbSelectedSetting.setDesc(`当前已选：${base.name}（${base.id}）`);
				};
				radio.addEventListener('change', select);
				label.addEventListener('click', select);
			}
		};

		kbSelectedSetting.addButton(btn =>
			btn
				.setButtonText('查看并选择知识库')
				.onClick(async () => {
					// 切换显示/隐藏 / Toggle show/hide
					if (kbListContainer.style.display !== 'none') {
						kbListContainer.style.display = 'none';
						btn.setButtonText('查看并选择知识库');
						return;
					}

					const { clientId, apiKey } = this.plugin.settings;
					if (!clientId || !apiKey) {
						new Notice('请先填写 Client ID 和 API Key');
						return;
					}
					btn.setDisabled(true);
					btn.setButtonText('加载中…');
					try {
						const client = new ImaClient(clientId, apiKey);
						const bases = await client.listKnowledgeBases();
						if (bases.length === 0) {
							new Notice('未找到任何知识库');
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
							// 回写旧值 / Reset to old value
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

		// ── 附件路径设置 / Attachment path settings ──────────────────────────

		// 子文件夹名输入行（仅 subfolder 模式显示）/ Subfolder name row (visible only in subfolder mode)
		const subfolderNameSetting = new Setting(containerEl)
			.setName('附件子文件夹名')
			.setDesc('附件保存的子文件夹名称')
			.addText(text =>
				text
					.setPlaceholder('attachments')
					.setValue(this.plugin.settings.attachmentSubfolderName)
					.onChange(async value => {
						this.plugin.settings.attachmentSubfolderName = value.trim() || 'attachments';
						await this.plugin.saveSettings();
					}),
			);
		subfolderNameSetting.settingEl.style.display =
			this.plugin.settings.attachmentPathMode === 'subfolder' ? '' : 'none';

		new Setting(containerEl)
			.setName('附件保存位置')
			.setDesc('图片等附件下载后保存的位置')
			.addDropdown(drop => {
				drop
					.addOption('subfolder', '同步目录下子文件夹（可自定义名称）')
					.addOption('obsidian', '跟随 Obsidian 附件设置')
					.addOption('samename', '同步目录下与笔记同名的文件夹')
					.setValue(this.plugin.settings.attachmentPathMode)
					.onChange(async value => {
						this.plugin.settings.attachmentPathMode = value as AttachmentPathMode;
						await this.plugin.saveSettings();
						// 控制子文件夹名输入行的显示 / Show/hide subfolder name row
						subfolderNameSetting.settingEl.style.display =
							value === 'subfolder' ? '' : 'none';
					});
			});

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

		// ── 测试连接 / Test connection ──────────────────────────────────────

		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('验证 Client ID 和 API Key 是否有效')
			.addButton(btn =>
				btn
					.setButtonText('测试')
					.onClick(async () => {
						const { clientId, apiKey } = this.plugin.settings;
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

		// ── 手动同步 / Manual sync ──────────────────────────────────────────

		new Setting(containerEl)
			.setName('立即同步')
			.setDesc('手动触发一次全量同步')
			.addButton(btn =>
				btn
					.setButtonText('立即同步')
					.onClick(async () => {
						// 重置 lastSyncTime 以触发全量同步
						// Reset lastSyncTime to trigger full sync
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
