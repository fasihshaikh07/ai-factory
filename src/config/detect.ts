// `factory init`: look at a .NET repo and propose its project config, so nobody writes YAML by hand.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface Detected {
  name: string;
  solution?: string;
  sdkImage: string;
  targetFrameworks: string[];
  usesPostgres: boolean;
  /** A connection string the tests hardcode (test fixtures), with its user and password. */
  testDb?: { database: string; user: string; password: string; file: string };
  connectionNames: string[];
  frontendDirs: string[];
  refusals: string[];
}

const SKIP = new Set([".git", "node_modules", "bin", "obj", ".vs", "packages", "dist", "build"]);

function walk(root: string, max = 4000): string[] {
  const out: string[] = [];
  const go = (dir: string, depth: number) => {
    if (depth > 6 || out.length > max) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) go(p, depth + 1);
      else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  go(root, 0);
  return out;
}

export function slugName(dir: string): string {
  return basename(dir).toLowerCase().replace(/\.(net|git)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

const read = (root: string, f: string) => { try { return readFileSync(join(root, f), "utf8"); } catch { return ""; } };

export function detectDotnet(root: string): Detected {
  const files = walk(root);
  const slns = files.filter((f) => f.endsWith(".sln") || f.endsWith(".slnx")).sort((a, b) => a.split("/").length - b.split("/").length);
  const csprojs = files.filter((f) => f.endsWith(".csproj"));
  const tfms = new Set<string>();
  let usesPostgres = false;
  const refusals: string[] = [];
  for (const c of csprojs) {
    const x = read(root, c);
    for (const m of x.matchAll(/<TargetFrameworks?>([^<]+)</g)) for (const t of m[1]!.split(";")) tfms.add(t.trim());
    if (/Npgsql/i.test(x)) usesPostgres = true;
    if (/Testcontainers/i.test(x)) refusals.push(`tests use Testcontainers (${c})`);
    if (/Include="(Microsoft\.EntityFrameworkCore\.SqlServer|System\.Data\.SqlClient|Microsoft\.Data\.SqlClient)"/i.test(x)) refusals.push(`uses SQL Server (${c})`);
    if (/<UseWPF>true|<UseWindowsForms>true|<TargetFrameworks?>[^<]*\bnet4\d/i.test(x)) refusals.push(`Windows-only target (${c})`);
  }
  if (existsSync(join(root, ".gitmodules"))) refusals.push("uses git submodules");
  if (/filter=lfs/.test(read(root, ".gitattributes"))) refusals.push("uses Git LFS");

  // highest netX.Y → SDK image
  const versions = [...tfms].map((t) => /^net(\d+)\.(\d+)/.exec(t)).filter(Boolean).map((m) => `${m![1]}.${m![2]}`);
  const best = versions.sort((a, b) => parseFloat(b) - parseFloat(a))[0] ?? "8.0";
  const globalJson = read(root, "global.json");
  const pinned = /"version"\s*:\s*"(\d+)\.(\d+)/.exec(globalJson);
  const sdk = pinned ? `${pinned[1]}.${pinned[2]}` : best;

  // hardcoded test connection strings (Host=localhost...;Username=...;Password=...)
  let testDb: Detected["testDb"];
  for (const f of files.filter((f) => /test/i.test(f) && f.endsWith(".cs"))) {
    const m = /Host=(?:localhost|127\.0\.0\.1)[^"]*?Database=([^;"]+)[^"]*?(?:Username|User Id|User)=([^;"]+)[^"]*?Password=([^;"]+)/i.exec(read(root, f));
    if (m && !/^postgres$/i.test(m[1]!)) { testDb = { database: m[1]!, user: m[2]!, password: m[3]!, file: f }; break; }
  }

  const connectionNames = new Set<string>();
  for (const f of files.filter((f) => f.endsWith(".cs"))) for (const m of read(root, f).matchAll(/GetConnectionString\("([A-Za-z0-9_]+)"\)/g)) connectionNames.add(m[1]!);

  const frontendDirs = [...new Set(files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules")).map((f) => f.split("/")[0]!).filter((d) => d !== "package.json"))]
    .filter((d) => { try { return statSync(join(root, d)).isDirectory(); } catch { return false; } });

  return {
    name: slugName(root), solution: slns[0], sdkImage: `mcr.microsoft.com/dotnet/sdk:${sdk}`,
    targetFrameworks: [...tfms], usesPostgres, testDb, connectionNames: [...connectionNames].sort(), frontendDirs, refusals,
  };
}

export function envVarFor(name: string, what: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${what}`;
}

/** YAML text for the detected project. Secrets never go in it, only env var names. */
export function projectYaml(d: Detected, repo: string, baseBranch: string): string {
  const dummy = "Host=localhost;Database=dummy;Username=dummy;Password=dummy";
  const names = d.connectionNames.length ? d.connectionNames : ["DefaultConnection"];
  const lines = [
    `# Written by \`factory init\`. No secrets here: only names of variables in ~/.factory/.env.`,
    `project: ${d.name}`,
    `repo: ${repo}`,
    `baseBranch: ${baseBranch}`,
    `stack: dotnet`,
    `dotnet:`,
    `  sdkImage: ${d.sdkImage}`,
    ...(d.solution ? [`  solution: ${d.solution}`] : []),
    `  testTimeoutSec: 2400`,
  ];
  if (d.usesPostgres) {
    lines.push(`database:`, `  image: postgres:16-alpine`);
    if (d.testDb) {
      lines.push(
        `  name: ${d.testDb.database}              # from ${d.testDb.file}`,
        `  user: ${d.testDb.user}                  # created without superuser`,
        `  passwordEnv: ${envVarFor(d.name, "TEST_DB_PASSWORD")}`,
      );
    }
    lines.push(`  producerEnv:`, `    ConnectionStrings__${names[0]}: "Host={{DB_HOST}};Port={{DB_PORT}};Database={{DB_NAME}};Username={{DB_USER}};Password={{DB_PASSWORD}}"`);
  }
  lines.push(`agentEnv:`, ...names.map((n) => `  ConnectionStrings__${n}: "${dummy}"`));
  if (d.frontendDirs.length) lines.push(`noGo:`, ...d.frontendDirs.map((f) => `  - "${f}/**"`));
  return lines.join("\n") + "\n";
}
