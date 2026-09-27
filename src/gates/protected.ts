// What the agent may never change (gate-engine §2.4).
import { matchesAny } from "../util/glob.js";

/** Test infrastructure locked after author-tests (in addition to the locked test files by hash). */
export const LOCK_SET_GLOBS = [
  "**/*Test*.csproj", "**/*Tests*.csproj", "**/*.Test*.csproj",
  "**/*.runsettings", "**/xunit.runner.json", "**/testconfig.json",
  "**/jest.config.*", "**/jest.setup.*", "**/vitest.config.*", "**/vitest.setup.*", "**/vitest.workspace.*",
  "**/playwright.config.*", "**/setupTests.*",
  "**/*WebApplicationFactory*.cs", "**/TestHelpers/**", "**/TestUtilities/**", "**/Fixtures/**",
  "**/__snapshots__/**", "**/*.snap", "**/*.verified.*",
  "**/mocks/**", "**/__mocks__/**", "**/wiremock/**",
];

/** Protected unless the plan declares them (which forces risk ≥ medium). */
export const CONFIG_INTEGRITY_GLOBS = [
  // lint, analyzers, TS config, build config
  "**/.editorconfig", "**/.eslintrc*", "**/eslint.config.*", "**/.prettierrc*", "**/tsconfig*.json",
  "**/Directory.Build.*", "**/Directory.Packages.props", "**/global.json", "**/.nvmrc", "**/*.ruleset",
  "**/.globalconfig", "**/stylecop.json",
  // CI
  ".github/workflows/**", "bitbucket-pipelines.yml", ".gitlab-ci.yml", "azure-pipelines*.yml", "Jenkinsfile",
  // migrations
  "**/Migrations/**", "**/migrations/**",
  // factory + git plumbing
  ".factory/**", "**/.gitattributes", ".gitmodules",
  // agent instruction files at any depth
  "**/CLAUDE*.md", "**/AGENTS*.md", "**/GEMINI.md", "**/.claude/**", "**/.codex/**", "**/.cursor/**",
  "**/.cursorrules", "**/.windsurfrules", "**/.mcp.json",
  ".github/copilot-instructions.md", ".github/instructions/**",
  // package feeds
  "**/nuget.config", "**/NuGet.Config", "**/.npmrc", "**/.yarnrc*",
];

/** Test projects in .NET are recognised by name; the solution file's test entries by diff content (predicate). */
export function isLockSetPath(path: string, lockedFiles: readonly string[] = []): boolean {
  return lockedFiles.includes(path) || matchesAny(path, LOCK_SET_GLOBS);
}

export function isConfigIntegrityPath(path: string, extraProtected: readonly string[] = []): boolean {
  return matchesAny(path, CONFIG_INTEGRITY_GLOBS) || matchesAny(path, extraProtected);
}

/** Agent files the core masks in container A (context-builder §2.9). */
export const AGENT_FILE_GLOBS = [
  "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/AGENTS.override.md", "**/GEMINI.md",
  "**/.cursorrules", "**/.windsurfrules", "**/.claude/**", "**/.codex/**", "**/.cursor/**", "**/.mcp.json",
  ".github/copilot-instructions.md", ".github/instructions/**",
];

/** Never inlined, never served, never copied into container A (context-builder §2.6). */
export const SECRET_PATH_GLOBS = [
  "**/.env", "**/.env.*", "**/appsettings.*.json", "**/*.pfx", "**/*.pem", "**/*.key", "**/secrets.*",
  "**/launchSettings.json", "**/*.tfvars", "**/id_rsa*", "**/*.p12",
];
const SECRET_PATH_ALLOW = ["**/*.example", "**/.env.example", "**/appsettings.json"];

export function isSecretPath(path: string, noGo: readonly string[] = []): boolean {
  if (matchesAny(path, noGo)) return true;
  if (matchesAny(path, SECRET_PATH_ALLOW) && !/appsettings\.[^/]+\.json$/.test(path)) return false;
  return matchesAny(path, SECRET_PATH_GLOBS);
}
