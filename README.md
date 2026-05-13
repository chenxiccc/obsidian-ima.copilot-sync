# ima.copilot Sync — Obsidian Plugin

[中文](#中文) | [English](#english)

---

## 中文

将腾讯 [IMA](https://ima.qq.com) 个人笔记和知识库同步到 Obsidian vault 的插件。

### 典型使用场景

微信公众号内容转发到ima后，自动同步公众号内容到Obsidian

> **⚠ 单向同步**：本插件仅支持 **IMA → Obsidian** 单向同步。在 Obsidian 中对笔记做的任何修改**不会**同步回 IMA，每次同步会用 IMA 服务端内容覆盖本地文件。

### 功能特性

- **个人笔记同步**：将 IMA 笔记本中的所有笔记自动下载到 Obsidian
- **知识库完整同步**：同步知识库中的所有类型条目
  - **笔记**：完整同步内容并转为 Markdown
  - **网页**：提取正文内容并转为 Markdown
  - **微信文章**：短链文章提取完整正文；长链文章（订阅/公共知识库）仅同步约 300 字摘要 + AI 摘要
  - **文件**（PDF、Word、PPT、Excel 等）：个人/共享知识库可下载到本地；订阅/公共知识库仅同步 AI 摘要
- **图片和文件本地化**：自动下载笔记中的图片并保存到本地附件目录
- **增量同步**：仅同步上次同步后有修改的笔记，减少不必要的请求
- **自动定时同步**：按设定间隔自动在后台同步
- **安全凭证存储**：凭证存储于 Obsidian 钥匙串（系统 Keychain），不以明文保存在配置文件中
- **附件下载控制**：可选下载附件或保留原始链接，支持附件大小限制
- **知识库删除同步**：支持删除/保留/标记三种模式处理 IMA 端已删除的条目

### 安装方法

方法1：通过Brat安装。

方法2：手动安装：

1. 前往 [Releases](https://github.com/chenxiccc/ima-copilot-sync/releases) 下载最新版本的 `main.js` 和 `manifest.json`
2. 在 vault 的 `.obsidian/plugins/` 目录下创建 `ima-copilot-sync` 文件夹
3. 将下载的文件放入该文件夹
4. 在 Obsidian 设置 → 第三方插件中启用 **ima.copilot Sync**

### 配置步骤

#### 1. 获取 IMA OpenAPI 凭证

访问 [https://ima.qq.com/agent-interface](https://ima.qq.com/agent-interface)，登录后复制页面上的 **Client ID** 和 **API Key**。

#### 2. 填入凭证

打开 Obsidian 设置 → ima.copilot Sync，在设置页面：

- 直接将复制的凭证文本粘贴到剪贴板，点击「**粘贴并解析凭证**」按钮自动填入
- 或手动在 Client ID 和 API Key 输入框中分别填写

凭证将安全存储于 Obsidian 钥匙串中，不会以明文保存在配置文件里。

点击「**测试**」按钮验证连接是否正常。

#### 3. 选择同步内容

| 设置项        | 说明                                             |
| ------------- | ------------------------------------------------ |
| 同步 IMA 笔记 | 同步 IMA 个人笔记本中的所有笔记                  |
| 同步知识库    | 开启后选择要同步的知识库，支持所有类型条目       |
| 同步文件夹    | 笔记保存到 vault 内的哪个文件夹（默认：`ima`） |
| 同步间隔      | 自动同步的时间间隔（分钟，默认 60）              |

#### 4. 附件设置

| 设置项       | 说明                                                 |
| ------------ | ---------------------------------------------------- |
| 下载附件     | 是否将图片、PDF 等附件下载到本地（关闭则保留原链接） |
| 附件大小限制 | 超过限制的附件保留原链接，不下载（0 = 不限制）       |

### 已知限制 

- **订阅/公共知识库内容受限**：IMA API 对订阅知识库有访问限制，各类型内容的同步能力如下：
  - 笔记：仅同步约 300 字预览，无法获取完整内容
  - 微信文章（长链）：微信服务端对无登录态的请求在路由层拦截，与 UA/headers 无关，无法绕过；仅同步约 300 字正文摘要 + AI 摘要，底部附原文链接
  - 微信文章（短链）：可抓取完整正文
  - 文件（PDF/Word 等）：仅同步 AI 摘要，无法下载原件
  - 网页：可抓取完整正文
- 知识库中部分条目如果 IMA API 未返回可访问的 URL，将仅同步标题（显示为占位符）

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

> **⚠ One-way sync only**: This plugin syncs **IMA → Obsidian** only. Any edits made in Obsidian will **not** be synced back to IMA — each sync overwrites local files with the content from IMA.

### Typical Use Cases

Forward WeChat official account articles to IMA, then auto-sync the content to Obsidian.

### Features

- **Personal notes sync**: Automatically downloads all notes from your IMA notebook
- **Full knowledge base sync**: Syncs all item types from your IMA knowledge base
  - **Notes**: Full Slate content converted to Markdown
  - **Webpages/WeChat articles**: Extracts main content and converts to Markdown
  - **Files** (PDF, Word, PPT, Excel, etc.): Downloads to local attachment directory
- **Image and file localization**: Downloads inline images and file attachments to a local folder
- **Incremental sync**: Only fetches notes modified since the last sync
- **Auto periodic sync**: Runs silently in the background on a configurable interval
- **Secure credential storage**: Credentials stored in Obsidian keychain (system Keychain), never saved in plaintext
- **Attachment download control**: Optionally download attachments or keep original links, with size limit support
- **Knowledge base delete sync**: Three modes (delete/keep/mark) for handling items deleted from IMA

### Installation

Manual installation is required for now:

1. Go to [Releases](https://github.com/chenxiccc/ima-copilot-sync/releases) and download the latest `main.js` and `manifest.json`
2. Create a folder named `ima-copilot-sync` under your vault's `.obsidian/plugins/` directory
3. Place the downloaded files into that folder
4. In Obsidian Settings → Community plugins, enable **ima.copilot Sync**

### Setup

#### 1. Get IMA OpenAPI credentials

Visit [https://ima.qq.com/agent-interface](https://ima.qq.com/agent-interface), log in, and copy your **Client ID** and **API Key**.

#### 2. Enter credentials

Open Obsidian Settings → ima.copilot Sync:

- Paste the copied credential text to your clipboard and click **「粘贴并解析凭证」** to auto-fill
- Or enter the Client ID and API Key manually in their respective fields

Credentials are securely stored in the Obsidian keychain and never saved in plaintext.

Click **「测试」** to verify the connection.

#### 3. Choose what to sync

| Setting             | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| Sync IMA Notes      | Sync all notes from your IMA personal notebook              |
| Sync Knowledge Base | Enable and select a knowledge base to sync (all item types) |
| Sync Folder         | Vault folder where notes are saved (default:`ima`)        |
| Sync Interval       | Auto-sync interval in minutes (default: 60)                 |

#### 4. Attachment settings

| Setting              | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| Download Attachments | Download images/PDFs locally, or keep original links if disabled |
| Size Limit           | Skip download for attachments exceeding the limit (0 = no limit) |

### Known Limitations

- **Subscribed/Public knowledge base content is limited**: IMA API restricts access to subscribed knowledge bases. Sync capabilities by content type:
  - Notes: Only ~300 character preview, full content not available
  - WeChat articles (long URL): WeChat server blocks requests without login session at the routing layer, independent of UA/headers — cannot bypass; only ~300 character excerpt + AI summary, with original link at the bottom
  - WeChat articles (short URL): Full article content can be fetched
  - Files (PDF/Word etc.): Only AI summary available, original files cannot be downloaded
  - Webpages: Full content can be fetched
- Some knowledge base items may only sync the title (shown as a placeholder) if the IMA API does not return an accessible URL

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
