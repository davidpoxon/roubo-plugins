# Roubo Plugins Transparency Disclosures

## Architecture and security

The Roubo plugins are open-source software that runs entirely on the developer's local machine, inside the Roubo application that loads them. This repository contains their source. There is no Roubo-operated backend, database, log sink, telemetry pipeline, or hosted inference service behind these plugins.

- The plugins run as local processes under the user's own OS account.
- No code, repository content, issue or tracker data, or credential material is transmitted to any Roubo-controlled endpoint, because none exists.
- Full source is auditable at github.com/davidpoxon/roubo-plugins, and the host application at github.com/davidpoxon/roubo.

## What the plugins do

- **Integration plugins** (`@roubo/plugin-github-com`, `@roubo/plugin-ghe`, `@roubo/plugin-jira-self-hosted`) read and write issues and related metadata in an external tracker the user configures (GitHub.com, GitHub Enterprise Server, or self-hosted Jira). Each makes outbound HTTPS requests directly from the user's machine to the configured service, using a credential the host Roubo application manages. They request only the access needed to perform the actions the user initiates.
- **Component plugins** (`@roubo/plugin-process`, `@roubo/plugin-database`) supervise a long-running process or provision a docker-backed database for a bench, locally on the user's machine.

## Credential handling

The plugins do not store credentials themselves. Where a plugin needs a token or credential to reach an external service, that credential is provided and stored by the host Roubo application and handled as described in the [Roubo privacy policy](https://github.com/davidpoxon/roubo/blob/main/PRIVACY.md). Credentials are sent only in the authentication headers of HTTPS requests from the user's machine to the configured service.

## Risk management and safety

- Local-only execution: plugin processes, file writes, and any spawned components run under the user's OS account.
- Explicit user initiation: every action a plugin takes against an external service is initiated by the user, either explicitly or through a workflow they started inside Roubo. The plugins do not act autonomously on a schedule.
- Worktree isolation: component plugins operate within the bench (worktree) they are provisioned for.

## Data governance

Because no personal data is collected, transmitted, or stored by the Roubo project through these plugins, no controller-processor relationship arises under GDPR, CCPA, or analogous regimes. The user remains the sole controller of any data on their machine and of any data exchanged with the external services they configure (governed by those services' own policies).

## EU AI Act classification

The Roubo plugins are not AI systems within the meaning of Article 3 of the EU AI Act. They are integration and component connectors: they move issue data between Roubo and an external tracker, or provision and supervise local components. They perform no profiling, biometric identification, employment, education or law-enforcement decisioning, critical-infrastructure control, or any other use case listed in Annex III. They are therefore not "high-risk" under Article 6, and the obligations in Articles 8 to 17 do not apply.

## Compliance certifications

The Roubo project holds no formal third-party certifications (SOC 2, ISO 27001, HIPAA, FedRAMP, etc.) for these plugins, reflecting the architecture: there is no hosted service to certify. The full source is publicly auditable.

## Contact

Security or compliance questions: github.com/davidpoxon/roubo-plugins/issues
