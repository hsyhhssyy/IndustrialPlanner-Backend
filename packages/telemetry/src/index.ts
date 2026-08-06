// Telemetry Worker 入口 — 组合根

import { createApp, type TelemetryEnv } from "./http";
import { withCors, ANONYMOUS_CORS_HEADERS } from "@industrial/shared";

const app = createApp();

export default {
  fetch: async (request: Request, env: TelemetryEnv) => {
    const response = await app.fetch(request, env);
    return withCors(response, ANONYMOUS_CORS_HEADERS);
  },
};
