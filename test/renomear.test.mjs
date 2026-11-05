// Projeto renomeado (#250): `renomeados` no data/projetos.json troca o slug no estado e nos arquivos do board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { lerRenomeados, renomearNoEstado, renomearNosArquivos } from "../servidor/renomear.mjs";

const ler = (f) => JSON.parse(readFileSync(f, "utf8"));

test("renomear: o slug antigo vira o novo no quadro, sem passar por cima do que já existe", () => {
  const state = {
    tasks: [
      { id: 1, project: "velho", worktree: { dir: "/d/DEV/.board-agentes/velho-1" } },
      { id: 2, project: "ERP", projetoSugerido: "velho", worktree: { dir: "/d/DEV/.board-agentes/ERP-2" } },
      { id: 3, project: "velho-dev", publicado: { slug: "velho" } },
    ],
    conversas: { board: { s: 1 }, velho: { s: 2 } },
    publicacoes: { velho: { ok: true, dir: "/d/DEV/velho" } },
  };
  const n = renomearNoEstado(state, [["velho", "novo"]], "/d/DEV");
  assert.equal(n, 7);
  assert.deepEqual(state.tasks.map((t) => t.project), ["novo", "ERP", "velho-dev"]); // velho-dev é OUTRO slug
  assert.equal(state.tasks[0].worktree.dir, "/d/DEV/.board-agentes/novo-1");
  assert.equal(state.tasks[1].projetoSugerido, "novo");
  assert.deepEqual(Object.keys(state.conversas), ["board", "novo"]); // a ordem fica
  assert.deepEqual(state.publicacoes, { novo: { ok: true, dir: "/d/DEV/novo" } });
  assert.equal(state.tasks[2].publicado.slug, "novo");
  assert.equal(renomearNoEstado(state, [["velho", "novo"]], "/d/DEV"), 0, "idempotente");
  const dois = { tasks: [], conversas: { velho: 1, novo: 2 } };
  renomearNoEstado(dois, [["velho", "novo"]]);
  assert.deepEqual(dois.conversas, { velho: 1, novo: 2 }, "fio que já existe no slug novo não é sobrescrito");
});

test("renomear: data/*.json, sessões vistas e logs com o slug no nome", () => {
  const data = mkdtempSync(join(tmpdir(), "renomear-")), logs = join(data, "logs");
  mkdirSync(logs);
  writeFileSync(join(data, "projetos.json"), JSON.stringify({ visiveis: ["ERP", "velho", "board"], rotulos: { velho: "CRM" }, renomeados: { velho: "novo", "a b": "x", igual: "igual" } }));
  writeFileSync(join(data, "publicar.json"), JSON.stringify({ velho: { comando: "deploy" }, ERP: "x" }));
  writeFileSync(join(data, "permissoes.json"), JSON.stringify({ regras: { velho: ["Monitor"] } }));
  writeFileSync(join(data, "mentes.json"), JSON.stringify({ mentePorProjeto: { velho: "comercial" }, temas: {} }));
  writeFileSync(join(data, "sessoes-vistas.json"), JSON.stringify({ s1: { cwd: "/d/DEV/velho" }, s2: { cwd: "/d/DEV/velho-x" } }));
  writeFileSync(join(logs, "conversa-velho.jsonl"), "{}\n");
  writeFileSync(join(logs, "publicar-velho.jsonl"), "{}\n");
  const pares = lerRenomeados(data);
  assert.deepEqual(pares, [["velho", "novo"]], "só slug válido e diferente");
  renomearNosArquivos(data, pares, "/d/DEV");
  assert.deepEqual(ler(join(data, "projetos.json")).visiveis, ["ERP", "novo", "board"]);
  assert.deepEqual(ler(join(data, "projetos.json")).rotulos, { novo: "CRM" });
  assert.deepEqual(Object.keys(ler(join(data, "publicar.json"))), ["novo", "ERP"]);
  assert.deepEqual(ler(join(data, "permissoes.json")).regras, { novo: ["Monitor"] });
  assert.deepEqual(ler(join(data, "mentes.json")).mentePorProjeto, { novo: "comercial" });
  assert.deepEqual(ler(join(data, "sessoes-vistas.json")), { s1: { cwd: "/d/DEV/novo" }, s2: { cwd: "/d/DEV/velho-x" } });
  assert.ok(existsSync(join(logs, "conversa-novo.jsonl")) && !existsSync(join(logs, "conversa-velho.jsonl")));
  assert.ok(existsSync(join(logs, "publicar-novo.jsonl")));
  assert.deepEqual(renomearNosArquivos(data, pares, "/d/DEV"), [], "idempotente");
});
