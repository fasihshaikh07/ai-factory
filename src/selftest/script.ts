// Selftest: a tiny real .NET shop repo with one bug, and scripted answers for every model call
// and both coding-agent jobs. Everything else in the run is real (git, test lab, containers, gates).
import type { Conversation, Provider, Turn } from "../runners/api.js";
import type { AgentScript } from "../runners/claude-agent.js";

export const REQUEST = "Return 404 Not Found when an order doesn't exist, instead of crashing with a 500.";
const SPAN = "Return 404 Not Found when an order doesn't exist";

const BUGGY_LINE = 'app.MapGet("/orders/{id:int}", (int id) => Results.Ok(new { id, item = orders[id] }));';
const FIXED_LINE = 'app.MapGet("/orders/{id:int}", (int id) => orders.TryGetValue(id, out var item) ? Results.Ok(new { id, item }) : Results.NotFound());';

const program = (line: string) => `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var orders = new Dictionary<int, string> { [1] = "Coffee beans", [2] = "Green tea" };

app.MapGet("/", () => "Shop is up");
${line}

app.Run();

public partial class Program { }
`;

const TESTS_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.10" />
    <PackageReference Include="Npgsql" Version="8.0.5" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Api/Shop.Api.csproj" />
  </ItemGroup>
</Project>
`;

const httpTest = (cls: string, body: string) => `using System.Net;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace Shop.Tests;

public class ${cls} : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;
    public ${cls}(WebApplicationFactory<Program> factory) => _factory = factory;
${body}}
`;

/** The sample repo at its first commit: path → content. */
export const SAMPLE_REPO: Record<string, string> = {
  "Shop.sln": `
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Shop.Api", "Shop.Api\\Shop.Api.csproj", "{7B0C1A52-3D4E-4F60-9A11-2B3C4D5E6F70}"
EndProject
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Shop.Tests", "Shop.Tests\\Shop.Tests.csproj", "{8C1D2B63-4E5F-4071-AB22-3C4D5E6F7081}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{7B0C1A52-3D4E-4F60-9A11-2B3C4D5E6F70}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
		{7B0C1A52-3D4E-4F60-9A11-2B3C4D5E6F70}.Debug|Any CPU.Build.0 = Debug|Any CPU
		{8C1D2B63-4E5F-4071-AB22-3C4D5E6F7081}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
		{8C1D2B63-4E5F-4071-AB22-3C4D5E6F7081}.Debug|Any CPU.Build.0 = Debug|Any CPU
	EndGlobalSection
EndGlobal
`,
  "Shop.Api/Shop.Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`,
  "Shop.Api/Program.cs": program(BUGGY_LINE),
  "Shop.Tests/Shop.Tests.csproj": TESTS_CSPROJ,
  "Shop.Tests/OrdersTests.cs": httpTest("OrdersTests", `
    [Fact]
    public async Task ExistingOrderIsReturned()
    {
        var res = await _factory.CreateClient().GetAsync("/orders/1");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }
`),
  // proves the lab's test database is reachable from the tests
  "Shop.Tests/DatabaseTests.cs": `using Npgsql;
using Xunit;

namespace Shop.Tests;

public class DatabaseTests
{
    [Fact]
    public async Task TestDatabaseRoundTrip()
    {
        var cs = Environment.GetEnvironmentVariable("ConnectionStrings__Default");
        Assert.False(string.IsNullOrEmpty(cs), "no test database connection string");
        await using var conn = new NpgsqlConnection(cs);
        await conn.OpenAsync();
        await using (var c = new NpgsqlCommand("CREATE TABLE IF NOT EXISTS selftest (id int PRIMARY KEY, note text); INSERT INTO selftest VALUES (1, 'ok') ON CONFLICT (id) DO NOTHING;", conn))
            await c.ExecuteNonQueryAsync();
        await using var q = new NpgsqlCommand("SELECT note FROM selftest WHERE id = 1", conn);
        Assert.Equal("ok", (string?)await q.ExecuteScalarAsync());
    }
}
`,
  ".gitignore": "bin/\nobj/\n",
};

const ANCHOR = { path: "Shop.Api/Program.cs", lineStart: 7, lineEnd: 7, quote: BUGGY_LINE };

const SPEC = {
  requirements: [{
    id: "REQ-1", ears: "When an order that does not exist is requested, the Shop API shall respond with 404 Not Found.", op: "MODIFIED", sources: ["I-1"],
    anchors: [ANCHOR],
    acceptance: [{ id: "AC-1.1", given: "no order with id 999", when: "GET /orders/999 is called", then: "the response status is 404", level: "api" }],
  }],
  nfrs: [], outOfScope: ["other endpoints"], assumptions: [], suggestions: [],
};

