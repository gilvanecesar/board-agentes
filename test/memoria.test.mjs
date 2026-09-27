// Memory tests: the actions that CHANGE the shared memory — the only part of the board that destroys data.
// Inventory (count, address the new ones, discard, ignore, merge, apply) and the addressing review (move, confirm,
// approve), with a fake memory server that does to the mirror what the real one does to the memory.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c, n] of atual) { if (n) await n.fechar(); await b.fim(); limparCaixa(c); } atual = []; });

function pagina(caixa, projeto, id, { titulo, descricao = "", corpo = "", modificada = "2026-09-20T10:00:00Z", pasta = "" }) {
  const dir = join(caixa.raiz, "memoria", projeto, pasta); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + ".md"), `---\nname: ${id}\ndescription: ${descricao}\nmetadata:\n  modified: '${modificada}'\n---\n\n# ${titulo}\n\n${corpo}\n`);
}
async function preparar({ cenario = {} } = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo"); caixa.cenario(cenario);
  const repetido = "O token do servidor de memoria fica no arquivo de ambiente do usuario e nunca entra no git nem no log do board.";
  pagina(caixa, "demo", "token-a", { titulo: "Token da memória", descricao: "onde fica o token", corpo: repetido });
  pagina(caixa, "demo", "token-b", { titulo: "Token do servidor de memória", descricao: "onde fica o token", corpo: repetido });
  pagina(caixa, "demo", "sessao-velha", { titulo: "Sessão de trabalho", pasta: "sessions", modificada: "2026-08-01T10:00:00Z", corpo: "resumo" });
  pagina(caixa, "demo", "sem-endereco", { titulo: "Deploy do banco novo", descricao: "o deploy do banco usa migração antes", corpo: "migração e deploy do banco" });
  pagina(caixa, "_global", "respostas-curtas", { titulo: "Respostas curtas", descricao: "o dono quer respostas curtas", corpo: "Veredito primeiro." });
  for (let i = 0; i < 5; i++) pagina(caixa, "demo", "nota-" + i, { titulo: "Nota " + i, descricao: ["nginx na frente", "boleto e pix", "fila no redis", "app na loja", "landing com contato"][i], corpo: "nada mais" });
  const end = (mente) => ({ mente, confianca: "alta", tambem: [] });
  const mapa = { "demo/token-a": end("engenharia"), "demo/token-b": end("engenharia"), "demo/sessao-velha": end("engenharia"), "_global/respostas-curtas": end("dono") };
  for (let i = 0; i < 5; i++) mapa["demo/nota-" + i] = end("engenharia");
  writeFileSync(join(caixa.board, "data", "mentes.json"), JSON.stringify({ status: "aprovada", mapa, nucleoDono: ["_global/respostas-curtas"], mentePorProjeto: { demo: "engenharia" } }));
  const b = await subirBoard(caixa);
  atual.push([b, caixa]);
  return { caixa, b };
}
const post = (b, acao, corpo = {}) => b.api("POST", "/api/memoria/inventario/" + acao, corpo);
const memLog = (caixa) => existsSync(join(caixa.home, "ai-memory.log")) ? readFileSync(join(caixa.home, "ai-memory.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const arg = (a, f) => a[a.indexOf(f) + 1];
const mentes = (caixa) => JSON.parse(readFileSync(join(caixa.board, "data", "mentes.json"), "utf8"));

test("inventário: acha as novas sem mente, as repetidas e as vencidas — e contar não muda nada", async () => {
  const { caixa, b } = await preparar();
  const inv = (await post(b, "rodar")).json;
  assert.deepEqual(inv.novas.map((x) => x.chave), ["demo/sem-endereco"]);
  assert.ok(inv.repetidas.some((r) => r.chaves.includes("demo/token-a") && r.chaves.includes("demo/token-b")));
  assert.ok(inv.vencidas.some((v) => v.chave === "demo/sessao-velha"));
  assert.deepEqual(memLog(caixa), [], "contar não chama o servidor de memória");
});

test("descartar: só o que o inventário apontou; apaga na memória, guarda cópia, sai do endereçamento", async () => {
  const { caixa, b } = await preparar();
  await post(b, "rodar");
  const fora = await post(b, "descartar", { chave: "demo/token-a" });
  assert.equal(fora.status, 400, "página que o inventário NÃO apontou não se apaga");
  assert.deepEqual(memLog(caixa), [], "…e nada foi chamado");
  const r = await post(b, "descartar", { chave: "demo/sessao-velha" });
  assert.equal(r.status, 200, r.txt);
  const [chamada] = memLog(caixa);
  assert.equal(chamada[0], "delete-page");
  assert.equal(arg(chamada, "--project"), "demo");
  assert.equal(arg(chamada, "--path"), "sessions/sessao-velha.md");
  assert.ok(!existsSync(join(caixa.raiz, "memoria", "demo", "sessions", "sessao-velha.md")), "saiu da memória");
  assert.match(readFileSync(join(caixa.board, "data", "inventario-descartadas", "demo_sessao-velha.md"), "utf8"), /Sessão de trabalho/, "cópia para desfazer à mão");
  assert.ok(!mentes(caixa).mapa["demo/sessao-velha"], "saiu do endereçamento");
  const inv = (await b.api("GET", "/api/memoria/inventario")).json;
  assert.ok(inv.feitos.some((f) => f.acao === "descartada" && f.chaves[0] === "demo/sessao-velha"));
  assert.ok(!inv.vencidas.some((v) => v.chave === "demo/sessao-velha"));
});

test("ignorar ('não são' / 'manter'): sai da lista e NÃO volta na próxima contagem", async () => {
  const { b } = await preparar();
  await post(b, "rodar");
  await post(b, "ignorar", { chaves: ["demo/token-a", "demo/token-b"] });
  await post(b, "ignorar", { chave: "demo/sessao-velha" });
  const inv = (await post(b, "rodar")).json;
  assert.ok(!inv.repetidas.some((r) => r.chaves.includes("demo/token-a")));
  assert.ok(!inv.vencidas.some((v) => v.chave === "demo/sessao-velha"));
});

test("juntar: a IA só PROPÕE (nada muda); aplicar grava a versão única na 1ª e apaga as outras", async () => {
  const { caixa, b } = await preparar({ cenario: { juntar: "# Token da memória\n\nFica no arquivo de ambiente do usuário; nunca no git nem no log." } });
  await post(b, "rodar");
  assert.equal((await post(b, "juntar", { chaves: ["demo/nota-0", "demo/nota-1"] })).status, 400, "grupo que o inventário não apontou");
  const p = (await post(b, "juntar", { chaves: ["demo/token-a", "demo/token-b"] })).json;
  assert.equal(p.titulo, "Token da memória");
  assert.equal(p.custo, 0.03);
  assert.deepEqual(memLog(caixa), [], "propor não mexe na memória");
  const ia = JSON.parse(readFileSync(join(caixa.home, "chamadas.jsonl"), "utf8").trim().split("\n").find((l) => l.includes('"juntar"')));
  assert.equal(arg(ia.args, "--model"), "sonnet"); assert.equal(arg(ia.args, "--tools"), ""); assert.ok(ia.args.includes("--strict-mcp-config"), "a IA do juntar não tem ferramenta nem MCP");
  assert.equal((await post(b, "aplicar", { id: "nao-existe" })).status, 400);
  const r = await post(b, "aplicar", { id: p.id });
  assert.equal(r.status, 200, r.txt);
  const [grava, apaga] = memLog(caixa);
  assert.equal(grava[0], "write-page"); assert.equal(arg(grava, "--path"), "token-a.md"); assert.match(arg(grava, "--body"), /nunca no git nem no log/);
  assert.equal(apaga[0], "delete-page"); assert.equal(arg(apaga, "--path"), "token-b.md");
  assert.ok(existsSync(join(caixa.raiz, "memoria", "demo", "token-a.md")) && !existsSync(join(caixa.raiz, "memoria", "demo", "token-b.md")));
  assert.ok((await b.api("GET", "/api/memoria/inventario")).json.feitos.some((f) => f.acao === "juntadas"));
});

test("juntar quando a IA diz que NÃO são o mesmo assunto: nada a aplicar", async () => {
  const { caixa, b } = await preparar({ cenario: { juntar: "NAO_JUNTAR: uma fala do token do servidor, a outra do token do usuário" } });
  await post(b, "rodar");
  const p = (await post(b, "juntar", { chaves: ["demo/token-a", "demo/token-b"] })).json;
  assert.match(p.naoJuntar, /token do usuário/);
  assert.equal((await post(b, "aplicar", { id: p.id })).status, 400, "não há versão única para aplicar");
  assert.deepEqual(memLog(caixa), []);
});

test("endereçar novas: entram como 'média' — o romaneio NÃO as usa e a aprovação espera o dono conferir", async () => {
  const { caixa, b } = await preparar();
  await post(b, "rodar");
  const r = (await post(b, "enderecar-novas")).json;
  assert.equal(r.enderecadas, 1);
  const item = mentes(caixa).mapa["demo/sem-endereco"];
  assert.equal(item.mente, "engenharia", "a pista 'deploy/banco' escolheu a mente");
  assert.equal(item.confianca, "media");
  const previa = (await b.api("GET", "/api/romaneio/previa?projeto=demo&texto=" + encodeURIComponent("deploy do banco com migração"))).json;
  assert.ok(!(previa.itens || []).some((i) => i.chave === "demo/sem-endereco"), "proposta não conferida não vai para agente nenhum");
  const aprovar = await b.api("POST", "/api/memoria/mentes/aprovar", {});
  assert.equal(aprovar.status, 400, "com memória por conferir, não aprova");
  assert.match(aprovar.json.error, /faltam 1/);
  await b.api("POST", "/api/memoria/mentes/conferir", { chave: "demo/sem-endereco" });
  assert.equal(mentes(caixa).mapa["demo/sem-endereco"].confianca, "dono");
  assert.equal((await b.api("POST", "/api/memoria/mentes/aprovar", {})).status, 200);
  const depois = (await b.api("GET", "/api/romaneio/previa?projeto=demo&texto=" + encodeURIComponent("deploy do banco com migração"))).json;
  assert.ok(depois.itens.some((i) => i.chave === "demo/sem-endereco"), "conferida, passa a ir");
});

test("mover de mente: mente inválida é recusada; mover tira a aprovação até o dono aprovar de novo", async () => {
  const { caixa, b } = await preparar();
  assert.equal((await b.api("POST", "/api/memoria/mentes/mover", { chave: "demo/nota-0", mente: "inventada" })).status, 400);
  assert.equal((await b.api("POST", "/api/memoria/mentes/mover", { chave: "demo/nao-existe", mente: "design" })).status, 404);
  const r = await b.api("POST", "/api/memoria/mentes/mover", { chave: "demo/nota-0", mente: "design" });
  assert.equal(r.status, 200);
  const m = mentes(caixa);
  assert.equal(m.mapa["demo/nota-0"].mente, "design"); assert.equal(m.mapa["demo/nota-0"].antes, "engenharia");
  assert.equal(m.status, "proposta", "mexeu no endereçamento: precisa aprovar de novo");
  assert.equal((await b.api("GET", "/api/romaneio/previa?projeto=demo&texto=deploy")).json.vazio, true, "sem aprovação, sem romaneio");
});

test("tela do inventário: descartar pede confirmação; juntar mostra a versão única ANTES de aplicar", { skip: !CHROME && "sem Chrome" }, async () => {
  const { caixa, b } = await preparar({ cenario: { juntar: "# Token da memória\n\nVersão **única** proposta." } });
  const nav = await abrirNavegador(); atual[atual.length - 1].push(nav);
  await post(b, "rodar");
  await nav.carregar(b.url + "/?a=1");
  await nav.avaliar(`localStorage.setItem("board.tab", JSON.stringify("memoria")); localStorage.setItem("board.memoriaModo", JSON.stringify("galpao"))`);
  await nav.carregar(b.url + "/?b=1"); await nav.quieto({ min: 600 });
  const ate = async (expr) => { for (let i = 0; i < 80; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("não chegou: " + expr); };
  await ate(`!!document.querySelector('[data-inv-quase="demo/sessao-velha"]')`);
  await nav.avaliar(`document.querySelector('[data-inv-quase="demo/sessao-velha"]').click()`);
  await ate(`!!document.querySelector('[data-inv-descartar="demo/sessao-velha"]')`);
  assert.deepEqual(memLog(caixa), [], "o 1º clique só pede confirmação");
  await nav.avaliar(`document.querySelector('[data-inv-descartar="demo/sessao-velha"]').click()`);
  for (let i = 0; i < 50 && !memLog(caixa).length; i++) await esperar(100);
  assert.equal(memLog(caixa)[0]?.[0], "delete-page", "o 2º clique apaga");
  await ate(`!!document.querySelector('[data-inv-juntar]')`);
  await nav.avaliar(`document.querySelector('[data-inv-juntar]').click()`);
  await ate(`!!document.querySelector('[data-inv-aplicar]')`);
  assert.ok(await nav.avaliar(`[...document.querySelectorAll(".inv-prev strong")].some((e) => e.textContent === "única")`), "a proposta aparece, em markdown");
  assert.equal(memLog(caixa).length, 1, "ver a proposta não aplica nada");
  assert.deepEqual(nav.erros, []);
});
