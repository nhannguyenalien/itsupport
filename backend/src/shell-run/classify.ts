// TypeScript mirror of agent/internal/shellrun/classify.go — see
// docs/v0.3-linux-shell-addendum.md. The Go implementation is authoritative
// (the agent re-classifies every command); this copy only lets the backend
// decide "auto-run / needs approval / reject" before anything is queued. Both
// read the same rules.json and are tested against the same fixtures
// (tests/shell-run.test.ts). Classification here is purely lexical; the agent
// additionally resolves symlinks before reading files.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ShellClass = "read" | "write" | "deny";
export interface ShellVerdict { class: ShellClass; rule: string; reason?: string }

interface ReadRule {
  id: string; bin: string; sub?: string[]; flags?: string[]; valueFlags?: Record<string, string>;
  short?: string; maxPos?: number; pos?: string; paths?: "meta" | "content";
}
interface Rules {
  execDirs: string[];
  limits: { maxArgs: number; maxArgLen: number };
  contentRoots: string[];
  deny: {
    binaries: string[]; binaryPrefixes: string[]; argSubstrings: string[]; argSuffixes: string[];
    pathRegex: string[]; argPrefixes: string[];
    systemctl: { bins: string[]; mutatingVerbs: string[]; protected: string[] };
    recursiveCritical: { bins: string[]; recursiveFlags: string[]; recursiveShort: string; extraDenyFlags: string[]; critical: string[] };
    forceFlags: { bins: string[]; flags: string[] };
  };
  read: ReadRule[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const rulesRaw = readFileSync(path.join(here, "rules.json"), "utf-8");
const rules: Rules = JSON.parse(rulesRaw);

const denyBins = new Set(rules.deny.binaries);
const pathRe = rules.deny.pathRegex.map((p) => new RegExp(p));
const defaultPosRe = /^[A-Za-z0-9_/.][A-Za-z0-9_.:/@%+,=-]{0,255}$/;
interface Compiled extends ReadRule { flagSet: Set<string>; valueRe: Map<string, RegExp>; posRe: RegExp }
const byBin = new Map<string, Compiled[]>();
for (const r of rules.read) {
  const c: Compiled = {
    ...r,
    flagSet: new Set(r.flags ?? []),
    valueRe: new Map(Object.entries(r.valueFlags ?? {}).map(([k, v]) => [k, new RegExp(v)])),
    posRe: r.pos ? new RegExp(r.pos) : defaultPosRe,
  };
  byBin.set(r.bin, [...(byBin.get(r.bin) ?? []), c]);
}

const posixClean = (p: string) => path.posix.normalize(p).replace(/(.)\/$/, "$1");

function baseName(argv: string[]): string | null {
  const b = argv[0];
  if (b === undefined) return null;
  if (!b.includes("/")) return b !== "" && b !== "." && b !== ".." ? b : null;
  const i = b.lastIndexOf("/");
  const dir = b.slice(0, i), base = b.slice(i + 1);
  return base !== "" && rules.execDirs.includes(dir) ? base : null;
}

const deny = (rule: string, reason: string): ShellVerdict => ({ class: "deny", rule, reason });

function denyVerdict(name: string, args: string[]): ShellVerdict | null {
  const d = rules.deny;
  if (denyBins.has(name) || d.binaryPrefixes.some((p) => name.startsWith(p))) return deny("deny.binary", `${name} is never allowed`);
  for (const a of args) {
    const l = a.toLowerCase();
    const sub = d.argSubstrings.find((s) => l.includes(s));
    if (sub) return deny("deny.path", `argument touches protected material (${sub})`);
    if (d.argSuffixes.some((s) => l.endsWith(s))) return deny("deny.path", "argument names a key or certificate file");
    if (d.argPrefixes.some((p) => l.startsWith(p))) return deny("deny.destructive", "writing to a block device");
    if (a.startsWith("/") && pathRe.some((re) => re.test(posixClean(a)))) return deny("deny.path", "argument touches protected process memory or environment");
  }
  if (d.systemctl.bins.includes(name)) {
    const mutating = args.some((a) => d.systemctl.mutatingVerbs.includes(a));
    const protectedUnit = args.some((a) => d.systemctl.protected.some((p) => a.toLowerCase().includes(p)));
    if (mutating && protectedUnit) return deny("deny.agent", "cannot change the support agent's own services");
  }
  const rc = d.recursiveCritical;
  if (rc.bins.includes(name)) {
    let recursive = false;
    for (const a of args) {
      if (rc.extraDenyFlags.includes(a)) return deny("deny.destructive", `${a} is never allowed`);
      if (rc.recursiveFlags.includes(a)) recursive = true;
      if (a.length > 1 && a[0] === "-" && a[1] !== "-" && [...a.slice(1)].some((c) => rc.recursiveShort.includes(c))) recursive = true;
    }
    if (recursive) {
      for (const a of args) {
        if (a.startsWith("-")) continue;
        if ((a.startsWith("/") && rc.critical.includes(posixClean("/" + a.replace(/^\//, "")))) || a === "/*") {
          return deny("deny.destructive", "recursive change on a system directory");
        }
      }
    }
  }
  if (d.forceFlags.bins.includes(name) && args.some((a) => d.forceFlags.flags.includes(a))) return deny("deny.destructive", "forced power action");
  return null;
}

const onlyChars = (s: string, set: string) => s !== "" && [...s].every((c) => set.includes(c));
const hasDotDot = (a: string) => a.split("/").includes("..");

function lexicalPathOk(p: string, content: boolean): boolean {
  if (!p.startsWith("/")) return false;
  const c = posixClean(p);
  if (pathRe.some((re) => re.test(c))) return false;
  if (!content) return true;
  return rules.contentRoots.some((root) => c === root || c.startsWith(root + "/"));
}

function matches(rule: Compiled, args: string[]): boolean {
  const sub = rule.sub ?? [];
  if (args.length < sub.length || sub.some((s, i) => args[i] !== s)) return false;
  const rest = args.slice(sub.length);
  let pos = 0;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j]!;
    if (a === "--") return false;
    if (rule.flagSet.has(a)) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a : a.slice(0, eq);
      const re = rule.valueRe.get(name);
      if (!re) return false;
      let val: string;
      if (eq >= 0) val = a.slice(eq + 1);
      else { j++; if (j >= rest.length) return false; val = rest[j]!; }
      if (!re.test(val)) return false;
    } else if (a.length > 1 && a[0] === "-") {
      const re = rule.valueRe.get(a);
      if (re) { j++; if (j >= rest.length || !re.test(rest[j]!)) return false; }
      else if (!(rule.short && onlyChars(a.slice(1), rule.short))) return false;
    } else {
      pos++;
      if (pos > (rule.maxPos ?? 0) || !rule.posRe.test(a) || hasDotDot(a)) return false;
      if (rule.paths && !lexicalPathOk(a, rule.paths === "content")) return false;
    }
  }
  return true;
}

export function classifyShell(argv: string[]): ShellVerdict {
  if (argv.length === 0 || argv.length > rules.limits.maxArgs) return deny("argv", `argv must have 1..${rules.limits.maxArgs} items`);
  for (const a of argv) {
    if (Buffer.byteLength(a) > rules.limits.maxArgLen || a.includes("\u0000") || a.includes("�")) {
      return deny("argv", "argument is too long, not UTF-8, or contains NUL");
    }
  }
  const name = baseName(argv);
  if (name === null) return deny("argv0", `executable must be a bare name or live directly in ${rules.execDirs.join(", ")}`);
  const args = argv.slice(1);
  const denied = denyVerdict(name, args);
  if (denied) return denied;
  for (const rule of byBin.get(name) ?? []) if (matches(rule, args)) return { class: "read", rule: rule.id };
  return { class: "write", rule: "default", reason: "not covered by a read rule" };
}
