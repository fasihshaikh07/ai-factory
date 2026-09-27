// Networks and proxies for containers (verify-runner §2.3, stages-aligned §6 "Container A packages").
//   factory-agent-net  (internal): agent containers + api proxy → only the model API, key added by the proxy
//   factory-feeds-net  (internal): restore containers + feed proxy → only allowlisted package hosts
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { secret } from "../config/env.js";
import type { ContainerRuntime } from "../verify/runtime.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..", "..");

export const AGENT_NET = "factory-agent-net";
export const FEEDS_NET = "factory-feeds-net";
export const API_PROXY = "factory-api-proxy";
export const FEED_PROXY = "factory-feed-proxy";
export const PROXY_IMAGE = "node:22-alpine";
export const AGENT_IMAGE = "factory-agent:dotnet8";

export const API_BASE_URL = `http://${API_PROXY}:8080/anthropic`;
export const FEED_PROXY_URL = `http://${FEED_PROXY}:3128`;

async function cli(rt: ContainerRuntime, args: string[]): Promise<string> {
  const { stdout } = await exec(rt.binary, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 });
  return stdout.trim();
}

async function exists(rt: ContainerRuntime, kind: "network" | "container" | "image", name: string): Promise<boolean> {
  try {
    await cli(rt, [kind, "inspect", name]);
    return true;
  } catch {
    return false;
  }
}

async function running(rt: ContainerRuntime, name: string): Promise<boolean> {
  try {
    return (await cli(rt, ["inspect", "-f", "{{.State.Running}}", name])) === "true";
  } catch {
    return false;
  }
}

/** Tests with a fake runtime skip real network/image setup. */
let skipInfra = false;
export function setSkipInfra(v: boolean): void {
  skipInfra = v;
}

/** Idempotent: create networks, then (re)start both proxies. */
export async function ensureEgress(rt: ContainerRuntime, feedHosts: string[]): Promise<void> {
  if (skipInfra) return;
  for (const net of [AGENT_NET, FEEDS_NET]) {
    if (!(await exists(rt, "network", net))) await cli(rt, ["network", "create", "--internal", net]);
  }
  const proxyFile = join(REPO_ROOT, "docker", "proxy", "proxy.mjs");
  const start = async (name: string, net: string, env: Record<string, string | undefined>) => {
    if (await running(rt, name)) return;
    await cli(rt, ["rm", "-f", name]).catch(() => undefined);
    const envArgs = Object.entries(env).filter(([, v]) => v).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    // start on the default bridge (for upstream access), then join the internal network
    await cli(rt, [
      "run", "-d", "--name", name, "--restart", "unless-stopped", "--label", "factory.role=proxy",
      "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "node",
      "--mount", `type=bind,src=${proxyFile},dst=/proxy.mjs,readonly`, ...envArgs,
      PROXY_IMAGE, "node", "/proxy.mjs",
    ]);
    await cli(rt, ["network", "connect", net, name]);
  };
  await start(API_PROXY, AGENT_NET, { MODE: "api", ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"), OPENAI_API_KEY: secret("OPENAI_API_KEY") });
  await start(FEED_PROXY, FEEDS_NET, { MODE: "feeds", ALLOW_HOSTS: feedHosts.join(",") });
}

/** Build container A's image once (docker/agent). */
export async function ensureAgentImage(rt: ContainerRuntime, sdkImage: string): Promise<void> {
  if (skipInfra) return;
  if (await exists(rt, "image", AGENT_IMAGE)) return;
  await cli(rt, ["build", "--build-arg", `DOTNET_SDK=${sdkImage}`, "-t", AGENT_IMAGE, join(REPO_ROOT, "docker", "agent")]);
}

/** Feed hosts from the policy's URL-prefix allowlist (host part only in the POC). */
export function feedHostsFrom(prefixes: string[]): string[] {
  const hosts = new Set<string>(["api.nuget.org", "globalcdn.nuget.org"]);
  for (const p of prefixes) {
    try { hosts.add(new URL(p).hostname); } catch { /* skip */ }
  }
  return [...hosts];
}
