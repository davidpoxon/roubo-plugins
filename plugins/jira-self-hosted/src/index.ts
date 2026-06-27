import { definePlugin } from "@roubo/plugin-sdk";
import { createPluginContract } from "./plugin.js";

definePlugin(createPluginContract());
