import type { ImageHandler, AttachmentOptions } from './image-handler';

// ─── Slate 节点类型定义 / Slate node type definitions ────────────────────────

interface SlateNode {
	type?: string;
	text?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	children?: SlateNode[];
	/** cloud_image URL / 图片地址 */
	url?: string;
	/** 有序列表标记 / Ordered list marker */
	listStyleType?: string;
	/** 列表起始编号 / List start number */
	listStart?: number;
	/** 列表分组 ID / List group ID */
	listGroup?: string;
	/** 表格列宽 / Table column sizes */
	colSizes?: number[];
	[key: string]: unknown;
}

// ─── JSON → Markdown 转换器 / JSON to Markdown converter ─────────────────────

export class JsonToMarkdown {
	constructor(private readonly imageHandler: ImageHandler) {}

	/**
	 * 将 Slate JSON 字符串转为 Markdown
	 * Convert Slate JSON string to Markdown
	 *
	 * @param jsonStr      IMA API 返回的 JSON 字符串 / JSON string from IMA API
	 * @param noteFilePath 笔记在 vault 中的路径（用于解析附件位置）/ Note path in vault
	 * @param opts         附件处理选项 / Attachment options
	 */
	async convert(jsonStr: string, noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		let nodes: SlateNode[];
		try {
			nodes = JSON.parse(jsonStr) as SlateNode[];
		} catch {
			// 解析失败则原样返回 / Return as-is if parse fails
			return jsonStr;
		}

		if (!Array.isArray(nodes)) return jsonStr;

		const parts: string[] = [];
		let prevListGroup = '';

		for (const node of nodes) {
			const rendered = await this.convertBlock(node, noteFilePath, opts);
			if (rendered === null) continue;

			const isListItem = node.type === 'p' && node.listStyleType != null;
			const currentGroup = isListItem ? ((node.listGroup as string) ?? '__list__') : '';

			if (parts.length > 0) {
				// 同一列表组内用单换行，否则用双换行分段
				// Same list group: single newline; otherwise double newline for paragraph break
				const sep = isListItem && currentGroup === prevListGroup ? '\n' : '\n\n';
				parts.push(sep);
			}

			parts.push(rendered);
			prevListGroup = currentGroup;
		}

		return parts.join('').trim();
	}

	/** 处理块级节点 / Process block-level node */
	private async convertBlock(node: SlateNode, noteFilePath: string, opts: AttachmentOptions): Promise<string | null> {
		const type = node.type;

		if (type === 'p') {
			const inline = await this.convertInline(node.children ?? [], noteFilePath, opts);
			// 跳过完全空白的段落 / Skip fully empty paragraphs
			if (!inline.trim()) return null;

			if (node.listStyleType === 'decimal') {
				const num = node.listStart ?? 1;
				// 列表项内换行替换为空格 / Replace newlines inside list items with spaces
				return `${num}. ${inline.replace(/\n/g, ' ')}`;
			}
			return inline;
		}

		if (type === 'cursor-side') {
			// 通常包含图片 / Usually wraps an image
			const inline = await this.convertInline(node.children ?? [], noteFilePath, opts);
			return inline.trim() || null;
		}

		if (type === 'cloud_image') {
			return await this.handleImage(node, noteFilePath, opts);
		}

		if (type === 'table') {
			return await this.convertTable(node, noteFilePath, opts);
		}

		// 未知块类型：尝试提取子节点文本 / Unknown block: try to extract children text
		if (node.children) {
			const inline = await this.convertInline(node.children, noteFilePath, opts);
			return inline.trim() || null;
		}

		return null;
	}

	/** 处理行内子节点 / Process inline children */
	private async convertInline(children: SlateNode[], noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		const parts: string[] = [];

		for (const child of children) {
			if (typeof child.text === 'string') {
				parts.push(this.formatText(child));
			} else if (child.type === 'cloud_image') {
				parts.push(await this.handleImage(child, noteFilePath, opts));
			} else if (child.children) {
				parts.push(await this.convertInline(child.children, noteFilePath, opts));
			}
		}

		return parts.join('');
	}

	/** 应用行内格式（加粗、斜体等）/ Apply inline formatting */
	private formatText(node: SlateNode): string {
		let text = node.text ?? '';
		if (!text) return '';
		if (node.strikethrough) text = `~~${text}~~`;
		if (node.italic) text = `*${text}*`;
		if (node.bold) text = `**${text}**`;
		return text;
	}

	/** 下载图片并返回格式化链接 / Download image and return formatted link */
	private async handleImage(node: SlateNode, noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		const url = node.url as string | undefined;
		if (!url) return '';

		try {
			return await this.imageHandler.downloadAndLink(url, noteFilePath, opts);
		} catch {
			console.warn(`IMA Sync: 图片下载失败，保留原始链接 / Image download failed, keeping original link: ${url}`);
			return `![image](${url})`;
		}
	}

	/** 将表格节点转为 Markdown 表格 / Convert table node to Markdown table */
	private async convertTable(node: SlateNode, noteFilePath: string, opts: AttachmentOptions): Promise<string> {
		const rows = (node.children ?? []).filter(c => c.type === 'tr');
		if (rows.length === 0) return '';

		const tableData: string[][] = [];

		for (const row of rows) {
			const cells = (row.children ?? []).filter(c => c.type === 'td');
			const cellTexts: string[] = [];
			for (const cell of cells) {
				// 单元格内容是 p 节点数组 / Cell content is array of p nodes
				const texts: string[] = [];
				for (const p of (cell.children ?? [])) {
					const t = await this.convertInline(p.children ?? [], noteFilePath, opts);
					if (t.trim()) texts.push(t.trim());
				}
				// 管道符转义 / Escape pipe characters
				cellTexts.push(texts.join(' ').replace(/\|/g, '\\|'));
			}
			tableData.push(cellTexts);
		}

		if (tableData.length === 0) return '';

		const colCount = Math.max(...tableData.map(r => r.length));
		const pad = (row: string[]) => row.concat(Array(colCount - row.length).fill(''));

		const lines: string[] = [];
		// 第一行作为表头 / First row as header
		lines.push('| ' + pad(tableData[0] ?? []).join(' | ') + ' |');
		// 分隔行 / Separator
		lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');
		// 数据行 / Data rows
		for (let i = 1; i < tableData.length; i++) {
			lines.push('| ' + pad(tableData[i] ?? []).join(' | ') + ' |');
		}

		return lines.join('\n');
	}
}
