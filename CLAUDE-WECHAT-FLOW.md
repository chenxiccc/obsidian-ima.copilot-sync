# 微信公众号文章获取流程图 / WeChat Article Fetching Flow

## 总览 / Overview

```mermaid
flowchart TD
    START(["syncWebContent(url, headers, title, mediaId)"]) --> STRIP["stripWeChatTrackingParams()<br/>去除追踪参数，保留 __biz/mid/idx/sn"]
    STRIP --> FETCH

    subgraph FETCH["第一层：网络获取 / Tier 1: Network Fetch"]
        direction TB
        REQ["requestUrl(url, headers)<br/>Obsidian 内置方法"]
        REQ --> REQ_OK{"status < 400?"}
        REQ_OK -->|"是 / Yes"| HTML["获得 HTML / Got HTML"]
        REQ_OK -->|"否 / No"| ENHANCED{"downloadEnhanced<br/>开关开启?"}
        ENHANCED -->|"是 / Yes"| NODE["Node.js https.get<br/>可发送 Chrome UA 绕过防盗链"]
        ENHANCED -->|"否 / No"| THROW1["抛出异常 / Throw error"]
        NODE --> HTML
    end

    HTML --> PARSE

    subgraph PARSE["第二层：HTML→Markdown 转换 / Tier 2: HTML→Markdown Conversion"]
        direction TB
        CONVERT["convertWeChatHtmlToMarkdown(html, url)"]
        CONVERT --> BLOCK{"isWeChatBlockPage?<br/>拦截页/验证页?"}
        BLOCK -->|"是 / Yes"| EMPTY["返回空 content<br/>→ 触发 headless 回退"]
        BLOCK -->|"否 / No"| DETECT["detectWeChatContentSelector(doc)"]

        DETECT --> TIER1{"找到内容容器?<br/>#js_content / .share_content_page / 等"}
        TIER1 -->|"是 / Yes"| DEFUDDLE1["defuddle + contentSelector<br/>完整图文提取"]
        TIER1 -->|"否 / No"| TIER2{"og:description meta 存在?"}
        TIER2 -->|"是 / Yes"| META["meta 解码提取 + defuddle<br/>完整文本，缺图片<br/>标记 fromMeta: true"]
        TIER2 -->|"否 / No"| TIER3["裸 defuddle<br/>最后尝试"]
    end

    DEFUDDLE1 --> SUPP["extractWeChatImages()<br/>补充图片 + 去重"]
    META --> SUPP
    TIER3 --> SUPP
    EMPTY --> HD_CHECK
    SUPP --> RESULT["HtmlToMdResult<br/>(content, title, author, fromMeta)"]

    RESULT --> HD_CHECK

    subgraph HD["第三层：Headless 回退判断 / Tier 3: Headless Fallback Decision"]
        direction TB
        HD_CHECK{"五个条件任一满足?<br/>Any of 5 conditions?"}
        C1["① result.fromMeta<br/>meta 提取的，缺图片"]
        C2["② !hasWeChatContent(html)<br/>静态 HTML 无微信内容容器"]
        C3["③ contentTooShort<br/>content &lt; 120 字符"]
        C4["④ hasOrphanImages<br/>HTML 有 mmbiz 图但 MD 无图"]
        C5["⑤ looksLikeJsPage<br/>HTML &gt; 500KB 但 content &lt; 2000 字符"]

        C1 --> HD_CHECK
        C2 --> HD_CHECK
        C3 --> HD_CHECK
        C4 --> HD_CHECK
        C5 --> HD_CHECK

        HD_CHECK -->|"微信页面 + downloadEnhanced"| HEADLESS["HeadlessExtractor<br/>Electron BrowserWindow 渲染"]
        HD_CHECK -->|"不满足 / No"| DONE(["返回 Markdown / Return Markdown"])

        HEADLESS --> HD_OK{"提取成功?"}
        HD_OK -->|"是 / Yes"| HD_DONE["使用 headless 结果"]
        HD_OK -->|"否 / No"| WARN["⚠ 友好占位符警告<br/>引导用户手动保存"]
    end

    HD_DONE --> DONE
    WARN --> DONE

    THROW1 --> CATCH

    subgraph FINAL["第四层：最终兜底 / Tier 4: Final Fallback"]
        direction TB
        CATCH["所有静态提取都失败 / All static extraction failed"]
        CATCH --> LAST_HD{"downloadEnhanced?"}
        LAST_HD -->|"是 / Yes"| TRY_HD["最后一次 headless 尝试<br/>Last headless attempt"]
        LAST_HD -->|"否 / No"| PLACEHOLDER["友好占位符<br/>Friendly placeholder"]
        TRY_HD --> HD_LAST_OK{"成功? / OK?"}
        HD_LAST_OK -->|"是 / Yes"| DONE
        HD_LAST_OK -->|"否 / No"| PLACEHOLDER
        PLACEHOLDER --> DONE
    end

    DONE --> ESCAPE["escapeInlineHash()<br/>最终转义处理"]

    style START fill:#4CAF50,color:#fff
    style DONE fill:#4CAF50,color:#fff
    style EMPTY fill:#f44336,color:#fff
    style WARN fill:#FF9800,color:#fff
    style PLACEHOLDER fill:#FF9800,color:#fff
    style HEADLESS fill:#2196F3,color:#fff
    style NODE fill:#2196F3,color:#fff
```

