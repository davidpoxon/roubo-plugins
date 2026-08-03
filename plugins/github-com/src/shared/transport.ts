import type { FetchInit, FetchResult } from "@roubo/plugin-sdk";

// Matches HostClient["fetch"] from @roubo/plugin-sdk. Accepting a transport
// function (rather than the full HostClient) keeps these helpers usable with
// any wrapper that conforms to host.fetch, including the per-plugin host-fetch
// adapter that injects auth/TLS settings.
export type FetchTransport = (url: string, init?: FetchInit) => Promise<FetchResult>;
