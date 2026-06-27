import type { CurrentUser } from "@roubo/plugin-sdk";
import { fetchCurrentUser } from "../github-fetchers.js";

export async function getCurrentUser(): Promise<CurrentUser> {
  const user = await fetchCurrentUser();
  return {
    externalId: user.login,
    displayName: user.name && user.name.length > 0 ? user.name : user.login,
  };
}
