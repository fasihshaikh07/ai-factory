// Networks and proxies for containers (verify-runner §2.3, stages-aligned §6 "Container A packages").
//   factory-agent-net  (internal): agent containers + api proxy → only the model API, key added by the proxy
//   factory-feeds-net  (internal): restore containers + feed proxy → only allowlisted package hosts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

function apiProxyEnv(): Record<string, string | undefined> {
  return { MODE: "api", ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"), OPENAI_API_KEY: secret("OPENAI_API_KEY") };
}

/** A short hash of the proxy's settings and code: stored as a label, never the keys themselves. */
export function proxyFingerprint(env: Record<string, string | undefined>, code: string): string {
  const keys = Object.keys(env).sort();
  return createHash("sha256").update(JSON.stringify(keys.map((k) => [k, env[k] ?? ""])) + "\0" + code).digest("hex").slice(0, 16);
}

async function label(rt: ContainerRuntime, name: string, key: string): Promise<string | undefined> {
  try {
    return (await cli(rt, ["inspect", "-f", `{{index .Config.Labels "${key}"}}`, name])) || undefined;
  } catch {
    return undefined;
  }
}

/** For doctor: is the running key proxy using today's keys? */
export async function apiProxyState(rt: ContainerRuntime): Promise<"current" | "outdated" | "not-running"> {
  if (!(await running(rt, API_PROXY))) return "not-running";
  const fp = proxyFingerprint(apiProxyEnv(), readFileSync(join(REPO_ROOT, "docker", "proxy", "proxy.mjs"), "utf8"));
  return (await label(rt, API_PROXY, "factory.config")) === fp ? "current" : "outdated";
}

/** Idempotent: create networks, then (re)start both proxies. */
export async function ensureEgress(rt: ContainerRuntime, feedHosts: string[]): Promise<void> {
  if (skipInfra) return;
  for (const net of [AGENT_NET, FEEDS_NET]) {
    if (!(await exists(rt, "network", net))) await cli(rt, ["network", "create", "--internal", net]);
  }
  const proxyFile = join(REPO_ROOT, "docker", "proxy", "proxy.mjs");
  const start = async (name: string, net: string, env: Record<string, string | undefined>) => {
    // recreate when the keys, the allowlist or the proxy code changed (e.g. a key was added later)
    const fp = proxyFingerprint(env, readFileSync(proxyFile, "utf8"));
    if ((await running(rt, name)) && (await label(rt, name, "factory.config")) === fp) return;
    await cli(rt, ["rm", "-f", name]).catch(() => undefined);
    const envArgs = Object.entries(env).filter(([, v]) => v).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    // start on the default bridge (for upstream access), then join the internal network
    await cli(rt, [
      "run", "-d", "--name", name, "--restart", "unless-stopped", "--label", "factory.role=proxy", "--label", `factory.config=${fp}`,
      "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--read-only", "--user", "node",
      "--mount", `type=bind,src=${proxyFile},dst=/proxy.mjs,readonly`, ...envArgs,
      PROXY_IMAGE, "node", "/proxy.mjs",
    ]);
    await cli(rt, ["network", "connect", net, name]);
  };
  await start(API_PROXY, AGENT_NET, apiProxyEnv());
  await start(FEED_PROXY, FEEDS_NET, { MODE: "feeds", ALLOW_HOSTS: feedHosts.join(",") });
}

/** Build container A's image once (docker/agent). */
export async function ensureAgentImage(rt: ContainerRuntime, sdkImage: string): Promise<void> {
  if (skipInfra) return;
  // rebuild when the image's files (run-agent.mjs, Dockerfile, package.json) or the SDK image change
  const fp = agentImageFingerprint(sdkImage);
  if ((await exists(rt, "image", AGENT_IMAGE)) && (await imageLabel(rt, AGENT_IMAGE, "factory.config")) === fp) return;
  await cli(rt, ["build", "--label", `factory.config=${fp}`, "--build-arg", `DOTNET_SDK=${sdkImage}`, "-t", AGENT_IMAGE, join(REPO_ROOT, "docker", "agent")]);
}

export function agentImageFingerprint(sdkImage: string): string {
  const dir = join(REPO_ROOT, "docker", "agent");
  const h = createHash("sha256").update(sdkImage);
  for (const f of ["Dockerfile", "package.json", "run-agent.mjs"]) h.update(`\0${f}\0`).update(readFileSync(join(dir, f)));
  return h.digest("hex").slice(0, 16);
}

async function imageLabel(rt: ContainerRuntime, image: string, key: string): Promise<string | undefined> {
  try {
    return (await cli(rt, ["image", "inspect", "-f", `{{index .Config.Labels "${key}"}}`, image])) || undefined;
  } catch {
    return undefined;
  }
}

/** Feed hosts from the policy's URL-prefix allowlist (host part only in the POC). */
export function feedHostsFrom(prefixes: string[]): string[] {
  const hosts = new Set<string>(["api.nuget.org", "globalcdn.nuget.org"]);
  for (const p of prefixes) {
    try { hosts.add(new URL(p).hostname); } catch { /* skip */ }
  }
  return [...hosts];
}
