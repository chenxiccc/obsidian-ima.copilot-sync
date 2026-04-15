# IMA Sync — Obsidian Plugin

[中文](#中文) | [English](#english)

---

## 中文

将腾讯 [IMA](https://ima.qq.com) 个人笔记和知识库同步到 Obsidian vault 的插件。

### 功能特性

- **个人笔记同步**：将 IMA 笔记本中的所有笔记自动下载到 Obsidian
- **知识库同步**：同步知识库中的笔记类型条目
- **图片本地化**：自动下载笔记中的图片并保存到本地附件目录
- **增量同步**：仅同步上次同步后有修改的笔记，减少不必要的请求
- **灵活的附件路径**：支持三种附件保存位置模式
- **图片链接格式**：支持 Obsidian wiki 格式和标准 Markdown 格式
- **自动定时同步**：按设定间隔自动在后台同步
- **一键粘贴凭证**：支持从剪贴板自动解析填入 Client ID 和 API Key

### 安装方法

目前需要手动安装：

1. 前往 [Releases](https://github.com/chenxiccc/obsidian-ima.copilot-sync/releases) 下载最新版本的 `main.js` 和 `manifest.json`
2. 在 vault 的 `.obsidian/plugins/` 目录下创建 `obsidian-ima-sync` 文件夹
3. 将下载的文件放入该文件夹
4. 在 Obsidian 设置 → 第三方插件中启用 **IMA Sync**

### 配置步骤

#### 1. 获取 IMA OpenAPI 凭证

访问 [https://ima.qq.com/agent-interface](https://ima.qq.com/agent-interface)，登录后复制页面上的 **Client ID** 和 **API Key**。

#### 2. 填入凭证

打开 Obsidian 设置 → IMA Sync，在设置页面：

- 直接将复制的凭证文本粘贴到剪贴板，点击「**粘贴并解析凭证**」按钮自动填入
- 或手动在 Client ID 和 API Key 输入框中分别填写

点击「**测试**」按钮验证连接是否正常。

#### 3. 选择同步内容

| 设置项 | 说明 |
|--------|------|
| 同步 IMA 笔记 | 同步 IMA 个人笔记本中的所有笔记 |
| 同步知识库 | 开启后选择要同步的知识库（仅支持笔记类型条目） |
| 同步文件夹 | 笔记保存到 vault 内的哪个文件夹（默认：`ima`） |
| 同步间隔 | 自动同步的时间间隔（分钟，默认 60） |

#### 4. 附件设置

| 模式 | 说明 |
|------|------|
| 同步目录下子文件夹 | 附件统一保存到 `<同步文件夹>/attachments/`（可自定义名称） |
| 跟随 Obsidian 设置 | 使用 Obsidian 全局附件设置 |
| 与笔记同名文件夹 | 每篇笔记的附件保存到与笔记同名的文件夹中 |

### 已知限制

- 知识库中的**网页书签、微信文章、PDF、Word** 等非笔记类型条目，目前仅同步标题，暂不支持获取原文内容（IMA API 限制）
- 图片 URL 为腾讯 COS 临时签名链接，约 8 小时后失效；插件会在每次同步时自动修复失效的图片链接

### 开发构建

```bash
# 安装依赖
npm install

# 开发模式（文件监听）
npm run dev

# 生产构建
npm run build
```

---

## English

An Obsidian plugin to sync notes from [Tencent IMA](https://ima.qq.com) personal notebook and knowledge base into your Obsidian vault.

### Features

- **Personal notes sync**: Automatically downloads all notes from your IMA notebook
- **Knowledge base sync**: Syncs note-type items from your IMA knowledge base
- **Image localization**: Downloads inline images and saves them to a local attachment folder
- **Incremental sync**: Only fetches notes modified since the last sync
- **Flexible attachment paths**: Three modes for where attachments are saved
- **Image link format**: Supports both Obsidian wikilink and standard Markdown formats
- **Auto periodic sync**: Runs silently in the background on a configurable interval
- **One-click credential paste**: Parses Client ID and API Key directly from clipboard

### Installation

Manual installation is required for now:

1. Go to [Releases](https://github.com/chenxiccc/obsidian-ima.copilot-sync/releases) and download the latest `main.js` and `manifest.json`
2. Create a folder named `obsidian-ima-sync` under your vault's `.obsidian/plugins/` directory
3. Place the downloaded files into that folder
4. In Obsidian Settings → Community plugins, enable **IMA Sync**

### Setup

#### 1. Get IMA OpenAPI credentials

Visit [https://ima.qq.com/agent-interface](https://ima.qq.com/agent-interface), log in, and copy your **Client ID** and **API Key**.

#### 2. Enter credentials

Open Obsidian Settings → IMA Sync:

- Paste the copied credential text to your clipboard and click **「粘贴并解析凭证」** to auto-fill
- Or enter the Client ID and API Key manually in their respective fields

Click **「测试」** to verify the connection.

#### 3. Choose what to sync

| Setting | Description |
|---------|-------------|
| Sync IMA Notes | Sync all notes from your IMA personal notebook |
| Sync Knowledge Base | Enable and select a knowledge base to sync (note-type items only) |
| Sync Folder | Vault folder where notes are saved (default: `ima`) |
| Sync Interval | Auto-sync interval in minutes (default: 60) |

#### 4. Attachment settings

| Mode | Description |
|------|-------------|
| Subfolder under sync dir | Attachments saved to `<sync-folder>/attachments/` (customizable name) |
| Follow Obsidian settings | Uses Obsidian's global attachment settings |
| Same-name folder | Each note's attachments saved in a folder named after the note |

### Known Limitations

- Knowledge base items of type **webpage bookmark, WeChat article, PDF, Word**, etc. currently only sync the title — full content is not available due to IMA API restrictions
- Image URLs are Tencent COS temporary signed links that expire after ~8 hours; the plugin automatically repairs broken image links on each sync

### Development

```bash
# Install dependencies
npm install

# Development mode (watch)
npm run dev

# Production build
npm run build
```

### License

MIT
