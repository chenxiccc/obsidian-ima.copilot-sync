## 6.5.1

### 修复

- **微信公众号文章同步只剩"营销审核"遮罩词、正文全丢**：微信文章 headless 渲染后返回「正文 `#js_content`（完整可见）+ 营销审核遮罩层（`visibility:hidden` 浮层）」共存的页面，此前用 defuddle 提取时，defuddle 对微信 flexbox `<section>` 伪结构无法识别，导致结构塌缩 + 正文丢失，结果文件只剩一行遮罩提示语。改用 **turndown 直取 `#js_content` 节点**（参照 Obsidian-Share-to-Save 的 WeChatConverter），正文、列表、段落结构、图片全部保真
- **微信文章图片只下载到 1 张（应为 13 张）**：defuddle 提取丢失了正文内大部分图片，改用 turndown 后图片完整输出，由现有 `imageHandler.processContent` 统一下载本地化
- **微信文章标题/作者/发布时间丢失**：turndown 不返回元数据，现从 `#activity-name` / `og:title` 提取标题，从 `.wx_follow_nickname` / `#js_name` 提取公众号名，从 `extractWeChatPublishTime` 提取发布时间
- **多重 `****` 加粗标记**：微信编辑器产生嵌套 `<strong><strong>text</strong></strong>`，turndown 输出 `****text****`。新增 `normalizeBoldElements` DOM 预处理扁平化嵌套 bold，输出正常 `**text**`
- **加粗 `**` 跨行导致 Obsidian 无法渲染**：turndown 遇到跨越 `<br>` 的 `<strong>` 时把 `**` 放到换行后。新增 `normalizeBoldMarkers` Markdown 后处理，将跨行的 `**text\n**` 合并为单行 `**text**`
- **正文大量连续空行**：turndown 对微信空 `<section>` 输出多个连续空行。新增 `cleanWeChatWhitespace` 后处理，合并 3+ 连续空行为最多一个空行
- **微信伪列表塌缩为段落**：微信编辑器用 flexbox `<section>` 模拟列表（`<section>• </section><section>正文</section>`）而非标准 `<ul>/<li>`，turndown 不识别此伪结构会拆成独立段落。新增伪列表合并预处理，把 marker 前置到内容 section，输出正确的 `-` 列表项
- **微信营销审核遮罩污染提取**：新增 `.weui-half-screen-dialog` / `.ad_control-tips` / `[class*="ad_control"]` / `.pay_area` / `.wx_bottom_modal` 到 UI 移除清单，避免遮罩层文字混入正文
- **拦截页判定增强**：`isWeChatBlockPage` 新增"未经审核的第三方商业营销信息""请确认是否继续访问"关键词检测，并区分「真拦截页（纯遮罩无正文，短路返回）」与「正文 + 遮罩共存（走主路径提取）」两种形态

### 新增

- 引入 `turndown`（含 `@joplin/turndown-plugin-gfm` GFM 扩展：表格、删除线、任务列表、围栏代码块）作为微信文章 HTML→Markdown 转换器，defuddle 仍用于知乎 / 小红书 / 通用网页及微信回退路径

### 内部

- 微信转换器基础设施照搬 Obsidian-Share-to-Save `content-converter.ts` WeChatConverter：`getWeChatTurndown`（单例 + 4 条自定义规则：image / svgImage / jsLink / linkedImage）、`buildCleanWeChatHtml`（节点级预处理：data-src 提升、UI 移除、代码块合并、图片去重、伪列表合并）、`escapeLinkDestination`（URL 特殊字符转义）
- 微信回退路径（Tier 1/2/3，静态 HTML 兜底）保留 defuddle 不变
