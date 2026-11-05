// Projeto renomeado (#250, 29/10: a pasta do CRM ganhou o nome `crm`). O estado mora em memória e o
// servidor regrava o data/board.json, então mexer no arquivo por fora não adianta: quem troca é o próprio board ao subir.
// O dono escreve `"renomeados": {"<slug antigo>": "<slug novo>"}` no data/projetos.json, renomeia a pasta e dá ↻.
// Idempotente: rodar de novo não muda nada. Não mexe em pasta de projeto, cópia ⚡ nem transcrito (isso é à mão, com
// a sessão parada); só no que é do board: estado, data/*.json e os logs com o slug no nome.
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";

const lerJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const gravarJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

/** O mapa {antigo: novo} do data/projetos.json, só com slugs válidos e diferentes. */
export function lerRenomeados(dataDir) {
  const m = (lerJson(join(dataDir, "projetos.json")) || {}).renomeados || {};
  return Object.entries(m).filter(([de, para]) => /^[\w.-]+$/.test(de) && /^[\w.-]+$/.test(para) && de !== para);
}

/** Troca a chave `de` por `para` num objeto, sem passar por cima de uma que já existe. */
function trocarChave(obj, de, para) {
  if (!obj || typeof obj !== "object" || !(de in obj) || para in obj) return false;
  const novo = {};
  for (const [k, v] of Object.entries(obj)) novo[k === de ? para : k] = v; // mantém a ordem
  for (const k of Object.keys(obj)) delete obj[k];
  Object.assign(obj, novo);
  return true;
}

/** O estado (tarefas, conversas, publicações, cópias). Devolve quantas coisas mudaram. */
export function renomearNoEstado(state, pares, devDir) {
  let n = 0;
  for (const [de, para] of pares) {
    for (const t of state.tasks || []) {
      if (t.project === de) { t.project = para; n++; }
      if (t.projetoSugerido === de) { t.projetoSugerido = para; n++; }
      if (t.worktree?.dir) {
        const antes = t.worktree.dir;
        t.worktree.dir = antes.replace(new RegExp(`/\\.board-agentes/${de.replace(/\./g, "\\.")}-(\\d+)`), `/.board-agentes/${para}-$1`);
        if (t.worktree.dir !== antes) n++;
      }
      if (t.publicado?.slug === de) { t.publicado.slug = para; n++; }
    }
    if (trocarChave(state.conversas, de, para)) n++;
    if (trocarChave(state.publicacoes, de, para)) n++;
    const pub = state.publicacoes?.[para];
    if (pub && devDir && pub.dir === join(devDir, de)) { pub.dir = join(devDir, para); n++; }
  }
  return n;
}

/** Os arquivos do board com o slug: data/*.json e os logs `conversa-<slug>` e `publicar-<slug>`. */
export function renomearNosArquivos(dataDir, pares, devDir) {
  const feitos = [];
  for (const [de, para] of pares) {
    const proj = lerJson(join(dataDir, "projetos.json"));
    if (proj) {
      let mudou = false;
      if (Array.isArray(proj.visiveis) && proj.visiveis.includes(de)) {
        proj.visiveis = proj.visiveis.includes(para) ? proj.visiveis.filter((s) => s !== de) : proj.visiveis.map((s) => (s === de ? para : s));
        mudou = true;
      }
      mudou = trocarChave(proj.rotulos, de, para) || mudou;
      if (mudou) { gravarJson(join(dataDir, "projetos.json"), proj); feitos.push("projetos.json"); }
    }
    for (const [arq, onde] of [["publicar.json", (j) => j], ["portao.json", (j) => j], ["deploy.json", (j) => j],
      ["permissoes.json", (j) => j.regras], ["mentes.json", (j) => j.mentePorProjeto]]) {
      const j = lerJson(join(dataDir, arq));
      if (j && trocarChave(onde(j), de, para)) { gravarJson(join(dataDir, arq), j); feitos.push(arq); }
    }
    const vistas = lerJson(join(dataDir, "sessoes-vistas.json"));
    if (vistas && devDir) {
      const velho = join(devDir, de), novo = join(devDir, para);
      let mudou = false;
      for (const v of Object.values(vistas)) if (v && v.cwd === velho) { v.cwd = novo; mudou = true; }
      if (mudou) { gravarJson(join(dataDir, "sessoes-vistas.json"), vistas); feitos.push("sessoes-vistas.json"); }
    }
    for (const pre of ["conversa", "publicar"]) {
      const a = join(dataDir, "logs", `${pre}-${de}.jsonl`), b = join(dataDir, "logs", `${pre}-${para}.jsonl`);
      if (existsSync(a) && !existsSync(b)) { renameSync(a, b); feitos.push(`logs/${pre}-${para}.jsonl`); }
    }
  }
  return feitos;
}
