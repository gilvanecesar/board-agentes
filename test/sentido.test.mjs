// Picking by MEANING: the picking list finds a memory the request describes with other words; without the embeddings
// provider it falls back to words and SAYS so; the index is incremental. Uses a fake embeddings server (see ajuda.mjs).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus, chamadas, servidorDeSentido, portaLivre } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const f of atual) await f(); atual = []; });

const CONCEITOS = ["pix|webhook|idempot|notifica|repetid|em dobro|duas vezes|pagou", "tela|layout|css|estilo", "backup|copia de seguranca|restaur"];
function pagina(caixa, projeto, id, titulo, corpo) {
  const dir = join(caixa.raiz, "memoria", projeto); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + ".md"), `---\nname: ${id}\ndescription: ${titulo}\n---\n\n# ${titulo}\n\n${corpo}\n`);
}
async function preparar({ ollama = true, env = {}, cenario = {} } = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "loja"); caixa.cenario(cenario);
  pagina(caixa, "loja", "pix-idempotente", "Webhook do Pix tem que ser idempotente", "Processar o mesmo aviso duas vezes dava baixa em dobro; a chave do pedido evita.");
  pagina(caixa, "loja", "css-global", "Classe global de css quebra telas", "Mudar o estilo global desalinhou o layout de várias telas.");
  pagina(caixa, "loja", "backup-noturno", "Backup do banco toda madrugada", "O backup roda de madrugada e o restaur foi testado.");
  for (let i = 0; i < 4; i++) pagina(caixa, "loja", "nota-" + i, "Nota " + i, "assunto qualquer " + i);
  pagina(caixa, "_global", "respostas-curtas", "Respostas curtas", "o dono quer respostas curtas");
  const mapa = { "_global/respostas-curtas": { mente: "dono", confianca: "alta" } };
  for (const k of ["pix-idempotente", "css-global", "backup-noturno", "nota-0", "nota-1", "nota-2", "nota-3"]) mapa["loja/" + k] = { mente: "engenharia", confianca: "alta" };
  writeFileSync(join(caixa.board, "data", "mentes.json"), JSON.stringify({ status: "aprovada", mapa, nucleoDono: ["_global/respostas-curtas"], mentePorProjeto: { loja: "engenharia" } }));
  let fake = null;
  if (ollama) { fake = await servidorDeSentido(CONCEITOS); atual.push(() => fake.fechar().catch(() => {})); }
  const url = fake ? fake.url : `http://127.0.0.1:${await portaLivre()}`; // porta fechada = "ollama fora do ar"
  const b = await subirBoard(caixa, { BOARD_BUSCA_PROVEDOR: "ollama", BOARD_OLLAMA_URL: url, ...env });
  atual.push(async () => { await b.fim(); limparCaixa(caixa); });
  return { caixa, b, fake };
}
const PEDIDO = "o cliente pagou e a compra ficou travada porque a notificação chegou repetida";
const previa = async (b, extra = "") => (await b.api("GET", `/api/romaneio/previa?projeto=loja&texto=${encodeURIComponent(PEDIDO)}${extra}`)).json;
async function comSentido(b) { for (let i = 0; i < 50; i++) { const r = await previa(b); if (r.modo === "palavra+sentido") return r; await esperar(200); } return previa(b); }

test("pedido com OUTRAS palavras: o sentido acha a memória que a palavra não acha", async () => {
  const { b } = await preparar();
  const r = await comSentido(b);
  assert.equal(r.modo, "palavra+sentido");
  const achou = r.itens.find((i) => i.chave === "loja/pix-idempotente");
  assert.ok(achou, "a memória do Pix foi pelo sentido");
  assert.ok(achou.sentido > 0.9, "com a parecença registrada");
  assert.ok(!r.itens.some((i) => i.chave === "loja/css-global" || i.chave === "loja/backup-noturno"), "o que não tem a ver não vai");
  const soPalavra = await previa(b, "&modo=palavra");
  assert.equal(soPalavra.vazio || !soPalavra.itens.some((i) => i.chave === "loja/pix-idempotente"), true, "só por palavra ela ficava de fora");
});

test("sem o provedor de sentido: vai só por palavra — e diz por quê", async () => {
  const { b } = await preparar({ ollama: false });
  const r = await b.api("GET", "/api/romaneio/previa?projeto=loja&texto=" + encodeURIComponent("webhook do pix idempotente"));
  assert.equal(r.json.modo, "palavra");
  assert.match(r.json.semSentido, /não consegui falar|sendo montado/);
  assert.ok(r.json.itens.some((i) => i.chave === "loja/pix-idempotente"), "a palavra continua achando o que ela acha");
});

