/**
 * Map Jira issue-links to NormalizedIssue.blocks / blockedBy per FR-025.
 *
 * Jira models a blocking relationship as a single link type ("Blocks" by
 * default) carrying two directional descriptions: `outward` ("blocks") and
 * `inward` ("is blocked by"). The link's `name` is the type name, not a
 * direction. We identify the blocks-family link type by matching the
 * configured names against the link's directional descriptions (with the
 * type name as a tolerant fallback), then let the link direction decide
 * the kind: an `outwardIssue` means this issue blocks it; an `inwardIssue`
 * means this issue is blocked by it.
 *
 * Both names are configurable per project to accommodate Jira instances
 * that have renamed the default link type (TC-072). Every other link type
 * is intentionally ignored.
 */

import type { JiraPluginConfig } from "./config.js";

export interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string };
  outwardIssue?: { key?: string };
  inwardIssue?: { key?: string };
}

export interface MappedLink {
  kind: "blocks" | "blockedBy";
  externalId: string;
}

function eq(a: string | undefined, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b;
}

export function mapLinkType(config: JiraPluginConfig, link: JiraIssueLink): MappedLink | null {
  const blocksName = config.blocksLinkTypeName.trim().toLowerCase();
  const isBlockedByName = config.isBlockedByLinkTypeName.trim().toLowerCase();
  const type = link.type ?? {};

  const isBlockFamily =
    eq(type.outward, blocksName) ||
    eq(type.inward, isBlockedByName) ||
    eq(type.name, blocksName) ||
    eq(type.name, isBlockedByName);
  if (!isBlockFamily) return null;

  const outward = link.outwardIssue?.key;
  if (outward) return { kind: "blocks", externalId: outward };

  const inward = link.inwardIssue?.key;
  if (inward) return { kind: "blockedBy", externalId: inward };

  return null;
}