/** The answer each thinking step gets, picked by its system prompt. */
export function scriptedAnswer(system: string): unknown {
  if (system.includes("intake step")) return { source: "cli", spans: [{ id: "I-1", text: SPAN }], changeClass: "bugfix", risk: "low", riskTags: [], rigor: "light", touchesUi: false };
  if (system.includes("grounding step")) return { claims: [{ id: "C-1", text: "GET /orders/{id} indexes the dictionary directly, so a missing id throws and the API answers 500", spans: ["I-1"], anchors: [{ ...ANCHOR, symbol: "MapGet /orders/{id}" }] }], notFound: [] };
  if (system.includes("independently reading a change request")) return { spans: [{ id: "I-1", behaviours: [{ text: "GET /orders/999 returns 404", kind: "error" }, { text: "GET /orders/1 still returns the order", kind: "happy" }] }] };
  if (system.includes("Three engineers independently")) return { differences: [] };
  if (system.includes("Requirements analyst")) return { questions: [], conflicts: [] };
  if (system.includes("Merge three independent")) return { spec: SPEC, alignment: [{ mergedReq: "REQ-1", from: ["d1:REQ-1", "d2:REQ-1", "d3:REQ-1"] }], conflicts: [] };
  if (system.includes("State, as numbered")) return { sentences: [{ n: 1, text: "Asking for an order that doesn't exist gives 404 Not Found." }] };
  if (system.includes("Map each restated")) return { mapping: [{ n: 1, spans: ["I-1"], answers: [] }] };
  if (system.includes("Senior engineer writing a behaviour spec")) return SPEC;
  if (system.includes("Adversarial reviewer")) return { findings: [] };
  if (system.includes("plan the implementation")) return {
    tasks: [{ id: "TASK-1", title: "Return 404 for a missing order", reqs: ["REQ-1"], fileScope: ["Shop.Api/Program.cs"], exemplars: [], conventions: [], dependsOn: [], plannedLoc: 1, approach: "TryGetValue, NotFound when missing" }],
    options: [{ id: "O-1", summary: "TryGetValue in the handler", simplest: true, tradeoffs: "none" }, { id: "O-2", summary: "exception middleware mapping KeyNotFound to 404", simplest: false, tradeoffs: "hides other bugs" }],
    chosen: "O-1", adr: "Check the dictionary in the handler; a global exception mapping isn't asked for.", protectedPathsDeclared: [], newDependencies: [], stubs: [],
  };
  if (system.includes("review a finished change")) return { findings: [] };
  throw new Error(`selftest has no scripted answer for this step: ${system.slice(0, 80)}`);
}

/** A model provider that answers from the script, free: zero tokens, so zero cost. */
export const scriptedProvider: Provider = {
  start(_model, _effort, system): Conversation {
    return {
      async next(): Promise<Turn> {
        return { calls: [{ id: "s", name: "submit_result", input: scriptedAnswer(system) }], text: "", stop: "tool_use", usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 } };
      },
      toolResults() {}, say() {},
    };
  },
};

/** What the coding container writes for each job. */
export function agentScript(step: string): AgentScript | undefined {
  if (step === "author-tests") return {
    writes: [{ path: "Shop.Tests/MissingOrderTests.cs", content: httpTest("MissingOrderTests", `
    [Fact]
    public async Task AC_1_1_Returns404ForMissingOrder()
    {
        var res = await _factory.CreateClient().GetAsync("/orders/999");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task CHAR_ExistingOrderStillReturned()
    {
        var res = await _factory.CreateClient().GetAsync("/orders/2");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Contains("Green tea", await res.Content.ReadAsStringAsync());
    }
`) }],
    output: {
      tests: [{ acId: "AC-1.1", file: "Shop.Tests/MissingOrderTests.cs", name: "AC_1_1_Returns404ForMissingOrder" }],
      characterisation: [{ target: "GET /orders/{id}", file: "Shop.Tests/MissingOrderTests.cs", name: "CHAR_ExistingOrderStillReturned" }],
      probes: [{ acId: "AC-1.1", method: "GET", path: "/orders/999", expectStatus: 404 }],
      notes: "",
    },
  };
  if (step === "implement") return {
    writes: [{ path: "Shop.Api/Program.cs", content: program(FIXED_LINE) }],
    output: { done: true, filesChanged: ["Shop.Api/Program.cs"], notes: "" },
  };
  return undefined;
}
