// O que os dois arquivos da vigia dos PRs dividem (#279): o GitHub falso, a tarefa com PR e a espera pela marca da vigia.
// `gh` falso: lê $HOME/gh-prs-dono_alfa-<state>.json (o teste troca o arquivo para o GitHub "mudar") e anota tudo em $HOME/gh.log.
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chamadas, criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";

let atual = [];
export const faxina = async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; };

export const URL_ = (n) => `https://github.com/dono/alfa/pull/${n}`;
export const PR = (n, extra = {}) => ({ number: n, title: `PR ${n}`, url: URL_(n), headRefName: `board/${n}-x`, author: { login: "dono" },
  createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-23T10:00:00Z", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "",
  statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }], ...extra });
export const CONFLITO = { mergeable: "CONFLICTING" };
export const MESCLADOS = [{ number: 80, title: "velho", url: URL_(80), headRefName: "b", mergedAt: "2026-10-20T10:00:00Z" },
  { number: 90, title: "novo", url: URL_(90), headRefName: "b", mergedAt: "2026-10-29T10:00:00Z" },
  { number: 85, title: "meio", url: URL_(85), headRefName: "b", mergedAt: "2026-10-25T10:00:00Z" }];

export const github = (caixa, abertos) => writeFileSync(join(caixa.home, "gh-prs-dono_alfa-open.json"), JSON.stringify(abertos));
export const ghLog = (caixa) => existsSync(join(caixa.home, "gh.log")) ? readFileSync(join(caixa.home, "gh.log"), "utf8") : "";
export const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
export const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
export const agentes = (caixa) => chamadas(caixa).filter((c) => c.papel === "agente").map((c) => ({ ...c, prompt: c.args[c.args.indexOf("-p") + 1] }));

/** Sobe a vigia só com o PR saudável; a tarefa termina executada com o PR; quem chama muda o GitHub depois. */
export async function preparar({ env = {}, entrega = "pr", cenario, antes } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa");
  execFileSync("git", ["-C", join(caixa.dev, "alfa"), "remote", "add", "origin", "git@github.com:dono/alfa.git"]);
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa"], rotulos: { alfa: "Alfa" } }));
  writeFileSync(join(caixa.board, "data", "portao.json"), JSON.stringify({ alfa: "" }));
  github(caixa, [PR(12)]);
  writeFileSync(join(caixa.home, "gh-prs-dono_alfa-merged.json"), JSON.stringify(MESCLADOS));
  caixa.cenario(cenario || { agente: [{ texto: `abri ${URL_(12)}`, escreve: { arquivo: "a.txt" } }], revisor: [{ texto: "APROVADO" }], qa: [{ texto: "APROVADO" }] });
  antes?.(caixa);
  const b = await subirBoard(caixa, { BOARD_PR_VIGIA_S: "1", BOARD_PR_CARENCIA_S: "0", ...env });
  atual.push([b, caixa]);
  const [t] = (await b.api("POST", "/api/tasks", { text: "tarefa com PR", project: "alfa", queue: true, entrega })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(fim.prUrl, URL_(12));
  return { caixa, b, id: t.id };
}
export const conserto = (texto = `atualizei ${URL_(12)}`) => ({ agente: [{ texto, escreve: { arquivo: "merge.txt", conteudo: `${Date.now()}\n` } }], revisor: [{ texto: "APROVADO" }], qa: [{ texto: "APROVADO" }] });
export const esperarVigia = async (b, id, estado, limite = 15000) => {
  const t0 = Date.now(); let t;
  while (Date.now() - t0 < limite) { t = await tarefa(b, id); if ((t.prVigia?.estado || null) === estado) return t; await esperar(150); }
  throw new Error(`prVigia não chegou em ${estado}: ${JSON.stringify(t?.prVigia)} status ${t?.status}\n${b.saida().slice(-2000)}`);
};
