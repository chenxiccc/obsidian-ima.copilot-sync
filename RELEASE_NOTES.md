## 6.4.0

### 新功能

- **API 请求限频保护**：新增全局节流（两次 openapi 请求间隔 ≥ 200ms）与限频码指数退避重试（10s → 30s → 90s，最多 3 次），统一处理网关层 200001、notes 业务层 20002、wiki 业务层 110021 三类「请求频率超限」错误，避免密集翻页和逐篇同步时触发限频导致同步中断

### 修复

- **测试连接触发限频（#2）**：测试连接不再调用 `listAllNotes` 遍历全部笔记，改为单次 `limit=1` 轻量探测（`testConnection`）；探测走不退避路径并加 15s 超时兜底，命中限频立即提示而非卡死按钮 130s
- **非 JSON 响应崩溃**：腾讯 WAF 拦截等场景返回 HTML 时，`response.json` 解析不再抛 `TypeError`，统一包装为 `ImaApiError` 给出友好提示
- **错误提示完善**：限频错误保留服务器原始诊断信息（`请求频率超限，请稍后重试（{原始 msg}）`），`code=0` 但缺 `data` 字段的异常空响应显式抛错

## 6.3.0

### 新功能

- **移动端桌面使用建议**：非桌面端（手机/平板）打开插件设置页时，顶部显示双语提示框，建议用户在桌面端使用以获取「下载增强」功能带来的微信公众号和防盗链图片下载成功率提升

### 修复

- **知乎时间提取重构**：统一使用 `js-initialData` 提取发布时间，移除不可靠的 `.ContentItem-time` CSS 选择器文本解析
- **知乎回答页时区修正**：修复知乎回答页 `published` 时区未正确转换的问题，`updatedTime` 优先于 `createdTime`
- **知乎专栏 URL 匹配修复**：修复知乎专栏 URL 匹配不完整的问题，对齐 share-to-save 架构
- **`buildWebFrontmatter` ISO 时间保护**：已有 ISO 8601 时间不再被强制转换为 UTC，避免时区信息丢失
- **README 版权引用**：License 章节添加 defuddle 版权引用

## 6.2.0

### 新功能

- **HTTP 工具模块**：新增集中化的请求头构建（`buildHeaders`），包含现代浏览器必发的 `Sec-Fetch-*` 系列头、`Accept-Language` 和 `Referer`，提升防盗链绕过能力
- **Content-Type 驱动扩展名检测**：下载文件时检查 HTTP `Content-Type` 响应头，当 URL 扩展名与实际 MIME 类型不一致时（如知乎 CDN `.avis` 实际为 PNG），自动修正文件扩展名。优先级：`wx_fmt` > Content-Type > URL 扩展名
- **Headless 三信号就绪检测**：Electron BrowserWindow 提取页面时同时检测网络空闲、DOM 稳定（MutationObserver）、内容稳定三种信号，替代原有的简单轮询，提升 JS 渲染页面提取可靠性
- **computed style 戳记**：提取 HTML 前将 `display:none` / `visibility:hidden` / `opacity:0` 写为 inline style，使 defuddle 在 DOMParser 上下文中也能检测 CSS 隐藏元素
- **图片并发下载 + 内容哈希去重**：同一篇笔记的图片改为 3 路并发下载，新增内容哈希去重（同批次相同内容只保存一份）和逐字节已有文件比对
- **Node.js 下载重试**：网络错误、超时、429 限流、5xx 服务端错误自动重试（1s/2s 指数退避，最多 2 次），提升下载成功率
- **元数据增强**：新增 Schema.org JSON-LD 解析、站点名剥离（`"标题 | 站点名"` → `"标题"`）、作者/发布日期兜底提取，改善笔记 frontmatter 质量
- **知乎 DOM 预处理**：新增知乎专栏/问答页面专用预处理（实体链接剥离、登录弹窗移除、代码块规范化、懒加载图片修复、发布时间提取）
- **小红书元数据增强**：从 `__INITIAL_STATE__` 提取作者、发布时间、正文内容，支持视频笔记标记
- **文件名修缮**：`sanitizeFilename` 增加首尾点号/空格剥离（Windows 兼容）和空值 `'untitled'` 回退

### 改进

- CHROME_UA 升级至 Chrome 148
- Node.js https 下载支持 HTTP 协议（非 HTTPS URL）
- 新增 `FileDownloader.downloadToBuffer()` 方法，支持下载到内存获取 Content-Type
- 验证码检测签名扩充至 12 条（新增 Cloudflare Turnstile、Google reCAPTCHA、hCaptcha）
- 新增 `ElectronWebContents` / `ElectronBrowserWindow` 类型接口替换 headless 提取器中的 `any`
- 重定向跟随增加上限控制（最多 5 次）

### 修复

- 修复 `listMdPathsInFolder` / `scanExistingNoteFiles` 路径翻倍 bug（`adapter.list()` 返回 vault 完整路径，重复拼接前缀导致增量同步退化为全量重下载）
- 修复 headless 重定向后 timeout 竞态问题
- 修复 HTTP 304 Not Modified 被误判为成功下载
- 修复 headless 空白页面永远无法稳定退出的轮询问题
- 修复 `convertHtmlToMarkdown` HTML 双重解析的性能浪费
- 修复 `stripSiteName` 正则回溯（ReDoS）风险
- 修复小红书主路径绕过 `enhanceMetadata` 导致缺失站点名剥离
- 删除未使用的 `DefuddleResponse` 导入、空 `if (isXhs) {}` 块等代码
