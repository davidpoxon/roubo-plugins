import { describe, expect, it } from "vitest";
import { tokenize } from "./tokenize.js";

describe("claude-code extra-args tokenizer (AP-FR-017)", () => {
  it("splits a plain argument string into discrete argv tokens (AP-TC-088)", () => {
    expect(tokenize("--fallback-model sonnet --verbose")).toEqual([
      "--fallback-model",
      "sonnet",
      "--verbose",
    ]);
  });

  it("collapses runs of whitespace and trims the edges (AP-TC-088)", () => {
    expect(tokenize("  --a \t\t --b \n --c  ")).toEqual(["--a", "--b", "--c"]);
  });

  it("returns no tokens for an empty or whitespace-only field (AP-TC-091)", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \t \n ")).toEqual([]);
  });

  it("keeps a double-quoted run together as one token and strips the quotes (AP-TC-088)", () => {
    expect(tokenize('--append-system-prompt "be terse and precise"')).toEqual([
      "--append-system-prompt",
      "be terse and precise",
    ]);
  });

  it("keeps a single-quoted run together and treats its contents as fully literal (AP-TC-089)", () => {
    expect(tokenize("--x 'a \\n $HOME b'")).toEqual(["--x", "a \\n $HOME b"]);
  });

  it("joins quoted and unquoted runs that touch into a single token (AP-TC-088)", () => {
    expect(tokenize('--prompt="two words"')).toEqual(["--prompt=two words"]);
  });

  it("treats an empty quoted run as a real token (AP-TC-088)", () => {
    expect(tokenize('--flag ""')).toEqual(["--flag", ""]);
    expect(tokenize("--flag ''")).toEqual(["--flag", ""]);
  });

  it("honours an unquoted backslash escape, including before a space (AP-TC-088)", () => {
    expect(tokenize("a\\ b c")).toEqual(["a b", "c"]);
    expect(tokenize('\\"quoted\\"')).toEqual(['"quoted"']);
  });

  it("unescapes only a quote or a backslash inside double quotes (AP-TC-089)", () => {
    expect(tokenize('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(tokenize('"a\\\\b"')).toEqual(["a\\b"]);
    expect(tokenize('"a\\nb"')).toEqual(["a\\nb"]);
    expect(tokenize('"literal \\$HOME"')).toEqual(["literal \\$HOME"]);
  });

  it("never interprets shell metacharacters: the AP-TC-089 payload stays literal", () => {
    // The whole point of AP-TC-089: `;` starts no second command, `$HOME` is not
    // expanded, and `$(whoami)` is not substituted. Every character survives.
    expect(tokenize('--foo; rm -rf $HOME "$(whoami)"')).toEqual([
      "--foo;",
      "rm",
      "-rf",
      "$HOME",
      "$(whoami)",
    ]);
  });

  it("passes every other shell operator through as an ordinary literal (AP-TC-089)", () => {
    expect(tokenize("a|b c>d e&&f `whoami` <g >>h")).toEqual([
      "a|b",
      "c>d",
      "e&&f",
      "`whoami`",
      "<g",
      ">>h",
    ]);
  });

  it("rejects an unbalanced double quote with a clear error (AP-TC-089)", () => {
    expect(() => tokenize('--x "unterminated')).toThrow(/unbalanced double quote/);
  });

  it("rejects an unbalanced single quote with a clear error (AP-TC-089)", () => {
    expect(() => tokenize("--x 'unterminated")).toThrow(/unbalanced single quote/);
  });

  it("rejects a dangling trailing backslash with a clear error (AP-TC-089)", () => {
    expect(() => tokenize("--x \\")).toThrow(/dangling backslash/);
  });
});
