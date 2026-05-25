# 关键设计决策 — ima.copilot Sync

> 本文件是 [CLAUDE.md](CLAUDE.md) 的子引用文件。修改 `sync-manager.ts`、`path-utils.ts` 或涉及同步策略时参考。

## parse_progress 检查与重试（v4.6.3）

`_nl` 端点返回 `parse_progress`（0~100，100=完成）字段。新增内容可能尚未解析完成，此时：
- 文件类型 `raw_file_url` 为 COS 相对路径，无法下载
- AI 摘要（`abstract`）为空

**处理**：同步前检查 `parse_progress < 100` → 等待 10s → 重新拉取列表 → 最多 5 次 → 仍未完成则跳过（不创建文件），下次同步自动重试。

个人/共享知识库通过 openapi `get_media_info` 获取内容，若 `url_info` 为空且条目为文件类型，同样重试 5 次后跳过。

## 个人笔记图片/文件强制本地化

COS 签名 URL 约 8 小时过期（`q-sign-time`），个人笔记的图片/文件链接若不下载到本地，每次同步都必须重写笔记刷新 URL，mtime 必然变化。因此 `doSync()` 个人笔记路径强制 `opts.downloadImages = opts.downloadFiles = true`，知识库保留用户开关控制。

设置项已拆分："下载知识库图片"/"下载知识库文件"，描述中说明个人笔记默认下载。

## 增量同步：`modify_time` 单位

API 实测 `modify_time` 为 **13 位毫秒**（如 `1778490458822` → 2026-05-11）。`sync-manager.ts:158` 增量检查不再 `* 1000`。

## 文件名稳定性

`path-utils.ts` `buildStableFilename(url, options)` — 从 COS URL path 提取稳定文件名（忽略 query string 签名），替代 `Date.now()` 时间戳。同一 URL → 同一文件名 → `exists()` 命中 → 跳过重复下载，同时使 `writeNote()` 的 `oldContent === content` 比较可以有效跳过无变化写入。

**注意**：URL path 最后一段可能无扩展名（如 `823d35eccf9141c4a06bb026019742df`），此时必须追加计算出的 `ext`（从 URL 其他部分或 `fallbackExt` 推断）。`baseFilename` 逻辑：

```
filename 有扩展名 → 直接用
filename 无扩展名 → filename + ext
filename 为空     → fallbackName + ext
```

## 个人笔记 `<file>` 标签

IMA `format=1` Markdown 中文件附件是 `<file>` XML 标签（非 Markdown 链接语法）：

```xml
<file mediaId="pdf_xxx" filePath="/Users/.../报告.pdf" fileExtension="pdf" ... />
```

`sync-manager.ts` `processInlineFileTags()` 解析 → `get_media_info(mediaId)` 获取下载 URL → `FileDownloader` 下载 → 替换为本地链接。文件名从 `filePath` 属性提取，保持原名。

## 知识库文件命名

- **非图片文件**（PDF/docx 等）：`sanitizeFilename(title)`，标题即原始文件名
- **图片**（media_type=9）：`buildStableFilename(url, ...)`，从 COS URL 提取扩展名（KB 图片标题可能无扩展名）

## 微信文章三层回退提取（v4.6.4）

微信文章存在两种 HTML 渲染模式，无法仅靠 URL 格式预判：

- **静态渲染**：`<div id="js_content">` 在静态 HTML 中 → defuddle + `contentSelector` 可完整提取图文
- **JS 动态渲染**：`#js_content` 不在静态 HTML 中，但全文在 `<meta property="og:description">` 中以 `\xHH` 转义序列编码

**三层回退流程**（`html-to-md.ts` `convertWeChatHtmlToMarkdown`）：

```
fetch HTML（所有微信 URL 统一入口，不再区分长链短链）
  → Tier 1: doc.getElementById('js_content') 存在 → defuddle（contentSelector: '#js_content'）→ 完整图文
  → Tier 2: og:description meta 提取 → decode \x → 结构化 HTML → defuddle → 完整文本（标记 fromMeta，缺图片）
  → Tier 3: 裸 defuddle + extractWeChatPublishTime
  → 若 Tier 3 内容仍为微信 UI 残渣 → syncPublicKBItem 调 buildWeChatIntroContent（IMA 兜底）
```

**Meta 提取细节**：
- `decodeWeChatMetaEscapes`：逐字符扫描 `\xHH` → `String.fromCharCode(parseInt(hex, 16))`，避免 `decodeURIComponent` 破坏中文
- HTML 实体解码：单次 `/&(lt|gt|amp|quot);/g` + lookup map，消除链式 `.replace()` 的顺序依赖
- 按 `\n\n` 分段 → `<p>` 包裹 → 构建完整 HTML → defuddle 转换
- `fromMeta: true` 标记 → `syncWebContent` 在正文前插入 `> [!warning]` 提示

**Meta 提取的限制**：
- 图片不在 og:description 中，无法获取
- `og:title` 作为备用标题；`var ct` 作为备用发布时间（复用 `extractWeChatPublishTime`）
- 正文完整性取决于微信是否截断 og:description（实测 2169 字符完整）

## guessFileExtension 域名误匹配修复（v4.6.4）

`guessFileExtension` 使用 `String.includes()` 在全 URL 中匹配已知扩展名。当图片来自 `community.obsidian.md` 的 Next.js 图片优化接口（`/_next/image?url=...`）时：
- URL path 最后一段是 `image`（无扩展名），`extractExtFromUrl` 提取失败
- 回退到 `guessFileExtension`，域名 `community.obsidian.md` 中的 `.md` 在第 228 行被匹配
- 图片保存为 `XXX-image.md`（二进制 JPEG + .md 扩展名），在 Obsidian 中嵌入时显示乱码

