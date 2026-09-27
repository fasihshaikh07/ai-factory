import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectDotnet, envVarFor, projectYaml, slugName } from "./detect.js";
import { ProjectConfig } from "./project.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-detect-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const API = `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup>
<ItemGroup><PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="9.0.0" />
<Compile Remove="Data\\Migrations_Backup_SqlServer\\**" /></ItemGroup></Project>`;

describe("factory init detection", () => {
  it("finds solution, .NET version, Postgres, the tests' login, frontend folders", () => {
    const r = repo({
      "Shop.Api.sln": "", "src/Shop.Api/Shop.Api.csproj": API,
      "src/Shop.Api/Program.cs": 'builder.Configuration.GetConnectionString("DefaultConnection"); x.GetConnectionString("ReportsConnection");',
      "tests/Shop.Tests/Shop.Tests.csproj": "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
      "tests/Shop.Tests/DbFixture.cs": 'const string Cs = "Host=localhost;Port=5432;Database=ShopTestDb;Username=shop;Password=s3cret";',
      "web/package.json": "{}",
    });
    const d = detectDotnet(r);
    expect(d.solution).toBe("Shop.Api.sln");
    expect(d.sdkImage).toBe("mcr.microsoft.com/dotnet/sdk:9.0");
    expect(d.usesPostgres).toBe(true);
    expect(d.testDb).toEqual({ database: "ShopTestDb", user: "shop", password: "s3cret", file: "tests/Shop.Tests/DbFixture.cs" });
    expect(d.connectionNames).toEqual(["DefaultConnection", "ReportsConnection"]);
    expect(d.frontendDirs).toEqual(["web"]);
    expect(d.refusals).toEqual([]); // a folder named *SqlServer* isn't SQL Server
  });

  it("writes a valid config with no secrets in it", () => {
    const r = repo({ "a.sln": "", "a/a.csproj": API, "tests/T/Fx.cs": 'x = "Host=127.0.0.1;Database=Db1;Username=u;Password=p4ss";' });
    const d = { ...detectDotnet(r), name: "shop-api" };
    const y = projectYaml(d, r, "main");
    expect(y).not.toContain("p4ss");
    const cfg = ProjectConfig.parse(parse(y));
    expect(cfg.database?.passwordEnv).toBe("SHOP_API_TEST_DB_PASSWORD");
    expect(cfg.database?.user).toBe("u");
    expect(envVarFor("shop-api", "TEST_DB_PASSWORD")).toBe("SHOP_API_TEST_DB_PASSWORD");
  });

  it("refuses what the POC can't run", () => {
    const r = repo({ "b/b.csproj": '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" /><PackageReference Include="Testcontainers.PostgreSql" /></ItemGroup></Project>' });
    expect(detectDotnet(r).refusals.map((x) => x.split(" (")[0])).toEqual(["tests use Testcontainers", "uses SQL Server"]);
  });

  it("names projects from folders", () => {
    expect(slugName("/home/x/code/Shop.Api.net")).toBe("shop-api");
    expect(slugName("/home/x/code/My_Repo")).toBe("my-repo");
  });
});
