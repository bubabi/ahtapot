import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-objectivec";
import "prismjs/components/prism-java";
import "prismjs/components/prism-scala";
import "prismjs/components/prism-kotlin";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-dart";
import "prismjs/components/prism-go";
import "prismjs/components/prism-protobuf";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-swift";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-graphql";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-makefile";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-hcl";
import "prismjs/components/prism-elixir";
import "prismjs/components/prism-haskell";
import "prismjs/components/prism-zig";
import "prismjs/components/prism-nix";
import "prismjs/components/prism-r";
import "prismjs/components/prism-powershell";
import { DiffLine, Hunk } from "./diff";

/** Larger inputs render uncolored; Prism tokenizes on the UI thread. */
export const HIGHLIGHT_LIMIT = 400_000;

export interface Tok {
  text: string;
  cls: string;
}

const BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript",
  jsx: "jsx", tsx: "tsx", json: "json", jsonc: "json", json5: "json", css: "css", scss: "scss", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", plist: "markup",
  md: "markdown", mdx: "markdown", rs: "rust", py: "python", pyi: "python", bzl: "python", star: "python",
  go: "go", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objectivec", mm: "objectivec",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", cs: "csharp", dart: "dart", swift: "swift",
  rb: "ruby", php: "php", sh: "bash", bash: "bash", zsh: "bash", fish: "bash", yml: "yaml", yaml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", conf: "ini", sql: "sql", graphql: "graphql", gql: "graphql", lua: "lua",
  proto: "protobuf", tf: "hcl", hcl: "hcl", ex: "elixir", exs: "elixir", hs: "haskell", zig: "zig", nix: "nix",
  r: "r", ps1: "powershell", mk: "makefile",
};

const BY_NAME: Record<string, string> = {
  makefile: "makefile", gnumakefile: "makefile", dockerfile: "docker", containerfile: "docker",
  build: "python", "build.bazel": "python", workspace: "python", "workspace.bazel": "python", "module.bazel": "python",
  ".bazelrc": "ini", ".gitconfig": "ini", ".editorconfig": "ini", ".zshrc": "bash", ".bashrc": "bash", ".profile": "bash",
  gemfile: "ruby", rakefile: "ruby", "cargo.lock": "toml",
};

export function languageFor(path: string): string | null {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  const lang = BY_NAME[name] ?? BY_EXT[name.includes(".") ? name.split(".").pop()! : ""];
  return lang && Prism.languages[lang] ? lang : null;
}

function flatten(tokens: (string | Prism.Token)[], cls: string, out: Tok[]) {
  for (const t of tokens) {
    if (typeof t === "string") {
      out.push({ text: t, cls });
      continue;
    }
    const aliases = t.alias ? (Array.isArray(t.alias) ? t.alias : [t.alias]) : [];
    const next = [cls, `t-${t.type}`, ...aliases.map((a) => `t-${a}`)].join(" ").trim();
    if (typeof t.content === "string") out.push({ text: t.content, cls: next });
    else flatten(Array.isArray(t.content) ? t.content : [t.content], next, out);
  }
}

function tokenLines(text: string, lang: string): Tok[][] {
  const flat: Tok[] = [];
  flatten(Prism.tokenize(text, Prism.languages[lang]), "", flat);
  const lines: Tok[][] = [[]];
  for (const tok of flat) {
    const parts = tok.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, cls: tok.cls });
    });
  }
  return lines;
}

/** Tokens for each of `lines`, tokenized as one block. */
export function highlightLines(lines: string[], lang: string): Tok[][] {
  return tokenLines(lines.join("\n"), lang);
}

/** Tokens per diff line. Each hunk side is tokenized as one block so multi-line strings and comments carry over. */
export function highlightHunks(hunks: Hunk[], lang: string): Map<DiffLine, Tok[]> {
  const out = new Map<DiffLine, Tok[]>();
  for (const hunk of hunks) {
    for (const side of ["old", "new"] as const) {
      const lines = hunk.lines.filter((l) => l.kind === "ctx" || l.kind === (side === "old" ? "del" : "add"));
      const toks = tokenLines(lines.map((l) => l.text).join("\n"), lang);
      lines.forEach((line, i) => {
        if (line.kind !== "ctx" || side === "new") out.set(line, toks[i] ?? []);
      });
    }
  }
  return out;
}
