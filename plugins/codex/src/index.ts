import { defineAgentPlugin } from "@roubo/plugin-sdk";
import { translateLaunch } from "./translate-launch.js";

// Declarative agent plugin (AP-FR-017): it registers only `translateLaunch`,
// which emits an AgentLaunchDescriptor. The host validates that descriptor and
// owns the PTY spawn, so the plugin spawns nothing itself and holds no privilege
// beyond an integration plugin's (AP-NFR-001, `permissions.processes: false`).
// Every Codex-native identifier (`--model`, `model_reasoning_effort`,
// `approval_policy`, `sandbox_mode`, `notify`) lives inside the argv strings this
// plugin produces, so no Codex-specific code lands in core (AP-FR-020).
defineAgentPlugin({
  translateLaunch,
});
