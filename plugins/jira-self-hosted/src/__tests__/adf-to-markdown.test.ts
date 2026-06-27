import { describe, expect, it } from "vitest";
import { adfToMarkdown, type AdfNode } from "../adf-to-markdown.js";

function doc(...content: AdfNode[]): AdfNode {
  return { type: "doc", content };
}

describe("adfToMarkdown", () => {
  it("renders a plain paragraph", () => {
    expect(
      adfToMarkdown(doc({ type: "paragraph", content: [{ type: "text", text: "hello world" }] })),
    ).toBe("hello world");
  });

  it("renders headings with the correct hash count", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Section" }],
        }),
      ),
    ).toBe("### Section");
  });

  it("renders bullet and ordered lists", () => {
    const md = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "second" }] }],
          },
        ],
      }),
    );
    expect(md).toBe("- first\n- second");
  });

  it("renders codeBlock with a language fence", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        }),
      ),
    ).toBe("```ts\nconst x = 1;\n```");
  });

  it("applies strong, em, code, and link marks", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "ital", marks: [{ type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        }),
      ),
    ).toBe("**bold** *ital* `code` [link](https://example.com)");
  });

  it("emits a horizontal rule and blockquote", () => {
    const md = adfToMarkdown(
      doc(
        { type: "rule" },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
        },
      ),
    );
    expect(md).toContain("---");
    expect(md).toContain("> quoted");
  });

  it("inlines mention and emoji nodes", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            { type: "mention", attrs: { displayName: "Anna" } },
            { type: "text", text: " " },
            { type: "emoji", attrs: { shortName: ":smile:", text: ":)" } },
          ],
        }),
      ),
    ).toBe("@Anna :)");
  });

  it("falls back to descendant text for unknown nodes", () => {
    expect(
      adfToMarkdown({
        type: "doc",
        content: [
          {
            type: "futureUnknown",
            content: [{ type: "paragraph", content: [{ type: "text", text: "still readable" }] }],
          },
        ],
      }),
    ).toBe("still readable");
  });

  it("returns empty string for non-ADF input", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown(42)).toBe("");
  });

  it("passes through legacy wiki-markup style strings", () => {
    expect(adfToMarkdown("# legacy heading")).toBe("# legacy heading");
  });
});
