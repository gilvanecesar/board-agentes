// #345: o menu Sessões entulhado de "robo saiu". A robo roda num laço que sobe um claude NOVO (sessionId novo) a cada
// saída, e o board lembra de cada uma por 7 dias. Aqui: as que saíram com o mesmo nome e pasta de uma viva não viram aba
// (vão para "anteriores"), sem viva só a mais recente de cada nome fica à vista, "saiu há X" vem da data gravada, e o
// 🧹 Limpar encerradas (só pela tela) esquece as que saíram sem tocar na viva, na trazida nem no transcrito.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => {
  for (const { b, caixa, filho, nav } of atual) { nav?.fechar?.(); try { filho?.kill("SIGKILL"); } catch { /* saiu */ } await b?.fim(); limparCaixa(caixa); }
  atual = [];
});

const H = 3600000;
const ha = (ms) => new Date(Date.now() - ms).toISOString();
const ROBO_VIVA = "robo-viva-0000001";

async function preparar() {
  const caixa = criarCaixa();
  const demo = criarProjeto(caixa, "demo");
  // A memória que o board já tinha: 5 robos que saíram (pids repetidos entre reinícios, como no Atena), 2 erp, 1 trazida.
  const vistas = {};
  for (let i = 0; i < 5; i++) vistas[`robo-saiu-000000${i}`] = { pid: i < 2 ? 3999901 : 3999910 + i, nome: "robo", nomeDado: true, cwd: demo, vista: ha((i + 1) * H) };
  vistas["erp-velha-0000001"] = { pid: 3999921, nome: "erp", nomeDado: true, cwd: demo, vista: ha(30 * H) };
  vistas["erp-nova-00000001"] = { pid: 3999922, nome: "erp", nomeDado: true, cwd: demo, vista: ha(3 * H) };
  vistas["trazida-000000001"] = { pid: 3999923, nome: "crm", nomeDado: true, cwd: demo, vista: ha(5 * H), trazida: { slug: "demo", label: "demo", em: ha(4 * H) } };
  // A robo viva agora (o laço subiu outra). Vista há 50 s: o board só regrava a "vista" depois de 1 min, então a saída
  // dela tem de ser a hora em que o board notou, não a última vez vista.
  const filho = spawn("sleep", ["120"], { stdio: "ignore" });
  vistas[ROBO_VIVA] = { pid: filho.pid, nome: "robo", nomeDado: true, cwd: demo, vista: ha(50000) };
  mkdirSync(join(caixa.board, "data"), { recursive: true });
  const arqVistas = join(caixa.board, "data", "sessoes-vistas.json");
  writeFileSync(arqVistas, JSON.stringify(vistas));
  // Um transcrito de uma robo que saiu: limpar não pode apagar.
  const tdir = join(caixa.home, ".claude", "projects", "-demo"); mkdirSync(tdir, { recursive: true });
  const transcrito = join(tdir, "robo-saiu-0000000.jsonl"); writeFileSync(transcrito, JSON.stringify({ type: "user", message: { content: "oi" } }) + "\n");
  const regDir = join(caixa.home, ".claude", "sessions"); mkdirSync(regDir, { recursive: true });
  const reg = join(regDir, `${filho.pid}.json`);
  writeFileSync(reg, JSON.stringify({ pid: filho.pid, sessionId: ROBO_VIVA, cwd: demo, entrypoint: "cli", kind: "interactive", name: "robo", status: "idle" }));
  const b = await subirBoard(caixa);
  const ctx = { caixa, demo, filho, reg, b, arqVistas, transcrito };
  ctx.sair = async () => { const foi = new Promise((ok) => filho.once("exit", ok)); filho.kill("SIGKILL"); await foi; rmSync(reg, { force: true }); };
  atual.push(ctx);
  return ctx;
}
const lista = async (b) => (await b.api("GET", "/api/sessoes?fresco")).json;
const limpar = (b, headers = { origin: b.url }) =>
  fetch(`${b.url}/api/sessoes/limpar-encerradas`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

test("encerradas: com a viva, as de mesmo nome e pasta vão para 'anteriores'; sem viva, só a mais recente; a data de saída é gravada", async () => {
  const { b, arqVistas, sair } = await preparar();
  const d = await lista(b);
  assert.deepEqual(d.sessoes.map((s) => s.nome), ["robo"], "a robo viva");
  assert.deepEqual(d.encerradas.map((s) => [s.nome, s.sessionId]), [["erp", "erp-nova-00000001"]], "nenhuma robo que saiu vira aba; do erp, só a mais recente");
  assert.equal(d.anteriores.length, 6);
  assert.deepEqual(d.anteriores.filter((s) => s.nome === "robo").map((s) => s.anterior), Array(5).fill("viva"));
  assert.deepEqual(d.anteriores.filter((s) => s.nome === "erp").map((s) => [s.sessionId, s.anterior]), [["erp-velha-0000001", "recente"]]);
  assert.ok(d.anteriores.every((s) => /^\d{4}-\d\d-\d\dT/.test(s.saiu) && s.reabrir), "cada uma com a data e o comando de reabrir");
  assert.ok(!JSON.stringify(d.encerradas.concat(d.anteriores)).includes("trazida-000000001"), "a trazida fica na lista dela");
  const v0 = JSON.parse(readFileSync(arqVistas, "utf8"));
  assert.equal(v0["erp-nova-00000001"].saiu, v0["erp-nova-00000001"].vista, "board fora do ar quando saiu: vale a última vez vista viva");
  assert.equal(v0[ROBO_VIVA].saiu, undefined, "a viva não tem saída");

  // A robo viva sai: a saída é gravada na hora, e agora ela é a mais recente da robo (as outras seguem em anteriores).
  const antes = Date.now();
  await sair();
  const d2 = await lista(b);
  const saiu = JSON.parse(readFileSync(arqVistas, "utf8"))[ROBO_VIVA].saiu;
  assert.ok(Date.parse(saiu) >= antes - 1000, "saiu = agora, não vazio: " + saiu);
  assert.deepEqual(d2.encerradas.map((s) => s.sessionId).sort(), [ROBO_VIVA, "erp-nova-00000001"].sort());
  assert.equal(d2.anteriores.filter((s) => s.nome === "robo").length, 5);
  assert.ok(d2.anteriores.filter((s) => s.nome === "robo").every((s) => s.anterior === "recente"));
});

test("🧹 limpar encerradas: só pela tela; esquece as que saíram sem tocar na viva, na trazida nem no transcrito", async () => {
  const { b, caixa, arqVistas, transcrito, filho } = await preparar();
  await lista(b);
  assert.equal((await limpar(b, {})).status, 403, "sem o Origin da tela (CLI, curl de agente)");
  assert.equal((await limpar(b, { origin: "http://mal.example" })).status, 403);
  assert.equal(Object.keys(JSON.parse(readFileSync(arqVistas, "utf8"))).length, 9, "recusado não muda nada");
  const r = await limpar(b);
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.esquecidas, 7);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(arqVistas, "utf8"))).sort(), [ROBO_VIVA, "trazida-000000001"].sort());
  assert.ok(existsSync(transcrito), "o histórico do Claude fica");
  assert.equal(filho.exitCode, null); assert.equal(filho.signalCode, null);
  const d = await lista(b);
  assert.deepEqual(d.sessoes.map((s) => s.nome), ["robo"]);
  assert.equal(d.encerradas.length + d.anteriores.length, 0);
  assert.deepEqual(d.trazidas.map((t) => t.nome), ["crm"]);
  const log = readFileSync(join(caixa.board, "data", "logs", "sessoes.jsonl"), "utf8");
  assert.match(log, /"t":"esqueceu","quantas":7,"quem":"dono \(tela\)"/);
});

