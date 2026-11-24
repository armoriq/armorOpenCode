import path from "node:path";

const OPERATORS = new Set([..."\t\n\r ;|&()<>"]);
const GLOB = /[*?[\u0000]/;
const ANY = "\u0000";

export const BREAK = ";";

export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (word) words.push(word);
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < command.length) word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && i + 1 < command.length) {
      const next = command[++i]!;
      if (next !== "\n") word += next;
    } else if (OPERATORS.has(c) || c === "`") {
      flush();
      if (c !== " " && c !== "\t") words.push(BREAK);
    } else word += c;
  }
  flush();
  return words.flatMap((w) => (w === BREAK ? [w] : w.split(/[=:,]/))).filter(Boolean);
}

export function proseWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[`'"(<[{]+|[`'")>\]},.;:!?]+$/g, ""))
    .filter(Boolean);
}

function expandHome(word: string, home: string): string {
  return word.replace(/^(?:~|\$home|\$\{home\})(?=\/|$)/i, home);
}

export function resolveWord(word: string, cwd: string, home: string): string {
  const expanded = expandHome(word.trim(), home).replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, ANY);
  const absolute = expanded.startsWith("/") ? expanded : `${cwd}/${expanded}`;
  return path.posix.normalize(absolute).replace(/\/+$/, "") || "/";
}

export const hasGlob = (value: string) => GLOB.test(value);

function segmentRegex(segment: string): RegExp {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === ANY || c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end < 0) out += "\\[";
      else {
        let body = segment.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (segment.startsWith(".") && !pattern.startsWith(".") && !pattern.startsWith(ANY)) return false;
  if (!hasGlob(pattern)) return pattern.toLowerCase() === segment.toLowerCase();
  try {
    return segmentRegex(pattern).test(segment);
  } catch {
    return true;
  }
}

export const split = (p: string) => p.split("/").filter(Boolean);

function reaches(p: string[], i: number, t: string[], j: number): boolean {
  if (j === t.length) return true;
  if (i === p.length) return false;
  if (p[i] === "**") return reaches(p, i + 1, t, j) || (!t[j]!.startsWith(".") && reaches(p, i, t, j + 1));
  return segmentMatches(p[i]!, t[j]!) && reaches(p, i + 1, t, j + 1);
}

export function mayReach(resolved: string, target: string): boolean {
  return reaches(split(resolved), 0, split(target), 0);
}

export function mayBeAncestor(resolved: string, target: string): boolean {
  const p = split(resolved);
  const t = split(target);
  return p.length < t.length && p.every((seg, k) => seg !== "**" && segmentMatches(seg, t[k]!));
}

export function baseNameMatches(resolved: string, names: readonly string[]): boolean {
  const base = split(resolved).at(-1);
  return base !== undefined && base !== "**" && names.some((n) => segmentMatches(base, n));
}

export function expandGlob(resolved: string, readdir: (dir: string) => string[], limit = 2_000): string[] | null {
  let found = [""];
  for (const seg of split(resolved)) {
    if (seg === "**") return null;
    if (!hasGlob(seg)) {
      found = found.map((p) => `${p}/${seg}`);
      continue;
    }
    const next: string[] = [];
    for (const p of found) {
      let names: string[];
      try {
        names = readdir(p || "/");
      } catch {
        continue;
      }
      for (const name of names) if (segmentMatches(seg, name)) next.push(`${p}/${name}`);
      if (next.length > limit) return null;
    }
    found = next;
  }
  return found.map((p) => p || "/");
}
