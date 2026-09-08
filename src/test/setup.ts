import { setDefaultTimeout } from "bun:test";

// Artifact checks invoke the real TypeScript compiler and can exceed Bun's 5s default.
setDefaultTimeout(30_000);
