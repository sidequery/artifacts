import { definePlugins } from "../../src/plugins/config";
import { runnerStatusPlugin } from "./plugin";

export default definePlugins([
  runnerStatusPlugin({
    // Use exact authenticated Canvas identities (subject AND authority).
    // Empty is intentionally deny-all; fill this before deploying the sample.
    allowedUsers: [],
  }),
]);
