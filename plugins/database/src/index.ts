import { defineComponentPlugin } from "@roubo/plugin-sdk";
import { translate } from "./translate.js";

// Declarative component plugin (AC6): it registers only `translate`, which emits
// a `docker` ProvisionDescriptor. The host LifecycleEngine executes it (the full
// compose phase machine via the host-RPC broker); the plugin never drives docker
// directly and so starts no container itself.
defineComponentPlugin({
  translate,
});
