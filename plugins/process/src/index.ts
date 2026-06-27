import { defineComponentPlugin } from "@roubo/plugin-sdk";
import { translate } from "./translate.js";

// Declarative component plugin (AC5): it registers only `translate`, which emits
// a `process` ProvisionDescriptor. The host LifecycleEngine executes it; the
// plugin never drives the host process broker and so spawns nothing itself.
defineComponentPlugin({
  translate,
});
