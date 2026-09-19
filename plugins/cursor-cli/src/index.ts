import { defineAgentPlugin } from "@roubo/plugin-sdk";
import { translateLaunch } from "./translate-launch.js";

// Declarative agent plugin (APCC-FR-008): it registers only `translateLaunch`,
// which emits an AgentLaunchDescriptor. The host validates that descriptor and
// owns the PTY spawn, so the plugin spawns nothing itself and registers no host
// client (APCC-NFR-001, `permissions.processes: false`). Every Cursor-native
// identifier lives inside the argv strings this plugin produces, so no
// Cursor-specific code lands in core.
defineAgentPlugin({
  translateLaunch,
});
