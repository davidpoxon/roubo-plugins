# @roubo/plugin-jira-self-hosted

Bundled Roubo integration plugin for self-hosted Atlassian Jira (Data Center 8.14+).

## What it does

- Lists boards, epics, and favourite filters via a `categorized-multi-list` source picker.
- Polls issues incrementally with JQL `updated >= "<last-poll-ts>"`, keyed off a per-source timestamp the plugin persists itself.
- Maps Jira `blocks` / `is blocked by` link types (or any user-configured rename) onto `NormalizedIssue.blocks` / `blockedBy`.
- Flattens Atlassian Document Format (ADF) issue bodies and comments to readable markdown via a hand-rolled walker (no `@atlaskit` dependencies).
- Writes back state transitions via `POST /rest/api/2/issue/<key>/transitions` and assignment via `PUT /rest/api/2/issue/<key>/assignee`.

## Configuration

In Roubo's Plugins settings, configure:

| Field                       | Required | Default         | Notes                                                                                                                                                                                                   |
| --------------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`                  | yes      |                 | e.g. `https://jira.acme.example`. The plugin only ever calls this host.                                                                                                                                 |
| Personal access token (PAT) | yes      |                 | Stored in the OS keyring under the plugin's `pat` credential slot. Token must be a Data Center PAT (8.14+).                                                                                             |
| `blocksLinkTypeName`        | no       | `blocks`        | Override if your Jira admin renamed the default.                                                                                                                                                        |
| `isBlockedByLinkTypeName`   | no       | `is blocked by` | Override if your Jira admin renamed the default.                                                                                                                                                        |
| `allowSelfSignedTls`        | no       | `false`         | Trust self-signed / internal-CA certificates for this instance. Disables certificate verification for every request to the instance, so only enable it for an on-prem Jira whose certificate you trust. |

Click **Test connection** in the Configure dialog to verify the PAT against `GET /rest/api/2/myself`.

## Troubleshooting

- **"Token lacks transition permission"** on the transition dropdown means the PAT's user doesn't have the workflow transition permission. Ask your Jira admin.
- **"Not found" on board/filter listing** usually means the PAT doesn't have view access to the agile API. The board picker calls `/rest/agile/1.0/board`.
- **Self-signed TLS errors** mean the instance presents a certificate Roubo cannot verify against the system trust store. Enable **Allow self-signed TLS** in the Configure dialog (or click "Enable self-signed TLS and retry" on the failed connection test) to trust it. Only do this for an instance whose certificate you trust.
