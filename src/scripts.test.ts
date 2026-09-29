// Guard: shell scripts must keep Unix line endings and parse, or setup breaks for everyone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scripts = execFileSync("git", ["ls-files", "*.sh"], { encoding: "utf8" }).split("\n").filter(Boolean);

describe("shell scripts", () => {
  it("exist", () => expect(scripts.length).toBeGreaterThan(0));
  for (const f of scripts) {
    it(`${f} has Unix line endings and parses`, () => {
      expect(readFileSync(f, "utf8").includes("\r"), `${f} contains Windows line endings (CRLF)`).toBe(false);
      execFileSync("bash", ["-n", f]); // throws on a syntax error
    });
  }
});
