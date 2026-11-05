import { lstatSync, readFileSync, realpathSync, statSync } from "fs";
import { join, resolve } from "path";
/**
 * Onde o git escreve para esta pasta — o que o sandbox do Codex precisa liberar.
 * Pasta comum: `<dir>/.git`. ⚠️ Worktree (toda tarefa ⚡ e toda tarefa de produção, em
 * `.board-agentes/`): ali `.git` é um ARQUIVO "gitdir: …/.git/worktrees/<nome>", e o index, o
 * FETCH_HEAD e os objetos ficam FORA da pasta. Liberar só `<dir>/.git` deixava o Codex sem commit
 * nem push — a tarefa #188 (CRM) terminou o conserto e não conseguiu entregar (09/10/2026,
 * "sem permissão para escrever em crm/.git/worktrees/crm-188/FETCH_HEAD").
 */
export function pastasGit(dir) {
  const ponto = join(dir, ".git");
  try {
    if (statSync(ponto).isDirectory()) return [ponto];
    const gitdir = resolve(dir, readFileSync(ponto, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() || "");
    const pastas = [gitdir];
    try { pastas.push(resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim())); } catch { /* sem commondir */ }
    return [...new Set(pastas)];
  } catch {
    return [ponto];
  }
}

/**
 * Tudo que o sandbox do Codex precisa liberar além da pasta: o git (acima) e, na cópia, o
 * `node_modules` — lá ele é um LINK para o da pasta principal (`criarCopia`), e o Vite/Vitest
 * escrevem em `node_modules/.vite-temp`. Sem isso, `npm test` e `vite build` morriam com EPERM
 * antes de rodar (#188, 09/10/2026), e o agente não conseguia provar o próprio conserto.
 */
export function pastasGravaveis(dir) {
  const pastas = pastasGit(dir);
  const nm = join(dir, "node_modules");
  try { if (lstatSync(nm).isSymbolicLink()) pastas.push(realpathSync(nm)); } catch { /* sem node_modules */ }
  return [...new Set(pastas)];
}
