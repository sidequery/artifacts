import { definePlugins } from "../../plugins/config";

export default definePlugins([
  { name: "@test/counter", description: "Compiler integration counter", browser: "./browser.tsx" },
]);
