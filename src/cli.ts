#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildServer } from "./server.js";

serveStdio(() => buildServer(), {
  legacy: "serve",
  onerror(error) {
    console.error(`[yandex-wordstat] ${error.name}: ${error.message}`);
  },
});
