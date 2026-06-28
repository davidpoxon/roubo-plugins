import { describe, expect, it } from "vitest";
import { adfToMarkdown, type AdfNode } from "../adf-to-markdown.js";

function doc(...content: AdfNode[]): AdfNode {
  return { type: "doc", content };
}

describe("adfToMarkdown node-type branches", () => {
  it("renders an empty doc and an empty paragraph as the empty string", () => {
    expect(adfToMarkdown({ type: "doc" })).toBe("");
    expect(adfToMarkdown(doc({ type: "paragraph" }))).toBe("");
  });

  it("clamps heading levels and defaults a missing level to 1", () => {
    expect(adfToMarkdown(doc({ type: "heading", content: [{ type: "text", text: "H" }] }))).toBe(
      "# H",
    );
    expect(
      adfToMarkdown(
        doc({ type: "heading", attrs: { level: 99 }, content: [{ type: "text", text: "H" }] }),
      ),
    ).toBe("###### H");
    expect(
      adfToMarkdown(
        doc({ type: "heading", attrs: { level: "nope" }, content: [{ type: "text", text: "H" }] }),
      ),
    ).toBe("# H");
  });

  it("renders a codeBlock with no language and no content", () => {
    expect(adfToMarkdown(doc({ type: "codeBlock", content: [{ type: "text", text: "x" }] }))).toBe(
      "```\nx\n```",
    );
    expect(adfToMarkdown(doc({ type: "codeBlock" }))).toBe("```\n\n```");
  });

  it("renders panel and hardBreak nodes", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "panel",
          content: [{ type: "paragraph", content: [{ type: "text", text: "note" }] }],
        }),
      ),
    ).toBe("> note");
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "text", text: "b" },
          ],
        }),
      ),
    ).toBe("a  \nb");
  });

  it("prefixes an empty blockquote down to the bare marker", () => {
    expect(adfToMarkdown(doc({ type: "blockquote" }))).toBe(">");
  });

  it("renders ordered lists and nested lists with indentation", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        }),
      ),
    ).toBe("1. one\n2. two");

    const nested = adfToMarkdown(
      doc({
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "outer" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(nested).toContain("- outer");
    expect(nested).toContain("inner");
  });

  it("resolves mention text/displayName/fallback and emoji variants", () => {
    expect(
      adfToMarkdown(
        doc({ type: "paragraph", content: [{ type: "mention", attrs: { text: "bob" } }] }),
      ),
    ).toBe("@bob");
    expect(adfToMarkdown(doc({ type: "paragraph", content: [{ type: "mention" }] }))).toBe("@user");
    expect(
      adfToMarkdown(
        doc({ type: "paragraph", content: [{ type: "emoji", attrs: { text: ":)" } }] }),
      ),
    ).toBe(":)");
    expect(
      adfToMarkdown(
        doc({ type: "paragraph", content: [{ type: "emoji", attrs: { shortName: ":smile:" } }] }),
      ),
    ).toBe(":smile:");
    expect(adfToMarkdown(doc({ type: "paragraph", content: [{ type: "emoji" }] }))).toBe("");
  });

  it("renders inlineCard and blockCard urls, empty when absent", () => {
    expect(
      adfToMarkdown(
        doc({
          type: "paragraph",
          content: [{ type: "inlineCard", attrs: { url: "https://x.test" } }],
        }),
      ),
    ).toBe("https://x.test");
    expect(adfToMarkdown(doc({ type: "blockCard" }))).toBe("");
  });
});

describe("adfToMarkdown mark branches", () => {
  function marked(text: string, type: string, attrs?: Record<string, unknown>): string {
    return adfToMarkdown(
      doc({ type: "paragraph", content: [{ type: "text", text, marks: [{ type, attrs }] }] }),
    );
  }

  it("applies strike and underline marks", () => {
    expect(marked("x", "strike")).toBe("~~x~~");
    expect(marked("x", "underline")).toBe("<u>x</u>");
  });

  it("leaves text unchanged for a link without an href and for unknown marks", () => {
    expect(marked("x", "link")).toBe("x");
    expect(marked("x", "link", { href: "" })).toBe("x");
    expect(marked("x", "textColor")).toBe("x");
  });

  it("renders bare text nodes with no marks or text", () => {
    expect(adfToMarkdown(doc({ type: "paragraph", content: [{ type: "text" }] }))).toBe("");
  });
});
