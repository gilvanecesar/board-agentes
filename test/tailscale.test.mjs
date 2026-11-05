// O board pelo Tailscale (#238): o `tailscale serve` repassa do loopback, com o Host do endereço *.ts.net e o login do
// dono em `Tailscale-User-Login` (medido em 28/10 com o serve real). Aqui se prova que a tela por esse endereço vale como
// a tela local SÓ quando ele está na lista `BOARD_ORIGENS_EXTRAS`, e que Origin de fora continua 403 sempre.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { daTela, hostDaMaquina, origensExtras, viaTailnet } from "../servidor/origem.mjs";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";

const TS = "https://mac.tailabc.ts.net";
const HOST_TS = "mac.tailabc.ts.net";

// Um pedido de mentira no formato que o servidor HTTP recebe.
const pedido = ({ origin, host = "127.0.0.1:4488", remoto = "127.0.0.1", login } = {}) =>
  ({ headers: { ...(origin ? { origin } : {}), host, ...(login ? { "tailscale-user-login": login } : {}) }, socket: { remoteAddress: remoto } });

function comEnv(vars, fn) {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test("Origem: sem a lista, só a tela local; o endereço do Tailscale e qualquer outro site são recusados", () => comEnv({ BOARD_ORIGENS_EXTRAS: undefined, BOARD_TAILSCALE_LOGINS: undefined }, () => {
  assert.equal(daTela(pedido({ origin: "http://127.0.0.1:4488" })), true);
  assert.equal(daTela(pedido({ origin: "http://localhost:4488", host: "localhost:4488" })), true);
  assert.equal(daTela(pedido({})), false, "sem Origin (CLI, curl de agente) não é a tela");
  assert.equal(daTela(pedido({ origin: TS, host: HOST_TS })), false, "Tailscale sem estar na lista");
  assert.equal(daTela(pedido({ origin: "https://evil.example" })), false);
  // DNS rebinding: a página de fora aponta o nome dela para 127.0.0.1 — Origin e Host batem, mas o Host não é local.
  assert.equal(daTela(pedido({ origin: "http://evil.example:4488", host: "evil.example:4488" })), false);
  assert.equal(hostDaMaquina(pedido({ host: HOST_TS })), false);
  assert.equal(hostDaMaquina(pedido({})), true);
}));

test("Origem: com a lista, o endereço do Tailscale vale — só com o Host dele, do loopback e (se pedido) com o login do dono", () => comEnv({ BOARD_ORIGENS_EXTRAS: `${TS}, https://*.ts.net, https://x.ts.net/caminho, lixo`, BOARD_TAILSCALE_LOGINS: undefined }, () => {
  assert.deepEqual(origensExtras(), [TS], "curinga, caminho e endereço inválido não entram na lista");
  assert.equal(daTela(pedido({ origin: TS, host: HOST_TS })), true);
  assert.equal(daTela(pedido({ origin: TS, host: `${HOST_TS}:443` })), true, "porta padrão no Host é o mesmo endereço");
  assert.equal(daTela(pedido({ origin: TS.toUpperCase(), host: HOST_TS.toUpperCase() })), true);
  assert.equal(daTela(pedido({ origin: TS, host: "127.0.0.1:4488" })), false, "Origin do Tailscale com Host de outro endereço");
  assert.equal(daTela(pedido({ origin: TS, host: `${HOST_TS}:8443` })), false, "outra porta é outro endereço");
  assert.equal(daTela(pedido({ origin: TS, host: HOST_TS, remoto: "100.116.1.2" })), false, "fora do loopback: não veio pelo serve");
  assert.equal(daTela(pedido({ origin: "http://mac.tailabc.ts.net", host: HOST_TS })), false, "http no lugar de https");
  assert.equal(daTela(pedido({ origin: "https://outro.tailabc.ts.net", host: "outro.tailabc.ts.net" })), false);
  assert.equal(daTela(pedido({ origin: "https://evil.example", host: HOST_TS })), false);
  assert.equal(daTela(pedido({ origin: "http://127.0.0.1:4488" })), true, "a tela local continua valendo");
  assert.equal(hostDaMaquina(pedido({ host: HOST_TS })), true);
  assert.equal(hostDaMaquina(pedido({ host: "evil.example" })), false);
  comEnv({ BOARD_TAILSCALE_LOGINS: "dono@exemplo.com" }, () => {
    assert.equal(daTela(pedido({ origin: TS, host: HOST_TS, login: "Dono@Exemplo.com" })), true);
    assert.equal(daTela(pedido({ origin: TS, host: HOST_TS, login: "outro@exemplo.com" })), false, "outro usuário da tailnet");
    assert.equal(daTela(pedido({ origin: TS, host: HOST_TS })), false, "nó com tag (o serve não manda login)");
    assert.equal(viaTailnet(pedido({ host: HOST_TS })), false);
    assert.equal(daTela(pedido({ origin: "http://127.0.0.1:4488" })), true, "a lista de logins não mexe na tela local");
  });
}));

// ── com o board inteiro ─────────────────────────────────────────────────────
let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar(env = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa");
  caixa.cenario({ conversa: ["ok", "ok", "ok", "ok"] });
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
// Como o `tailscale serve` entrega: Host do *.ts.net e o Origin que o navegador do celular manda (o fetch não deixa trocar o Host).
const pedir = (b, metodo, rota, { origin, host = HOST_TS, corpo } = {}) => new Promise((ok, bad) => {
  const dados = corpo ? JSON.stringify(corpo) : "";
  const r = request({ host: "127.0.0.1", port: b.porta, method: metodo, path: rota,
    headers: { host, ...(origin ? { origin } : {}), ...(dados ? { "content-type": "application/json", "content-length": Buffer.byteLength(dados) } : {}) } }, (res) => {
    let txt = ""; res.on("data", (d) => (txt += d));
    res.on("end", () => { let json = null; try { json = JSON.parse(txt); } catch { /* não é JSON */ } ok({ status: res.statusCode, json }); });
  });
  r.on("error", bad); r.end(dados);
});
const ROTAS = [
  ["POST", "/api/permissoes/0123456789ab", { acao: "uma" }],   // cartão de permissão (#232)
  ["POST", "/api/publicar/alfa", { confirmo: "x" }],           // 🚀 publicar (#205)
  ["POST", "/api/sessoes/1/teclas", { teclas: ["Enter"] }],    // teclas das Sessões (#233)
  ["POST", "/api/navegador/sempre", { dominio: "exemplo.com" }], // "sempre pode" do navegador (#217)
];

test("Board pelo Tailscale: configurado, o endereço *.ts.net passa as barreiras; Origin de fora continua 403", async () => {
  const { b } = await preparar({ BOARD_ORIGENS_EXTRAS: TS });
  for (const [m, rota, corpo] of ROTAS) {
    const r = await pedir(b, m, rota, { origin: TS, corpo });
    assert.notEqual(r.status, 403, `${rota} pelo Tailscale configurado: ${JSON.stringify(r.json)}`);
    const fora = await pedir(b, m, rota, { origin: "https://evil.example", corpo });
    assert.equal(fora.status, 403, `${rota} com Origin de fora`);
    const semOrigin = await pedir(b, m, rota, { corpo });
    assert.equal(semOrigin.status, 403, `${rota} sem Origin (CLI/curl) continua fora`);
  }
  assert.equal((await pedir(b, "GET", "/api/sessoes")).status, 200, "o terminal das sessões abre pelo endereço do Tailscale");
  assert.equal((await pedir(b, "GET", "/api/sessoes", { host: "evil.example:4488" })).status, 403, "Host de fora (DNS rebinding)");
  // O SIM digitado na Central pelo celular ganha o id da aprovação (#213); o mesmo texto com Origin de fora, não.
  const sim = await pedir(b, "POST", "/api/conversa/central", { origin: TS, corpo: { texto: "oi" } });
  assert.equal(sim.status, 202);
  assert.match(String(sim.json.aprovacao), /^[0-9a-f]{12}$/);
  for (let i = 0; i < 60 && (await b.api("GET", "/api/state")).json.conversas?.central?.busy; i++) await esperar(150);
  const fora = await pedir(b, "POST", "/api/conversa/central", { origin: "https://evil.example", corpo: { texto: "oi" } });
  assert.equal(fora.json?.aprovacao ?? null, null, "Origin de fora não vira aprovação");
});

test("Board pelo Tailscale: sem BOARD_ORIGENS_EXTRAS o endereço *.ts.net é recusado em todas as barreiras", async () => {
  const { b } = await preparar({ BOARD_ORIGENS_EXTRAS: null });
  for (const [m, rota, corpo] of ROTAS) assert.equal((await pedir(b, m, rota, { origin: TS, corpo })).status, 403, rota);
  assert.equal((await pedir(b, "GET", "/api/sessoes")).status, 403);
  const sim = await pedir(b, "POST", "/api/conversa/central", { origin: TS, corpo: { texto: "oi" } });
  assert.equal(sim.json?.aprovacao ?? null, null);
  // A tela local segue de pé.
  assert.notEqual((await pedir(b, "POST", ROTAS[0][1], { origin: b.url, host: `127.0.0.1:${b.porta}`, corpo: ROTAS[0][2] })).status, 403);
});

test("Board pelo Tailscale: com BOARD_TAILSCALE_LOGINS, só o login do dono que o serve informa passa", async () => {
  const { b } = await preparar({ BOARD_ORIGENS_EXTRAS: TS, BOARD_TAILSCALE_LOGINS: "dono@exemplo.com" });
  const [m, rota, corpo] = ROTAS[0];
  assert.equal((await pedir(b, m, rota, { origin: TS, corpo })).status, 403, "sem o login do serve");
});
