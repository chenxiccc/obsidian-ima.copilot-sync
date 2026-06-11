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
