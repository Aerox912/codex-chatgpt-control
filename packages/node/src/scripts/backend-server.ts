#!/usr/bin/env node

import { runBackendStdioServer } from "../backend/stdio-server.js";
import { detectPackagedBackendIdentity } from "../backend/runtime-identity.js";

const backendIdentity = await detectPackagedBackendIdentity(import.meta.url);

await runBackendStdioServer({
  input: process.stdin,
  output: process.stdout,
  error: process.stderr,
  backendIdentity
});