test("tela: uma aba por nome, 'anteriores (N)' recolhido que abre no clique, 'saiu há X', e o 🧹 limpa", { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
  const ctx = await preparar();
  const { b } = ctx;
  const nav = ctx.nav = await abrirNavegador();
  await nav.carregar(b.url + "/#/sessoes");
  const espera = async (expr, oque) => { for (let i = 0; i < 80; i++) { if (await nav.avaliar(expr)) return; await esperar(150); } throw new Error("a tela não mostrou: " + oque + "\n" + await nav.avaliar(`document.querySelector('#app')?.innerText`)); };
  await espera(`!!document.querySelector('#sesAnteriores')`, "as anteriores");
  const abas = await nav.avaliar(`[...document.querySelectorAll('.ses-abas .ses-aba')].map((a) => a.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.equal(abas.length, 2, "a robo viva e o erp: " + JSON.stringify(abas));
  assert.match(abas[0], /^robo/); assert.match(abas[1], /erp.*saiu há 3 h/);
  assert.equal(await nav.avaliar(`document.querySelector('#sesAnteriores summary').innerText`), "anteriores (6)");
  assert.equal(await nav.avaliar(`document.querySelector('#sesAnteriores').open`), false, "recolhido");
  assert.equal(await nav.avaliar(`document.querySelector('[data-ses-ant]').checkVisibility()`), false, "fechado, as anteriores não aparecem");
  await nav.avaliar(`document.querySelector('#sesAnteriores summary').click()`);
  await espera(`document.querySelector('[data-ses-ant]')?.checkVisibility()`, "as anteriores abertas");
  const ants = await nav.avaliar(`[...document.querySelectorAll('[data-ses-ant]')].map((a) => a.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.equal(ants.length, 6); assert.match(ants[0], /robo.*saiu há 1 h/); assert.ok(ants.some((a) => /erp.*saiu há 30 h|erp.*saiu há 1 dia/.test(a)), JSON.stringify(ants));
  // Escolher uma anterior com o pid repetido abre a dela, não a primeira com aquele pid.
  await nav.avaliar(`document.querySelector('[data-ses-ant="robo-saiu-0000001"]').click()`);
  await espera(`document.querySelector('.ses-reabrir')?.innerText.includes('saiu há 2 h')`, "a sessão escolhida, com 'saiu há 2 h'");
  // O redesenho a cada 5 s não fecha o recolhido nem troca a escolha.
  await esperar(5600);
  assert.equal(await nav.avaliar(`document.querySelector('#sesAnteriores').open`), true);
  assert.ok(await nav.avaliar(`document.querySelector('.ses-reabrir').innerText.includes('saiu há 2 h')`));
  await nav.avaliar(`document.querySelector('#sesLimpar').click()`);
  await espera(`!document.querySelector('#sesAnteriores') && document.querySelectorAll('.ses-abas .ses-aba').length === 1`, "só a viva depois de limpar");
  assert.ok(nav.dialogos.some((m) => /Esquecer as 7 sessões/.test(m)), JSON.stringify(nav.dialogos));
  assert.equal(await nav.avaliar(`!!document.querySelector('#sesLimpar')`), false, "sem encerradas, sem botão");
  assert.deepEqual(nav.erros, []);
});
