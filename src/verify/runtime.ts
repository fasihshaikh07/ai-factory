// ContainerRuntime over the Docker-compatible CLI (verify-runner §2.11, run-manager §2.10).
// Docker Engine CE or Podman inside WSL2. Never Docker Desktop's Windows binary.
import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface Mount { src: string; dst: string; ro?: boolean }

export interface ContainerSpec {
  image: string;
  role: "agent" | "producer" | "db" | "restore" | "app";
  labels: { run: string; key: string };
  /** "none", "bridge" or "container:<id>" (share the db's loopback-only namespace). */
  network: string;
  mounts: Mount[];
  env: Record<string, string>;
  cmd: string[];
  entrypoint?: string;
  workdir?: string;
  user?: string;
  memory?: string;
  cpus?: string;
  pids?: number;
  readOnlyRoot?: boolean;
  tmpfs?: string[];
  /** Capabilities added back after --cap-drop=ALL (Postgres needs a few to start). */
  capAdd?: string[];
}

export interface ContainerRuntime {
  readonly binary: string;
  version(): Promise<string>;
  /** Create and start; the id is returned before anything runs so it can be logged. */
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  /** Wait for exit. Returns exit code, or undefined on timeout (the caller stops it). */
  wait(id: string, timeoutMs: number): Promise<number | undefined>;
  exec(id: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  logs(id: string): Promise<string>;
  stop(id: string, graceSec?: number): Promise<void>;
  remove(id: string): Promise<void>;
  listByLabel(label: string, value?: string): Promise<{ id: string; labels: Record<string, string> }[]>;
  imageDigest(image: string): Promise<string>;
}

export class RuntimeUnavailableError extends Error {}

/** Find docker or podman inside Linux. A binary under /mnt/<drive> is Docker Desktop's and is refused. */
export function findRuntimeBinary(): string {
  const tried: string[] = [];
  for (const name of [process.env.FACTORY_CONTAINER_CLI, "docker", "podman"].filter(Boolean) as string[]) {
    try {
      const p = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (!p) continue;
      const real = realpathSync(p);
      if (/^\/mnt\/[a-z]\//i.test(real) || /docker-desktop|DockerDesktop/i.test(real)) {
        tried.push(`${name} → ${real} (Docker Desktop, not used)`);
        continue;
      }
      return p;
    } catch {
      tried.push(`${name} not found`);
    }
  }
  throw new RuntimeUnavailableError(
    `No container runtime inside Linux. Install Docker Engine CE in Ubuntu (not Docker Desktop). Tried: ${tried.join("; ")}`,
  );
}

export class DockerCli implements ContainerRuntime {
  constructor(readonly binary = findRuntimeBinary()) {}

  private async run(args: string[], timeoutMs = 600_000): Promise<string> {
    const { stdout } = await exec(this.binary, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
    return stdout.trim();
  }

  async version(): Promise<string> {
    return this.run(["version", "--format", "{{.Server.Version}}"]);
  }

  async create(s: ContainerSpec): Promise<string> {
    const args = [
      "create", "--init",
      "--label", `factory.run=${s.labels.run}`, "--label", `factory.role=${s.role}`, "--label", `factory.key=${s.labels.key}`,
      "--network", s.network,
      "--cap-drop=ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", String(s.pids ?? 1024),
      "--memory", s.memory ?? "6g", "--cpus", s.cpus ?? "4",
    ];
    for (const c of s.capAdd ?? []) args.push("--cap-add", c);
    if (s.user) args.push("--user", s.user);
    if (s.workdir) args.push("--workdir", s.workdir);
    if (s.entrypoint !== undefined) args.push("--entrypoint", s.entrypoint);
    if (s.readOnlyRoot) args.push("--read-only");
    for (const t of s.tmpfs ?? []) args.push("--tmpfs", t);
    for (const m of s.mounts) args.push("--mount", `type=bind,src=${m.src},dst=${m.dst}${m.ro ? ",readonly" : ""}`);
    for (const [k, v] of Object.entries(s.env)) args.push("--env", `${k}=${v}`);
    args.push(s.image, ...s.cmd);
    return this.run(args);
  }

  async start(id: string): Promise<void> {
    await this.run(["start", id]);
  }

  async wait(id: string, timeoutMs: number): Promise<number | undefined> {
    try {
      return Number(await this.run(["wait", id], timeoutMs));
    } catch (e) {
      if ((e as { killed?: boolean }).killed) return undefined;
      throw e;
    }
  }

  async exec(id: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await exec(this.binary, ["exec", id, ...cmd], { maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  async logs(id: string): Promise<string> {
    const { stdout, stderr } = await exec(this.binary, ["logs", id], { maxBuffer: 64 * 1024 * 1024 });
    return stdout + stderr;
  }

  async stop(id: string, graceSec = 10): Promise<void> {
    await this.run(["stop", "-t", String(graceSec), id]).catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    await this.run(["rm", "-f", "-v", id]).catch(() => undefined);
  }

  async listByLabel(label: string, value?: string): Promise<{ id: string; labels: Record<string, string> }[]> {
    const out = await this.run(["ps", "-a", "--filter", `label=${label}${value ? `=${value}` : ""}`, "--format", "{{.ID}}\t{{.Labels}}"]);
    if (!out) return [];
    return out.split("\n").map((l) => {
      const [id, labels = ""] = l.split("\t");
      return { id: id!, labels: Object.fromEntries(labels.split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string])) };
    });
  }

  async imageDigest(image: string): Promise<string> {
    return this.run(["image", "inspect", "--format", "{{index .RepoDigests 0}}", image]).catch(() => image);
  }
}

/** Stop then remove, always. Killing our process doesn't stop a container. */
export async function stopAndRemove(rt: ContainerRuntime, id: string, graceSec = 5): Promise<void> {
  await rt.stop(id, graceSec);
  await rt.remove(id);
}
