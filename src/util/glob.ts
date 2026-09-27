// Small glob matcher for repo-relative POSIX paths: `**`, `*`, `?`, `{a,b}`.
// A pattern without a slash matches the basename at any depth (like .gitignore).

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let g = glob.replace(/^\.\//, "");
  const anyDepth = !g.includes("/") || g.startsWith("**/");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slash = g[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = g.indexOf("}", i);
      const alts = g.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
      re += `(?:${alts.join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  const prefix = anyDepth && !g.startsWith("**/") ? "(?:.*/)?" : "";
  const rx = new RegExp(`^${prefix}${re}(?:/.*)?$`);
  cache.set(glob, rx);
  return rx;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g).test(p));
}
