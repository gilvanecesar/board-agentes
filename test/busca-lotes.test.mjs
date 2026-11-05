// The task index on a slow embeddings provider (#270: ollama on the CPU). A full batch outlived the per-request deadline,
// `indexar` saved only at the end, and every search lost ~38 s to fall back to words, forever. Uses a fake ollama whose
// answer takes longer the bigger the batch; busca.mjs runs from a copy, because its data/ sits beside the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FONTE = process.env.BOARD_TESTE_FONTE || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarefas = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `tarefa ${i + 1}`, text: "backup da madrugada", project: "p" }));

/** Fake /api/embed: `msPorTexto` per text in the batch; `quebraDepois` = answers 500 once that many texts were embedded. */
async function ollamaFalso({ msPorTexto = 0, quebraDepois = Infinity } = {}) {
  const lotes = [];
  const srv = createServer((req, res) => {
    let corpo = "";
    req.on("data", (x) => { corpo += x; });
    req.on("end", () => {
      const lista = [].concat(JSON.parse(corpo).input);
      lotes.push(lista.length);
      const feitos = lotes.reduce((s, n) => s + n, 0);
      setTimeout(() => {
        if (feitos > quebraDepois) { res.writeHead(500, { "content-type": "application/json" }); return res.end('{"error":"quebrou"}'); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ embeddings: lista.map(() => [1, 0, 0]) }));
      }, lista.length * msPorTexto);
    });
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return { lotes, url: `http://127.0.0.1:${srv.address().port}`, fechar: () => { srv.closeAllConnections(); srv.close(); } };
}

/** Runs `corpo` (a module body with `buscar`, `indexar` and `tarefas` in scope) in a copy of busca.mjs; returns what it prints. */
function rodar(pasta, url, prazoS, n, corpo) {
  copyFileSync(join(FONTE, "busca.mjs"), join(pasta, "busca.mjs"));
  writeFileSync(join(pasta, "tarefas.json"), JSON.stringify(tarefas(n)));
  writeFileSync(join(pasta, "r.mjs"), `import { readFileSync } from "fs";
import { buscar, indexar } from "./busca.mjs";
const tarefas = JSON.parse(readFileSync(new URL("./tarefas.json", import.meta.url)));
${corpo}`);
  return new Promise((ok, ruim) => execFile(process.execPath, [join(pasta, "r.mjs")], {
    env: { ...process.env, BOARD_BUSCA_PROVEDOR: "ollama", BOARD_OLLAMA_URL: url, BOARD_BUSCA_TIMEOUT_S: String(prazoS) }, timeout: 60000,
  }, (e, saida, erro) => (e ? ruim(new Error(erro || e.message)) : ok(JSON.parse(saida)))));
}
const nova = () => mkdtempSync(join(tmpdir(), "busca-lotes-"));
const indice = (pasta) => JSON.parse(readFileSync(join(pasta, "data", "embeddings.json"), "utf8")).itens;

test("provedor lento: a busca termina por sentido e grava o índice, sem cair na procura por palavra", async () => {
  const o = await ollamaFalso({ msPorTexto: 40 }); // 32 textos = 1,3 s; 8 = 0,32 s, ainda acima do prazo de 0,25 s
  const pasta = nova();
  try {
    const r = await rodar(pasta, o.url, 0.25, 40, `console.log(JSON.stringify(await buscar("backup", tarefas, { limite: 3 })));`);
    assert.equal(r.modo, "semantica", r.aviso);
    assert.equal(Object.keys(indice(pasta)).length, 40);
    assert.ok(Math.max(...o.lotes) > 4, "começa com o lote inteiro e só divide quando estoura o prazo");
  } finally { o.fechar(); }
});

test("texto que sozinho estoura o prazo desiste: cai na palavra e diz por quê, sem repetir para sempre", async () => {
  const o = await ollamaFalso({ msPorTexto: 400 });
  try {
    const r = await rodar(nova(), o.url, 0.1, 2, `console.log(JSON.stringify(await buscar("backup", tarefas, { limite: 3 })));`);
    assert.equal(r.modo, "lexico");
    assert.match(r.aviso, /demorou mais de/);
    assert.deepEqual(o.lotes, [2, 1], "2 → metades → o 1º texto sozinho falha e para");
  } finally { o.fechar(); }
});

test("indexação cortada no meio guarda o que fez e a próxima calcula só o resto", async () => {
  const quebra = await ollamaFalso({ quebraDepois: 16 });
  const pasta = nova();
  try {
    const r = await rodar(pasta, quebra.url, 5, 40, `console.log(JSON.stringify(await indexar(tarefas)));`);
    assert.equal(r.novos, 16);
    assert.match(r.erro, /quebrou/);
    assert.equal(Object.keys(indice(pasta)).length, 16);
  } finally { quebra.fechar(); }
  const boa = await ollamaFalso();
  try {
    const r = await rodar(pasta, boa.url, 5, 40, `console.log(JSON.stringify(await indexar(tarefas)));`);
    assert.deepEqual(r, { novos: 24, total: 40, erro: null });
    assert.equal(boa.lotes.reduce((s, n) => s + n, 0), 24);
  } finally { boa.fechar(); }
});

test("duas indexações juntas calculam cada tarefa uma vez só", async () => {
  const o = await ollamaFalso({ msPorTexto: 5 });
  const pasta = nova();
  try {
    const r = await rodar(pasta, o.url, 5, 20, `console.log(JSON.stringify(await Promise.all([indexar(tarefas), indexar(tarefas)])));`);
    assert.deepEqual(r.map((x) => x.novos), [20, 0]);
    assert.equal(o.lotes.reduce((s, n) => s + n, 0), 20);
    assert.ok(existsSync(join(pasta, "data", "embeddings.json")));
  } finally { o.fechar(); }
});

test("índice que não grava é erro de busca: indexar não rejeita, com ou sem tarefa a calcular, e a busca cai na palavra", async () => {
  const o = await ollamaFalso();
  const pasta = nova();
  mkdirSync(join(pasta, "data", "embeddings.json.tmp"), { recursive: true }); // um diretório no lugar do .tmp: writeFile dá EISDIR
  try {
    const r = await rodar(pasta, o.url, 5, 3, `console.log(JSON.stringify({
      semNada: await indexar([]), comTarefas: await indexar(tarefas), busca: await buscar("backup", tarefas, { limite: 3 }) }));`);
    assert.match(r.semNada.erro, /EISDIR/, "nada a calcular também grava");
    assert.match(r.comTarefas.erro, /EISDIR/);
    assert.equal(r.busca.modo, "lexico");
    assert.match(r.busca.aviso, /EISDIR/);
  } finally { o.fechar(); }
});
