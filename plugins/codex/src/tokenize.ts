/**
 * Split the free-form "Additional CLI arguments" field into discrete argv
 * tokens (AP-FR-017, AP-TC-088).
 *
 * A copy of the Claude Code plugin's tokenizer, deliberately duplicated rather
 * than shared: `plugins/_shared-github` is the only shared workspace and it is
 * GitHub-specific, so a new shared library for one 80-line pure function would
 * add a build-chain entry and a publish surface for no gain. If a third agent
 * plugin needs it, extract it then.
 *
 * This is a deliberately *literal* splitter, not a shell. It honours the two
 * quoting forms and the backslash escape so a user can pass an argument that
 * contains spaces, and it treats every other character as an ordinary literal.
 * In particular `;`, `&`, `|`, `>`, `<`, `$`, `(`, `)` and backticks carry no
 * meaning here: there is no command separation, no variable expansion, and no
 * command substitution (AP-TC-089, AP-NFR-001). The host spawns the descriptor's
 * `args` as an argv array and never through a shell, so a token such as
 * `$(whoami)` reaches the agent CLI as those exact nine characters.
 *
 * Rules:
 *
 * - Runs of unquoted whitespace separate tokens; leading and trailing
 *   whitespace is discarded, so an empty or whitespace-only field yields `[]`
 *   and appends nothing (AP-TC-091).
 * - `'...'` is a literal run: nothing inside it is special, not even backslash.
 * - `"..."` is a literal run in which `\"` yields a quote and `\\` yields a
 *   backslash; any other backslash stays a literal backslash.
 * - An unquoted `\` escapes the next character (including a space or a quote).
 * - Quotes are removed, so `"$(whoami)"` tokenizes to `$(whoami)`.
 * - An empty quoted run is a real token: `--flag ""` yields two tokens.
 *
 * An unbalanced quote is rejected with a clear error rather than being guessed
 * at, so a malformed field surfaces at launch instead of silently producing a
 * token the user never wrote.
 */
export function tokenize(extraArgs: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  for (let i = 0; i < extraArgs.length; i += 1) {
    const char = extraArgs[i];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      flush();
      continue;
    }

    if (char === "\\") {
      const next = extraArgs[i + 1];
      if (next === undefined) {
        throw new Error(
          "codex agent plugin: the additional CLI arguments end with a dangling backslash escape.",
        );
      }
      current += next;
      started = true;
      i += 1;
      continue;
    }

    if (char === "'") {
      const end = extraArgs.indexOf("'", i + 1);
      if (end === -1) throw unbalanced("'");
      current += extraArgs.slice(i + 1, end);
      started = true;
      i = end;
      continue;
    }

    if (char === '"') {
      started = true;
      let j = i + 1;
      let closed = false;
      for (; j < extraArgs.length; j += 1) {
        const inner = extraArgs[j];
        if (inner === "\\") {
          const next = extraArgs[j + 1];
          // Inside double quotes a backslash only escapes a quote or another
          // backslash; before anything else (including `$`) it stays literal,
          // because nothing else is interpreted here in the first place.
          if (next === '"' || next === "\\") {
            current += next;
            j += 1;
          } else {
            current += inner;
          }
          continue;
        }
        if (inner === '"') {
          closed = true;
          break;
        }
        current += inner;
      }
      if (!closed) throw unbalanced('"');
      i = j;
      continue;
    }

    current += char;
    started = true;
  }

  flush();
  return tokens;
}

function unbalanced(quote: string): Error {
  return new Error(
    `codex agent plugin: the additional CLI arguments contain an unbalanced ${quote === "'" ? "single" : "double"} quote.`,
  );
}
