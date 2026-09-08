import { definePlugins } from "../../src/plugins/config";
import { runnerStatusPlugin } from "./plugin";

// The bundled collector shares this local celld process. Its endpoint still
// requires a private bearer token; browsers access it through the plugin bridge.
export default definePlugins([
  runnerStatusPlugin({ allowedUsers: [{ subject: "local", authority: "local" }], allowLoopback: true }),
]);