## 内容容器检测优先级 / Content Container Detection Priority

```mermaid
flowchart LR
    subgraph "detectWeChatContentSelector(doc)"
        direction TB
        P1["① #js_content<br/>条件: textLength > 50"] --> P1_NO{"满足?"}
        P1_NO -->|"否"| P2["② .share_content_page<br/>条件: textLength>30 或 images≥2"]
        P2 --> P2_NO{"满足?"}
        P2_NO -->|"否"| P3["③ #js_novel_card<br/>条件: 有文本内容"]
        P3 --> P3_NO{"满足?"}
        P3_NO -->|"否"| P4["④ #js_video_page_title<br/>条件: 有标题文本"]
        P4 --> P4_NO{"满足?"}
        P4_NO -->|"否"| P5["⑤ #js_audio_title<br/>条件: 有文本内容"]
        P5 --> P5_NO{"满足?"}
        P5_NO -->|"否"| P6["⑥ .rich_media_content<br/>条件: textLength > 30"]
        P6 --> P6_NO{"满足?"}
        P6_NO -->|"否"| NULL["返回 null → 进入 Tier 2/3"]
    end
```

## 图片补充逻辑 / Image Supplement Logic

```mermaid
flowchart TD
    IMG["extractWeChatImages(html, doc, existingMd)"] --> COLLECT

    subgraph COLLECT["四路收集 / Four Collection Paths"]
        direction TB
        S1["① DOM img 标签<br/>data-src 或 src<br/>过滤: from=appmsg 正文图<br/>去重: 已存在的 MD 图片"]
        S2["② cdn_url JS 变量<br/>正则: cdn_url: '...from=appmsg...'<br/>轮播中隐藏的图不在 DOM"]
        S3["③ data-src 属性模式<br/>正则: data-src='...mmbiz/qpic...jpg/png/...'<br/>](https://过滤系统资源)
        S4["去重策略 / Dedup<br/>① 已存在 MD 中的图片 URL<br/>② normalizeImgUrl: 去查询参数 + 统一子域名"]
    end
```

## 关键文件映射 / Key File Mapping

| 文件 | 职责 |
|------|------|
| [src/sync-manager.ts](src/sync-manager.ts) `syncWebContent()` | 主流程编排：网络获取 → 转换 → headless 判断 → 兜底 |
| [src/html-to-md.ts](src/html-to-md.ts) `convertWeChatHtmlToMarkdown()` | HTML→MD 三层回退 + 图片补充 |
| [src/html-to-md.ts](src/html-to-md.ts) `detectWeChatContentSelector()` | 内容容器检测 |
| [src/html-to-md.ts](src/html-to-md.ts) `extractWeChatImages()` | 图片补充提取 |
| [src/headless-extractor.ts](src/headless-extractor.ts) | Electron BrowserWindow 无头提取 |
| [src/file-downloader.ts](src/file-downloader.ts) `downloadWithAntiHotlink()` | requestUrl → https.get 双层下载 |
| [src/file-downloader.ts](src/file-downloader.ts) `fetchHtmlViaNodeHttps()` | Node.js https 获取 HTML（桌面端兜底） |

## 核心判断逻辑总结 / Core Decision Logic

```
判断依据（按优先级）：
  1. 网络层 → downloadEnhanced 开关
  2. 解析层 → 静态 HTML 中内容容器 / meta 的存在性
  3. 质量层 → 内容长度、图片丢失、JS 渲染特征
  4. 兜底层 → 以上全部失败

不根据文章类型（小绿书/文章/图文）来判断。
Does NOT decide based on article type (小绿书/text-image/图文).
```