test("o ollama cai DEPOIS do índice pronto: a tarefa segue só por palavra, sem erro, e diz por quê", async () => {
  const { b, fake } = await preparar({ env: { BOARD_ROMANEIO: "1" }, cenario: { agente: ["ok"] } });
  await comSentido(b);
  await fake.fechar();
  const r = (await b.api("GET", "/api/romaneio/previa?projeto=loja&texto=" + encodeURIComponent("webhook do pix"))).json;
  assert.equal(r.modo, "palavra");
  assert.match(r.semSentido, /não consegui falar/);
  const [t] = (await b.api("POST", "/api/tasks", { text: "webhook do pix idempotente", project: "loja", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", "o sentido fora do ar não derruba a tarefa");
  const ev = (await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.find((e) => e.t === "romaneio");
  assert.equal(ev.modo, "palavra");
});

test("índice pela metade: não finge que usou o sentido", async () => {
  const { caixa, b } = await preparar();
  await comSentido(b);
  for (let i = 0; i < 6; i++) pagina(caixa, "loja", "nova-" + i, "Página nova " + i, "chegou agora " + i); // 8 → 14 páginas
  const mentes = JSON.parse(readFileSync(join(caixa.board, "data", "mentes.json"), "utf8"));
  for (let i = 0; i < 6; i++) mentes.mapa["loja/nova-" + i] = { mente: "engenharia", confianca: "alta" };
  writeFileSync(join(caixa.board, "data", "mentes.json"), JSON.stringify(mentes));
  await b.api("POST", "/api/memoria/inventario/rodar"); // relê a memória
  const idx = join(caixa.board, "data", "embeddings-memoria.json");
  const r = await previa(b); // a 1ª consulta dispara a indexação das novas; esta ainda vê o índice pela metade
  if (r.modo === "palavra") assert.match(r.semSentido, /sendo montado \(\d+ de 14\)/);
  for (let i = 0; i < 30 && Object.keys(JSON.parse(readFileSync(idx, "utf8")).itens).length < 14; i++) await esperar(200);
  const fim = await previa(b);
  assert.equal(fim.modo, "palavra+sentido", "completo de novo, o sentido volta: " + JSON.stringify({ semSentido: fim.semSentido, idx: Object.keys(JSON.parse(readFileSync(idx, "utf8")).itens).length }));
});

test("configurado só por palavra: o aviso diz ISSO (não que o índice está sendo montado)", async () => {
  const { b } = await preparar({ env: { BOARD_BUSCA_PROVEDOR: "lexico" } });
  const r = (await b.api("GET", "/api/romaneio/previa?projeto=loja&texto=" + encodeURIComponent("webhook do pix"))).json;
  assert.equal(r.modo, "palavra");
  assert.match(r.semSentido, /configurado para buscar só por palavra/);
});

test("a tarefa leva o romaneio por sentido e o 📦 registra o modo", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_ROMANEIO: "1" }, cenario: { agente: ["ok"] } });
  await comSentido(b); // índice pronto
  const [t] = (await b.api("POST", "/api/tasks", { text: PEDIDO, project: "loja", queue: true })).json.tasks;
  await esperarStatus(b, t.id, "executada");
  const p = chamadas(caixa).find((c) => c.papel === "agente").args[1];
  assert.match(p, /Webhook do Pix tem que ser idempotente/, "o agente recebeu a memória certa");
  const ev = (await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.find((e) => e.t === "romaneio");
  assert.equal(ev.modo, "palavra+sentido");
  assert.ok(ev.itens.some((i) => i.chave === "loja/pix-idempotente" && i.sentido > 0.9));
});

test("índice incremental: só a memória que mudou é recalculada", async () => {
  const { caixa, b, fake } = await preparar();
  await comSentido(b);
  const antes = fake.estado.textos;
  pagina(caixa, "loja", "css-global", "Classe global de css quebra telas", "Texto NOVO: mudar o estilo global quebrou o layout.");
  await b.api("POST", "/api/memoria/inventario/rodar"); // relê a memória (o cache do grafo é de 60 s)
  for (let i = 0; i < 30 && fake.estado.textos - antes < 2; i++) { await previa(b); await esperar(200); }
  const novos = fake.estado.textos - antes;
  const idx = JSON.parse(readFileSync(join(caixa.board, "data", "embeddings-memoria.json"), "utf8"));
  assert.equal(Object.keys(idx.itens).length, 8, "todas as memórias no índice");
  assert.ok(novos <= 1 + 1 * 4 && novos >= 2, `recalculou só a que mudou (+ os pedidos da prévia): ${novos} textos`);
});
