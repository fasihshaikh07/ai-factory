// Secrets live only in ~/.factory/.env, created by the user. Never printed, never logged.
import { existsSync, readFileSync, statSync } from "node:fs";
import { paths } from "../util/paths.js";

let cache: Record<string, string> | undefined;

export function loadFactoryEnv(file = paths.envFile()): Record<string, string> {
  if (cache) return cache;
  const out: Record<string, string> = {};
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o077;
    if (mode) process.emitWarning(`${file} is readable by other users. Run: chmod 600 ${file}`);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  cache = out;
  return out;
}

/** A credential by env var name: ~/.factory/.env first, then the process env. */
export function secret(name: string): string | undefined {
  return loadFactoryEnv()[name] ?? process.env[name];
}

export function hasSecret(name: string): boolean {
  return !!secret(name);
}

/** Mask anything that looks like a known secret value in text we log or store. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const v of Object.values(loadFactoryEnv())) {
    if (v && v.length >= 8) out = out.split(v).join("«SECRET»");
  }
  return out;
}

export function _resetEnvCache(): void {
  cache = undefined;
}
