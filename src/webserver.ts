import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createCollabHttpHandler, type CollabHttpOptions } from "./http.js";
import { COLLAB_STREAM_PATH, CollabStreamUpgrade } from "./upgrade.js";

export interface CollabWebServer {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): () => void;
  registerUpgrade(route: {
    path: string;
    handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
  }): () => void;
}

export interface RegisterCollabRoutesOptions {
  webServer: CollabWebServer;
  http: CollabHttpOptions;
  upgrade: CollabStreamUpgrade;
}

export function registerCollabRoutes(options: RegisterCollabRoutesOptions): () => void {
  const disposeHttp = options.webServer.register({
    kind: "prefix",
    path: "/collab",
    handler: createCollabHttpHandler(options.http),
  });
  try {
    const disposeUpgrade = options.webServer.registerUpgrade({
      path: COLLAB_STREAM_PATH,
      handler: options.upgrade.handleUpgrade,
    });
    return () => {
      disposeUpgrade();
      disposeHttp();
    };
  } catch (error) {
    disposeHttp();
    throw error;
  }
}
