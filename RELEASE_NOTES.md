## 6.6.0

### 修复

- **微信公众号文章发布时间晚 8 小时**：`extractWeChatPublishTime` 从 Unix 时间戳转换时漏了时区偏移，输出 UTC 而非北京时间（如实际 `2026-07-09T10:09:17` 被记为 `02:09:17`）。现统一加 `+8h` 偏移（与知乎/小红书路径一致，参照 Obsidian-Share-to-Save `extractCreateTime`）。`createTime` 预格式化字符串分支改为直接拼接输出，避免非 UTC+8 机器上 `new Date` 本地解析导致的二次偏移
- **`create_time` 提取漏第三种格式**：补 `var create_time = '1234567890'` 赋值格式正则

### 新增

- **微信文章 HTML 代码示例保护**：微信技术类文章常含 `&lt;div&gt;` 等 HTML 标签实体，DOMParser 解码后 turndown 会输出原始 `<div>` 标签污染 Markdown。新增 `protectAngleBrackets`（DOMParser 前把 `&lt;`/`&gt;` 替换为 ANGLT/ANGGT 占位符，保护 code/pre/title 块原样）+ `restoreAngleBrackets`（turndown 后把 ANGLT+标签名+ANGGT 还原为行内代码 `` `<tag>` ``，其余还原为实体编码）。照搬 Obsidian-Share-to-Save `text-utils.ts`

### 内部

- **微信主路径接入完整后处理管线**（对齐 Obsidian-Share-to-Save `postprocessContent`）：`restoreAngleBrackets` → Tab→空格（防 Obsidian 误判缩进为代码块）→ `normalizeBoldMarkers`（已有）→ `normalizeMultilineLinks`（折叠 `[\n\ntext\n\n](url)` 断裂链接）→ `cleanWeChatWhitespace`（已有）。回退路径末尾也加 `restoreAngleBrackets` 防御
- `convertWeChatHtmlToMarkdown` 入口加 `protectAngleBrackets` 预处理，影响整个 doc（含 isWeChatBlockPage 检测、buildCleanWeChatHtml、回退路径），链路自洽
- 至此微信提取管线已与 Obsidian-Share-to-Save 完全对齐