**修复**（`path-utils.ts`）：通过 `new URL(url)` 解析，仅对 `pathname + search + hash` 做扩展名匹配，排除域名。同时图片扩展名（png/jpg/gif/webp/svg）移到文档扩展名（pdf/doc/md 等）之前。

## sync-manager.ts 代码架构改进（v4.6.4）

### 媒体类型常量化

参照 IMA API 类型体系，补全 11 个 `MEDIA_TYPE_*` 命名常量（`1=PDF, 2=WEBPAGE, 3=WORD, 4=PPT, 5=EXCEL, 6=WECHAT, 7=MARKDOWN, 9=IMAGE, 11=NOTE, 13=TXT, 14=XMIND`）。`FILE_MEDIA_TYPES` 用常量重写，新增 `FETCHABLE_MEDIA_TYPES`（网页+微信）替代 `mediaType === 2 || mediaType === 6` 裸数字判断。

### syncWebContent 消除 boolean flag

`isWeChat: boolean` → `wechatConverter?: (html, url) => HtmlToMdResult`。调用方显式传入 `convertWeChatHtmlToMarkdown`，不传时走默认 `convertHtmlToMarkdown`。参数名用 `wechatConverter` 而非泛型 `converter`，因为类型签名仅接受前者。

### syncByMediaType 参数收敛

7 个位置参数 → `SyncMediaParams` 接口对象，调用方 `{ url, headers, title, filePath, opts, mediaId }`。

### isWeChatContentGarbage 行式解析

`indexOf('\n# ')` + `indexOf('\n', ...)` 的脆弱手动跳过 → `split('\n')` + `findIndex((l, idx) => idx > 0 && l.trim() === '---')`，处理 frontmatter 尾部空格等边界情况。

## 链接格式

- `escapePathForMarkdown(relPath)` — 路径含空格时用 `<>` 包裹（CommonMark 标准），不含空格不包裹
- `formatFileLink` 支持 wikilink 格式，跟随用户"图片引用格式"设置

## 微信文章无头浏览器提取（v4.8.0）

### 问题

微信文章有多种页面模板（标准图文 `#js_content`、图片分享页 `.share_content_page`、视频/音频消息等），其中图片分享页等格式的内容（文字和图片）完全由 JavaScript 动态加载，静态 HTML 中容器为空。无论用什么 UA/headers 都无法绕过——微信服务端返回的就是空壳 HTML。

### 方案

增加 Tier 4 回退：在 `syncWebContent` 中，当静态提取质量不足时（`fromMeta`、无 WeChat 内容容器、图片丢失、或大 HTML 但短内容），使用 Electron `BrowserWindow`（`show: false`，隐藏窗口）渲染页面后提取完整 DOM，再经 `convertWeChatHtmlToMarkdown` 转换。

### 关键设计

- **Electron API 访问**：`require('electron').remote.BrowserWindow`（与 weread-plugin 相同模式）
- **平台限制**：`Platform.isDesktop` 守卫，移动端自动跳过
- **Session 分区**：`persist:ima-copilot-wechat`，跨文章保留 cookie
- **等待策略**：`did-finish-load` 事件 + 轮询已知内容容器（最多 30s）
- **生命周期**：每次创建/销毁（try/finally 确保 `win.close()`）
- **事件监听**：使用 `webContents.once()` 避免泄漏
- **设置开关**：`downloadEnhanced`（桌面端默认开启，移动端可见但不可用）

### 内容格式检测

`detectWeChatContentSelector()` 支持多种微信页面模板：

| itemShowType | 格式 | 选择器 |
|---|---|---|
| 0 | 标准图文 | `#js_content` |
| 5 | 视频消息 | `#js_video_page_title` |
| 7 | 音频消息 | `#js_audio_title` |
| 8 | 图片分享页 | `.share_content_page` |
| 10 | 纯文字消息 | `#js_text_title` |

### 图片提取

`extractWeChatImages()` 采用双路径策略，经历了多轮迭代才稳定。详见 [1-synthetic-puddle.md](../../.claude/plans/1-synthetic-puddle.md#图片提取踩坑记录)。

核心要点：
1. **DOM `<img>` 搜索**：通过 `from=appmsg` 查询参数过滤正文图片（排除推荐缩略图），避免 `pic_blank.gif` 和 `res.wx.qq.com/mmbizappmsg` 系统资源
2. **`cdn_url` 正则**：匹配 `picture_page_info_list` 中 JS 内嵌的图片 URL（轮播隐藏图不在 DOM 中，只能用此路径拿到）
3. **URL 标准化去重**：`normalizeImgUrl()` 去除查询参数只留 `origin + pathname`，避免 `sz_mmbiz_jpg` vs `mmbiz_jpg` 不同子域名产生重复
4. **已有内容去重**：先扫描 `existingContent` 中已有 Markdown 图片，加入 `seen` 集合，防止 defuddle 已提取的图片被重复追加
5. **文件名稳定性**：`shortHash()` 替代 `/0` 结尾 URL 的长 hash，生成 8 字符短文件名；移除 `sanitizeFilename` 的 100 字符截断（会切断 `.png` 扩展名）

### 选择器来源

`WECHAT_CONTENT_SELECTORS` 数组定义在 `html-to-md.ts` 并导出，`headless-extractor.ts` 从 `html-to-md.ts` 导入——单一来源，避免双文件漂移。
