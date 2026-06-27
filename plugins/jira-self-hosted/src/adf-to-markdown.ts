/**
 * Hand-rolled walker that flattens Atlassian Document Format (ADF) into
 * GFM-style markdown. The issue explicitly forbids @atlaskit dependencies.
 *
 * Scope: cover the node + mark types Jira Data Center actually emits for
 * issue descriptions and comments. Unknown nodes fall through to a
 * best-effort text extraction so we never lose user content silently.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

export function adfToMarkdown(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isAdfNode(input)) return "";
  return renderNode(input, { listDepth: 0 }).trimEnd();
}

interface RenderContext {
  listDepth: number;
}

function renderNode(node: AdfNode, ctx: RenderContext): string {
  switch (node.type) {
    case "doc":
      return renderBlocks(node.content ?? [], ctx);
    case "paragraph":
      return `${renderInline(node.content ?? [])}\n\n`;
    case "heading": {
      const level = clamp(getNumericAttr(node, "level", 1), 1, 6);
      return `${"#".repeat(level)} ${renderInline(node.content ?? [])}\n\n`;
    }
    case "blockquote":
      return prefixLines(renderBlocks(node.content ?? [], ctx).trimEnd(), "> ") + "\n\n";
    case "bulletList":
      return renderList(node, ctx, "bullet") + (ctx.listDepth === 0 ? "\n" : "");
    case "orderedList":
      return renderList(node, ctx, "ordered") + (ctx.listDepth === 0 ? "\n" : "");
    case "listItem":
      return renderBlocks(node.content ?? [], ctx).trimEnd();
    case "codeBlock": {
      const language =
        typeof node.attrs?.language === "string" ? (node.attrs.language as string) : "";
      const text = (node.content ?? []).map((c) => c.text ?? "").join("");
      return `\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
    case "rule":
      return `---\n\n`;
    case "panel":
      return prefixLines(renderBlocks(node.content ?? [], ctx).trimEnd(), "> ") + "\n\n";
    case "hardBreak":
      return "  \n";
    case "text":
      return applyMarks(node.text ?? "", node.marks ?? []);
    case "mention": {
      const text =
        typeof node.attrs?.text === "string"
          ? (node.attrs.text as string)
          : typeof node.attrs?.displayName === "string"
            ? (node.attrs.displayName as string)
            : "user";
      return `@${text}`;
    }
    case "emoji": {
      const shortName =
        typeof node.attrs?.shortName === "string" ? (node.attrs.shortName as string) : "";
      const text = typeof node.attrs?.text === "string" ? (node.attrs.text as string) : "";
      return text || shortName;
    }
    case "inlineCard":
    case "blockCard": {
      const url = typeof node.attrs?.url === "string" ? (node.attrs.url as string) : "";
      return url;
    }
    default:
      // Best-effort fallback: walk descendants and concatenate text.
      if (Array.isArray(node.content)) return renderBlocks(node.content, ctx);
      return "";
  }
}

function renderBlocks(nodes: AdfNode[], ctx: RenderContext): string {
  return nodes.map((n) => renderNode(n, ctx)).join("");
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map((n) => renderNode(n, { listDepth: 0 })).join("");
}

function renderList(node: AdfNode, ctx: RenderContext, kind: "bullet" | "ordered"): string {
  const items = node.content ?? [];
  const childCtx = { listDepth: ctx.listDepth + 1 };
  const indent = "  ".repeat(ctx.listDepth);
  return (
    items
      .map((item, index) => {
        const marker = kind === "bullet" ? "- " : `${index + 1}. `;
        const rendered = renderNode(item, childCtx);
        return `${indent}${marker}${indentContinuation(rendered, indent + "  ")}`;
      })
      .join("\n") + "\n"
  );
}

function applyMarks(text: string, marks: AdfMark[]): string {
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case "strong":
        out = `**${out}**`;
        break;
      case "em":
        out = `*${out}*`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "underline":
        out = `<u>${out}</u>`;
        break;
      case "link": {
        const href = typeof mark.attrs?.href === "string" ? (mark.attrs.href as string) : "";
        if (href.length > 0) out = `[${out}](${href})`;
        break;
      }
      default:
        // Unknown marks pass the text through unchanged.
        break;
    }
  }
  return out;
}

function prefixLines(input: string, prefix: string): string {
  if (input === "") return prefix.trimEnd();
  return input
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function indentContinuation(input: string, indent: string): string {
  const trimmed = input.replace(/\n+$/, "");
  const lines = trimmed.split("\n");
  if (lines.length <= 1) return trimmed;
  return [lines[0], ...lines.slice(1).map((line) => (line === "" ? "" : `${indent}${line}`))].join(
    "\n",
  );
}

function getNumericAttr(node: AdfNode, key: string, fallback: number): number {
  const value = node.attrs?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isAdfNode(input: unknown): input is AdfNode {
  return typeof input === "object" && input !== null && typeof (input as AdfNode).type === "string";
}
