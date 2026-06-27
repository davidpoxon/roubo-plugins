import { definePlugin, host } from "@roubo/plugin-sdk";
import { bindHost } from "./host-binding.js";
import { addBlockedBy } from "./methods/add-blocked-by.js";
import { applyTransition } from "./methods/apply-transition.js";
import { assignIssue } from "./methods/assign-issue.js";
import { createIssue } from "./methods/create-issue.js";
import { filterFacets } from "./methods/filter-facets.js";
import { getAvailableTransitions } from "./methods/get-available-transitions.js";
import { getComments } from "./methods/get-comments.js";
import { getConnectionStatus } from "./methods/get-connection-status.js";
import { getCurrentUser } from "./methods/get-current-user.js";
import { getFacetOptions } from "./methods/get-facet-options.js";
import { getSortFields } from "./methods/get-sort-fields.js";
import { getIssue } from "./methods/get-issue.js";
import { listIssueTypes } from "./methods/list-issue-types.js";
import { listIssues } from "./methods/list-issues.js";
import { listLabels } from "./methods/list-labels.js";
import { listSourceCandidates } from "./methods/list-source-candidates.js";
import { probeAlertCategories } from "./methods/probe-alert-categories.js";
import { probeRepoAccess } from "./methods/probe-repo-access.js";
import { setActiveConfigMethod } from "./methods/set-active-config.js";
import { unassignIssue } from "./methods/unassign-issue.js";
import { validateConfig } from "./methods/validate-config.js";

bindHost(host);

definePlugin({
  listSourceCandidates,
  listIssues,
  getIssue,
  getComments,
  getCurrentUser,
  validateConfig,
  applyTransition,
  createIssue,
  addBlockedBy,
  assignIssue,
  unassignIssue,
  getAvailableTransitions,
  listIssueTypes,
  listLabels,
  filterFacets,
  getFacetOptions,
  getSortFields,
  getConnectionStatus,
  probeAlertCategories,
  probeRepoAccess,
  setActiveConfig: setActiveConfigMethod,
});
