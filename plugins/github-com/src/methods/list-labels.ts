import type { ListLabelsParams } from "@roubo/plugin-sdk";
import { requirePrimarySource } from "../sources.js";
import { fetchLabels } from "../github-fetchers.js";

export async function listLabels(params: ListLabelsParams): Promise<string[]> {
  // Labels cover the primary source only; multi-source (submodule) facet
  // coverage tracked in #369.
  const source = requirePrimarySource(params.sources);
  if (source.kind !== "repo") return [];
  return fetchLabels(source.externalId);
}
