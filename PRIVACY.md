# Privacy Policy

**Last updated: June 27, 2026**

This Privacy Policy describes how the plugins in this repository (the "Roubo plugins") handle your information.

## Summary

The Roubo plugins run entirely on your computer, inside the Roubo application that loads them. This repository contains their source code. The plugins have no servers, no hosted backend, no analytics, no crash reporting, and no telemetry of their own. The Roubo project does not collect, store, transmit, or have access to any of your data through these plugins.

## Who this policy covers

This policy applies to the integration and component plugins whose source lives in this repository. Throughout this document, "the Roubo project" refers to the maintainers of the open source repositories at [github.com/davidpoxon/roubo](https://github.com/davidpoxon/roubo) and [github.com/davidpoxon/roubo-plugins](https://github.com/davidpoxon/roubo-plugins), and "you" refers to the person running Roubo with these plugins installed.

The Roubo desktop application that hosts these plugins, and the "Roubo for Github" OAuth App it uses, are covered by the [Roubo privacy policy](https://github.com/davidpoxon/roubo/blob/main/PRIVACY.md). Where a plugin relies on a credential or token, that credential is managed by the host application and handled as described there.

## What the plugins are

The plugins are loaded and run by the Roubo application as local processes on your own machine. There are two kinds:

- **Integration plugins** (`@roubo/plugin-github-com`, `@roubo/plugin-ghe`, `@roubo/plugin-jira-self-hosted`) let Roubo read and write issues and related metadata in an external tracker you configure: GitHub.com, a GitHub Enterprise Server instance, or a self-hosted Jira instance.
- **Component plugins** (`@roubo/plugin-process`, `@roubo/plugin-database`) provision and supervise local components for a bench: a long-running process, or a docker-backed database.

## Information the plugins collect

The plugins collect no information.

There is no Roubo-operated server, database, log sink, analytics provider, or error tracker that receives data from these plugins. The Roubo project has no way to read your code, your repositories, your issues, your credentials, or any other data through them.

## How integration plugins use the network

When you use an integration plugin, it communicates **directly from your machine** to the external service you have configured (for example `api.github.com`, your GitHub Enterprise Server host, or your Jira host), over HTTPS, using a credential supplied by the host Roubo application. It sends only what is needed to perform the action you initiated, such as reading or updating an issue or pull request. Every request is initiated by you, either explicitly or through a workflow you started inside Roubo, and goes directly from your machine to that service. The Roubo project never sees these requests or their responses.

Your interactions with a third-party service are governed by that service's own privacy policy and terms (for example [GitHub's Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) or Atlassian's privacy policy for Jira). The plugins share data with no other third party, because there is no Roubo infrastructure from which they could.

## How component plugins use the network

The component plugins manage local components on your machine (a supervised process, or a docker-backed database). They do not transmit your data to the Roubo project or to any third party.

## Children's privacy

The Roubo plugins are developer tooling and are not directed to children under 13. Because the plugins collect no information of any kind, no children's data is collected.

## Changes to this policy

If this policy changes in a way that affects what data the plugins touch or how it is handled, the "Last updated" date at the top of this document will be revised and the change will be noted in the project's release notes.

## Contact

For any questions about this Privacy Policy, please open an issue at [github.com/davidpoxon/roubo-plugins/issues](https://github.com/davidpoxon/roubo-plugins/issues).
