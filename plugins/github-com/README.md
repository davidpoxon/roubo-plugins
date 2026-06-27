# @roubo/plugin-github-com

Bundled Roubo integration plugin for GitHub.com. Implements the read-only
`PluginContract` methods against the GitHub REST and GraphQL APIs.

The plugin runs as a separate Node process under the host's JSON-RPC harness
and performs all network I/O through `host.fetch`, so the manifest's
`network.hosts` allowlist (`api.github.com`) is enforced by the host.

Internally, the plugin uses `octokit` for REST and GraphQL access, configured
with a fetch adapter that translates standard fetch calls into `host.fetch`
JSON-RPC requests. That keeps the `githubRequest` helper at `src/github-request.ts`
byte-identical to its origin at `server/services/github.ts:255`, preserving
the ETag short-circuit, primary + secondary rate-limit backoff, and 30s TTL
caches without re-derivation (per FR-039, NFR-006).
