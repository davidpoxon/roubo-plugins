# @roubo/plugin-ghe

Bundled Roubo integration plugin for GitHub Enterprise Server. Implements the
same `PluginContract` methods as `@roubo/plugin-github-com` but talks to a
user-supplied GHE instance URL with PAT authentication.

Configure the plugin per project with:

- `instance` (required): your GHE host, e.g. `https://ghe.acme.example`.
- `token` (required): a GHE personal access token. Stored in the OS keyring
  via `host.credentials.set`, never on disk in plaintext.
- `allowSelfSignedTls` (optional, default `false`): opt-in to accept
  self-signed TLS certificates. Enable only when your GHE instance uses a
  self-signed cert that the host machine cannot otherwise verify.

The plugin runs as a separate Node process under the host's JSON-RPC harness
and performs all network I/O through `host.fetch`. The manifest's
`network.hosts` allowlist is `**` because the instance URL is user-supplied.

Internally, the plugin uses `octokit` configured with `baseUrl:
"<instance>/api/v3"` and a fetch adapter that translates standard fetch calls
into `host.fetch` JSON-RPC requests. The `githubRequest` helper at
`src/github-request.ts` is a verbatim port from `plugins/github-com/`,
preserving the ETag short-circuit, primary + secondary rate-limit backoff, and
30s TTL caches (per FR-039, NFR-006).
