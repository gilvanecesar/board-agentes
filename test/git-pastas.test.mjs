// Onde o git escreve — o que o sandbox do Codex libera (#188, 09/10/2026). Repositório e worktree
// de verdade numa pasta temporária; não toca em nada do dono.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pastasGit, pastasGravaveis } from "../servidor/git-pastas.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe" });

test("pasta comum: só o .git dela", () => {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "pg-")));
  git(raiz, "init", "-q");
  assert.deepEqual(pastasGit(raiz), [join(raiz, ".git")]);
});

test("⚠️ worktree: o gitdir da worktree E o .git comum (index, FETCH_HEAD e objetos ficam fora da pasta)", () => {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "pg-")));
  const repo = join(raiz, "repo");
  execFileSync("mkdir", [repo]);
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const wt = join(raiz, "wt");
  git(repo, "worktree", "add", "-q", wt);
  assert.deepEqual(pastasGit(wt), [join(repo, ".git", "worktrees", "wt"), join(repo, ".git")]);
});

test("⚠️ cópia com node_modules em LINK: libera o node_modules real (Vite/Vitest escrevem em .vite-temp)", () => {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "pg-")));
  const repo = join(raiz, "repo");
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  const wt = join(raiz, "wt");
  git(repo, "worktree", "add", "-q", wt);
  symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
  assert.deepEqual(pastasGravaveis(wt), [join(repo, ".git", "worktrees", "wt"), join(repo, ".git"), join(repo, "node_modules")]);
  assert.deepEqual(pastasGravaveis(repo), [join(repo, ".git")], "node_modules de verdade já está dentro da pasta: nada a acrescentar");
});

test("pasta sem git: devolve o caminho de sempre, sem quebrar", () => {
  const raiz = realpathSync(mkdtempSync(join(tmpdir(), "pg-")));
  assert.deepEqual(pastasGit(raiz), [join(raiz, ".git")]);
});
