import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { invalidInput } from "./errors.js";

export interface LocalNginxProxyOptions {
  targetHost?: string;
  targetPort: number;
  collabTargetHost?: string;
  collabTargetPort?: number;
  listenHost?: string;
  listenPort: number;
  principalId: string;
  trustedProxyMarkerHeader?: string;
  trustedPrincipalHeader?: string;
  runtimeDir?: string;
}

export interface LocalNginxProxy {
  readonly executablePath: string;
  readonly runtimeDir: string;
  readonly configPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

function port(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw invalidInput(field + " must be between 1 and 65535", { field, value });
  return value;
}

function header(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(candidate)) throw invalidInput("nginx header name is invalid", { header: candidate });
  return candidate;
}

function quoted(value: string): string {
  return value.replace(/[\\"]/g, (character) => "\\" + character);
}

export function bundledNginxExecutable(): string {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("dsh-collab bundled nginx currently supports Windows x64 only");
  return fileURLToPath(new URL("../vendor/nginx/windows-x64/nginx.exe", import.meta.url));
}

export function renderLocalNginxConfig(options: LocalNginxProxyOptions): string {
  const targetHost = (options.targetHost ?? "127.0.0.1").trim();
  const collabTargetHost = (options.collabTargetHost ?? targetHost).trim();
  const listenHost = (options.listenHost ?? "127.0.0.1").trim();
  const principalHeader = header(options.trustedPrincipalHeader, "x-authenticated-user");
  const markerHeader = header(options.trustedProxyMarkerHeader, "x-dsh-proxy");
  const targetPort = port(options.targetPort, "targetPort");
  const collabTargetPort = port(options.collabTargetPort ?? targetPort, "collabTargetPort");
  const listenPort = port(options.listenPort, "listenPort");
  if (targetHost === "" || listenHost === "") throw invalidInput("nginx hosts must not be blank");
  if (collabTargetHost === "") throw invalidInput("nginx hosts must not be blank");
  if (options.principalId.trim() === "") throw invalidInput("principalId must not be blank");

  return `worker_processes 1;
error_log logs/error.log notice;
pid logs/nginx.pid;

events {
    worker_connections 128;
}

http {
    client_body_temp_path temp/client_body;
    proxy_temp_path temp/proxy;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    map $http_origin $dsh_collab_cors_origin {
        default "";
        "http://${targetHost}:${String(targetPort)}" $http_origin;
    }

    upstream dsh_browser_target {
        server ${targetHost}:${String(targetPort)};
    }

    upstream dsh_collab_target {
        server ${collabTargetHost}:${String(collabTargetPort)};
    }

    server {
        listen ${listenHost}:${String(listenPort)};
        server_name _;

        location ^~ /collab/ {
            if ($request_method = OPTIONS) {
                add_header Access-Control-Allow-Origin $dsh_collab_cors_origin always;
                add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
                add_header Access-Control-Allow-Headers "Accept, Authorization, Content-Type" always;
                add_header Access-Control-Max-Age 86400 always;
                add_header Vary Origin always;
                add_header Content-Length 0;
                return 204;
            }

            proxy_bind 127.0.0.2;
            proxy_pass http://dsh_collab_target;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-DSH-Principal-Id "";
            proxy_set_header ${principalHeader} "${quoted(options.principalId)}";
            proxy_set_header ${markerHeader} "1";
            proxy_read_timeout 1h;
            proxy_buffering off;
            add_header Access-Control-Allow-Origin $dsh_collab_cors_origin always;
            add_header Vary Origin always;
        }

        location / {
            proxy_pass http://dsh_browser_target;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
        }
    }
}
`;
}

async function waitForPort(host: string, portNumber: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port: portNumber });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`bundled nginx did not listen on ${host}:${String(portNumber)}`);
}

export function createLocalNginxProxy(options: LocalNginxProxyOptions): LocalNginxProxy {
  const executablePath = bundledNginxExecutable();
  const listenHost = options.listenHost ?? "127.0.0.1";
  const runtimeDir = options.runtimeDir ?? join(tmpdir(), "dsh-collab", `nginx-${String(options.listenPort)}`);
  const configPath = join(runtimeDir, "nginx.conf");
  let child: ChildProcess | undefined;

  return {
    executablePath,
    runtimeDir,
    configPath,
    async start(): Promise<void> {
      if (child && child.exitCode === null) return;
      await mkdir(join(runtimeDir, "logs"), { recursive: true });
      await mkdir(join(runtimeDir, "temp", "client_body"), { recursive: true });
      await mkdir(join(runtimeDir, "temp", "proxy"), { recursive: true });
      await writeFile(configPath, renderLocalNginxConfig(options), "utf8");
      child = spawn(executablePath, ["-p", "./", "-c", "nginx.conf", "-g", "daemon off;"], {
        cwd: runtimeDir,
        windowsHide: true,
        stdio: "ignore",
      });
      await waitForPort(listenHost, options.listenPort);
    },
    async stop(): Promise<void> {
      const active = child;
      child = undefined;
      if (!active || active.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const stop = spawn(executablePath, ["-p", "./", "-c", "nginx.conf", "-s", "quit"], {
          cwd: runtimeDir,
          windowsHide: true,
          stdio: "ignore",
        });
        stop.once("error", () => resolve());
        stop.once("exit", () => resolve());
        setTimeout(resolve, 2000);
      });
      await new Promise<void>((resolve) => {
        if (active.exitCode !== null) return resolve();
        active.once("exit", () => resolve());
        setTimeout(() => {
          if (active.exitCode === null) active.kill();
          resolve();
        }, 2000);
      });
    },
    async dispose(): Promise<void> {
      await this.stop();
      await rm(runtimeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

export function resolveDshPort(configured?: number): number {
  if (configured !== undefined) return port(configured, "port");
  const args = process.argv;
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "--port" || args[index] === "-p") return port(Number(args[index + 1]), "port");
  }
  return 3080;
}

export function resolveLocalProxyPort(targetPort: number, configured?: number): number {
  return configured === undefined ? port(targetPort + 100, "listenPort") : port(configured, "listenPort");
}
