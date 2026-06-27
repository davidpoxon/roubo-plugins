import type { HostClient } from "@roubo/plugin-sdk";

let bound: HostClient | null = null;

export function bindHost(host: HostClient): void {
  bound = host;
}

export function getHost(): HostClient {
  if (!bound) {
    throw new Error(
      "[github-com] host not bound. Call bindHost() once at plugin startup (or in tests).",
    );
  }
  return bound;
}

export function resetHostBinding(): void {
  bound = null;
}
