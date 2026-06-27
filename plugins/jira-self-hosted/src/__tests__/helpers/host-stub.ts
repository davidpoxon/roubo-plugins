import { PassThrough } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { definePlugin } from "@roubo/plugin-sdk";
import type { FetchInit, FetchResult, PluginContract, PluginHandle } from "@roubo/plugin-sdk";

/**
 * Wires the SDK's `host` singleton to an in-memory JSON-RPC peer so
 * helper code that calls `host.fetch` / `host.credentials.*` resolves
 * against a test-controlled handler instead of `process.stdin`.
 *
 * Returns a `restore` callback for `afterEach` cleanup.
 */
export interface HostHarness {
  fetchStub: FetchStub;
  credentials: InMemoryCredentialStore;
  /**
   * The host-side JSON-RPC connection. Tests that drive the plugin
   * contract (TC-048 end-to-end) use `hostConnection.sendRequest("methodName", params)`
   * to call a contract method as the real host would.
   */
  hostConnection: MessageConnection;
  dispose(): void;
}

export function installHostHarness(contract: PluginContract = {}): HostHarness {
  const fetchStub = new FetchStub();
  const credentials = new InMemoryCredentialStore();

  const hostToPlugin = new PassThrough();
  const pluginToHost = new PassThrough();

  const hostReader = new StreamMessageReader(pluginToHost);
  const hostWriter = new StreamMessageWriter(hostToPlugin);
  const hostConnection: MessageConnection = createMessageConnection(hostReader, hostWriter);

  hostConnection.onRequest(
    "host.fetch",
    async (params: { url: string; init?: FetchInit }): Promise<FetchResult> => {
      return fetchStub.invoke(params.url, params.init);
    },
  );
  hostConnection.onRequest(
    "host.credentials.get",
    async (params: { slot: string }): Promise<string | null> => {
      return credentials.get(params.slot);
    },
  );
  hostConnection.onRequest(
    "host.credentials.set",
    async (params: { slot: string; value: string }): Promise<null> => {
      credentials.set(params.slot, params.value);
      return null;
    },
  );
  hostConnection.onNotification("host.logger.info", () => {});
  hostConnection.onNotification("host.logger.warn", () => {});
  hostConnection.onNotification("host.logger.error", () => {});

  hostConnection.listen();

  const handle: PluginHandle = definePlugin(contract, {
    streams: { input: hostToPlugin, output: pluginToHost },
  });

  return {
    fetchStub,
    credentials,
    hostConnection,
    dispose() {
      try {
        handle.dispose();
      } catch {
        /* ignore */
      }
      try {
        hostConnection.dispose();
      } catch {
        /* ignore */
      }
    },
  };
}

export type FetchHandler = (init: FetchInit, url: string) => unknown | Promise<unknown>;

export class FetchStub {
  private handlers: Array<{ match: (path: string) => boolean; handler: FetchHandler }> = [];

  on(path: string | RegExp | ((p: string) => boolean), handler: FetchHandler): this {
    let match: (p: string) => boolean;
    if (typeof path === "string") match = (p) => p.startsWith(path);
    else if (path instanceof RegExp) match = (p) => path.test(p);
    else match = path;
    this.handlers.push({ match, handler });
    return this;
  }

  async invoke(url: string, init?: FetchInit): Promise<FetchResult> {
    const parsed = new URL(url);
    const target = `${parsed.pathname}${parsed.search}`;
    for (const { match, handler } of this.handlers) {
      if (match(target)) {
        const value = await handler(init ?? {}, url);
        if (value instanceof StubResponse) {
          return {
            status: value.status,
            headers: { "content-type": "application/json" },
            body: value.body,
          };
        }
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: typeof value === "string" ? value : JSON.stringify(value ?? null),
        };
      }
    }
    throw new Error(`FetchStub: no handler for ${target}`);
  }
}

export class StubResponse {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {}
  static jiraError(status: number, message: string): StubResponse {
    return new StubResponse(status, JSON.stringify({ errorMessages: [message] }));
  }
}

export class InMemoryCredentialStore {
  private store = new Map<string, string>();
  set(slot: string, value: string): void {
    this.store.set(slot, value);
  }
  get(slot: string): string | null {
    return this.store.has(slot) ? (this.store.get(slot) ?? null) : null;
  }
  seed(initial: Record<string, string>): void {
    for (const [k, v] of Object.entries(initial)) this.store.set(k, v);
  }
}
