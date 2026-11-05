// O navegador dos agentes (#217): um Chrome próprio (perfil na caixa), controlado pelo board por CDP, com páginas FALSAS
// servidas aqui — nada sai da máquina. A TRAVA é a REDE (decisão do dono, "resolva o erro de uma vez por todas"): o site
// falso REGISTRA tudo o que recebe, e os testes provam que NADA de escrita ou de ação chega a ele sem aprovação — por
// formulário, input submit, button form=, label for, botão dentro de <a>, <area>, fetch, sendBeacon, location.href,
// worker, aba nova e WebSocket — e que, com o SIM conferido pela #213 (ou "sempre pode" do dono), a requisição passa.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:http";
import { writeFileSync, readFileSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => {
  for (const [b, c, site] of atual) { try { await b?.api("POST", "/api/navegador/fechar", {}); } catch { /* já caiu */ } await b?.fim(); limparCaixa(c); site?.close(); }
  atual = [];
});
const semChrome = !CHROME && "sem Chrome nesta máquina";

const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>Site falso</title></head><body>
<h1>Postagem</h1>
<label for="leg">Legenda</label><input id="leg">
<input type="file" id="arq" style="display:none">
<div id="info">sem arquivo</div>
<button id="mais" onclick="document.getElementById('info2').textContent='mais aberto'">Ver mais</button><div id="info2"></div>
<button id="pub">Publicar agora</button>
<a id="rasc" href="/apagar/7">Excluir rascunho</a>
<form action="/postou-form" method="post"><button id="pub3" type="submit" style="position:absolute;left:-9999px">Publicar</button></form><label id="conf" for="pub3">Confirmar</label>
<a href="/delete-account"><button id="lk1" type="button">Seguir</button></a>
<a href="/share-it/2"><button type="button"><span id="lk2">Ir</span></button></a>
<img id="lk3" usemap="#m1" alt="mapa" width="60" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><map name="m1"><area shape="rect" coords="0,0,60,40" href="/delete-account" alt="x"></map>
<div role="link" id="lk4" data-href="/publicar-agora" tabindex="0" onclick="location.href=this.dataset.href">Abrir</div>
<div role="link" id="lk5" tabindex="0">Abrir outro</div>
<form action="/publicar-post" method="post"><button id="ok" type="submit">OK</button></form>
<form action="/delete-account" method="post"><input id="ok2" type="submit" value="Continuar"></form>
<form id="f9" action="/share-it" method="post"></form><button id="ok3" form="f9">Seguir</button>
<form action="/delete-account" method="post"><input type="hidden" name="action" value="x"><input type="hidden" name="getAttribute" value="y"><button id="ok4" type="submit">Continuar</button></form>
<form action="/delete-account" method="post" target="_blank"><button id="ok5" type="submit">Abrir em outra aba</button></form>
<a id="pop1" href="/delete-account" target="_blank">Abrir em nova aba</a>
<button id="pop2" onclick="window.open('/share-it/9')">Janela</button>
<button id="js1" onclick="fetch('/api/salvar',{method:'POST',body:'x'})">Salvar</button>
<button id="js2" onclick="navigator.sendBeacon('/coletar','x')">Beacon</button>
<button id="js3" onclick="location.href='/delete-account'">Sair daqui</button>
<button id="js4">Worker</button>
<button id="js5" onclick="try{new WebSocket('ws://'+location.host+'/ws');document.title='ws aberto'}catch(e){document.title='ws bloqueado'}">Socket</button>
<script>
js4.onclick = () => new Worker(URL.createObjectURL(new Blob(['fetch("' + location.origin + '/delete-account",{method:"POST"})'], { type: 'text/javascript' })));
arq.onchange = () => { const f = arq.files[0]; info.textContent = 'arquivo: ' + f.name + ' (' + f.size + ' bytes)'; };
pub.onclick = () => fetch('/postou', { method: 'POST', body: leg.value }).then(() => { document.title = 'publicado'; document.getElementById('info2').textContent = 'publicado!'; });
</script></body></html>`;

/** O site falso: serve a página em GET / e REGISTRA todo o resto que receber (método + endereço + corpo), inclusive WebSocket. */
async function siteFalso() {
  const st = { recebidas: [], postou: [], ws: 0 };
  const s = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/favicon.ico")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(req.url === "/" ? PAGINA : ""); }
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { st.recebidas.push(`${req.method} ${req.url}`); if (req.url === "/postou") st.postou.push(b); res.writeHead(200, { "content-type": "text/html" }); res.end("<p>feito</p>"); });
  });
  s.on("upgrade", (req, sock) => { st.ws++; st.recebidas.push("WS " + req.url); sock.destroy(); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${s.address().port}/`, st, close: () => s.close() };
}

async function preparar(conversa, env = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa");
  if (conversa) caixa.cenario({ conversa });
  const b = await subirBoard(caixa, { BOARD_NAVEGADOR_CHROME: CHROME, BOARD_NAVEGADOR_ARGS: "--use-mock-keychain --mute-audio --disable-audio-output", ...env });
  const site = await siteFalso();
  atual.push([b, caixa, site]);
  const nav = (acao, corpo = {}) => b.api("POST", "/api/navegador/" + acao, { quem: "teste", ...corpo });
  return { caixa, b, site, nav };
}
const registro = async (b) => (await b.api("GET", "/api/navegador")).json.registro;

/** Os casos que o QA usou e os que só a rede pega. `espera`: o que a porta tem de barrar (null = a página não manda nada). */
const CASOS = [
  ["#pub", "POST /postou"], ["#rasc", "GET /apagar/7"], ["#conf", "POST /postou-form"], ["#lk1", "GET /delete-account"],
  ["#lk2", "GET /share-it/2"], ["#lk3", "GET /delete-account"], ["#lk4", "GET /publicar-agora"], ["#ok", "POST /publicar-post"],
  ["#ok2", "POST /delete-account"], ["#ok3", "POST /share-it"], ["#ok4", "POST /delete-account"], ["#js1", "POST /api/salvar"],
  ["#js2", "POST /coletar"], ["#js3", "GET /delete-account"],
  // aba nova (form target=_blank, <a target=_blank>, window.open): fechada no nível do NAVEGADOR antes de mandar qualquer coisa
  ["#ok5", "ABA"], ["#pop1", "ABA"],
  // nada sai: window.open não abre; role=link sem destino; WebSocket bloqueado na página; worker que não aceita a porta
  // fica PARADO — fail-closed
  ["#pop2", null], ["#lk5", null], ["#js5", null], ["#js4", null],
];

test("Navegador: abre, lê, preenche, clica, SOBE ARQUIVO, espera e captura — perfil próprio 700, tudo no registro", { skip: semChrome }, async () => {
  const { caixa, b, site, nav } = await preparar();
  let r = await nav("abrir", { url: site.url });
  assert.equal(r.status, 200, r.txt); assert.equal(r.json.titulo, "Site falso");
  const perfil = join(caixa.home, ".board-navegador");
  assert.ok(existsSync(perfil), "o perfil nasce em ~/.board-navegador");
  assert.equal(statSync(perfil).mode & 0o777, 0o700, "o perfil é só do dono (700)");
  r = await nav("ler");
  assert.match(r.json.texto, /Postagem/); assert.ok(r.json.controles.some((c) => /Publicar agora/.test(c)), "lista os controles");
  r = await nav("ler", { modo: "arvore" });
  assert.match(r.json.arvore, /button: Publicar agora/);
  r = await nav("preencher", { rotulo: "Legenda", valor: "Radar de fretes" });
  assert.equal(r.status, 200, r.txt); assert.equal(r.json.preenchido, "Radar de fretes");
  r = await nav("clicar", { texto: "Ver mais" });
  assert.equal(r.status, 200, r.txt); assert.equal(r.json.aviso, null, "Ver mais não parece de risco");
  r = await nav("esperar", { texto: "mais aberto", ms: 3000 });
  assert.equal(r.json.achou, true);
  // Subir arquivo (o navegador do Latch não anexava — postar vídeo depende disto)
  const video = join(caixa.raiz, "radar.mp4"); writeFileSync(video, Buffer.alloc(1234, 7));
  r = await nav("subir", { arquivos: [video] });
  assert.equal(r.status, 200, r.txt); assert.equal(r.json.subidos[0].bytes, 1234);
  r = await nav("esperar", { texto: "arquivo: radar.mp4 (1234 bytes)", ms: 3000 });
  assert.equal(r.json.achou, true, "a página recebeu o arquivo pelo input type=file escondido");
  // Arquivo sensível não sobe
  mkdirSync(join(caixa.home, ".ssh"), { recursive: true }); writeFileSync(join(caixa.home, ".ssh", "id_ed25519"), "segredo");
  r = await nav("subir", { arquivos: [join(caixa.home, ".ssh", "id_ed25519")] });
  assert.equal(r.status, 403); assert.match(r.json.error, /não sobe/);
  r = await nav("esperar", { seletor: "#nao-existe", ms: 300 });
  assert.equal(r.status, 408);
  r = await nav("abrir", { url: "file:///etc/passwd" });
  assert.equal(r.status, 400, "file:// não abre (leria arquivo da máquina)");
  r = await b.api("POST", "/api/navegador/captura?png=1", { quem: "teste" });
  assert.equal(r.status, 200); assert.ok(existsSync(r.json.arquivo));
  assert.equal(readFileSync(r.json.arquivo).subarray(1, 4).toString(), "PNG");
  assert.ok(r.json.arquivo.startsWith(join(caixa.board, "data", "navegador", "capturas")), "captura em data/navegador/ (fora da cópia para o servidor)");
  const reg = await registro(b);
  for (const a of ["abrir", "ler", "preencher", "clicar", "subir", "esperar", "captura"]) assert.ok(reg.some((e) => e.acao === a && e.ok && e.quem === "teste"), "registrou " + a);
  assert.ok(reg.some((e) => e.acao === "subir" && !e.ok), "a recusa do arquivo sensível também fica no registro");
});

test("Navegador: a PORTA DA REDE barra toda escrita e toda ação sem aprovação — o servidor não recebe NADA", { skip: semChrome }, async () => {
  const { b, site, nav } = await preparar();
  for (const [sel, espera] of CASOS) {
    const ab = await nav("abrir", { url: site.url });
    assert.equal(ab.status, 200, "abrir de novo antes de " + sel + ": " + ab.txt);
    const r = await nav("clicar", { seletor: sel });
    if (espera) {
      assert.equal(r.status, 403, sel + ": " + r.txt); assert.equal(r.json.recusado, true, sel);
      if (espera === "ABA") { assert.ok(r.json.barradas.some((x) => x.metodo === "ABA"), sel + ": a aba nova foi fechada: " + r.txt); assert.match(r.json.error, /aba nova fechada/); continue; }
      const [metodo, caminho] = espera.split(" ");
      assert.ok(r.json.barradas.some((x) => x.metodo === metodo && new URL(x.url).pathname === caminho), `${sel}: a resposta diz QUAL requisição foi barrada (${espera}): ${r.txt}`);
      assert.match(r.json.error, new RegExp(metodo + " " + site.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/$/, "") + caminho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } else assert.notEqual(r.status, 500, sel + ": " + r.txt);
  }
  // o WebSocket não abriu (a página recebeu a recusa) e a aba nova não nasceu
  await nav("abrir", { url: site.url }); await nav("clicar", { seletor: "#js5" });
  assert.equal((await nav("ler")).json.titulo, "ws bloqueado");
  await esperar(500);
  assert.deepEqual(site.st.recebidas, [], "NADA chegou ao servidor sem aprovação");
  assert.equal(site.st.ws, 0);
  assert.ok((await registro(b)).some((e) => e.acao === "rede" && e.recusado && /^worker /.test(e.alvo) && /fica parada/.test(e.erro)), "o worker sem porta fica parado, e o registro diz");
  // id forjado: recusado na hora, antes de clicar
  let r = await nav("clicar", { seletor: "#pub", aprovacao: "abcdefabcdef", pedido: "publicar o vídeo no 127.0.0.1" });
  assert.equal(r.status, 403); assert.match(r.json.error, /não existe/);
  // "sempre pode" é do dono, na tela: sem o Origin dela, não
  r = await b.api("POST", "/api/navegador/sempre", { dominio: "127.0.0.1", metodo: "POST", caminho: "/postou" });
  assert.equal(r.status, 403);
  // página de outro site (CSRF) não manda no navegador logado
  const fora = await fetch(b.url + "/api/navegador/clicar", { method: "POST", headers: { "content-type": "text/plain", origin: "https://site-malicioso.example" }, body: JSON.stringify({ texto: "Ver mais" }) });
  assert.equal(fora.status, 403);
  // leitura limpa passa (o próprio abrir e o "Ver mais")
  assert.equal((await nav("clicar", { seletor: "#mais" })).status, 200);
  const reg = await registro(b);
  assert.ok(reg.some((e) => e.acao === "rede" && e.recusado && e.barrada?.caminho === "/postou" && e.barrada.metodo === "POST"), "a requisição barrada fica no registro, com domínio + método + caminho");
  assert.deepEqual(site.st.recebidas, []);
});

test("Navegador: com o SIM do dono na Central (conferido pela #213) a requisição PASSA — e só a que o pedido cobre", { skip: semChrome }, async () => {
  const PEDIDO = "Posso publicar?\n\nPEDIDO DE SIM: publicar o video do radar no site 127.0.0.1";
  const { b, site, nav } = await preparar([PEDIDO, "levando o sim"]);
  await b.api("POST", "/api/conversa/central", { texto: "publica o vídeo?" });
  for (let i = 0; i < 60; i++) { const ev = (await b.api("GET", "/api/conversa/central")).json.events; if (ev.some((e) => e.t === "resultado" && e.n === 1)) break; await esperar(150); }
  const sim = await fetch(b.url + "/api/conversa/central", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify({ texto: "SIM", cita: 1 }) });
  const id = (await sim.json()).aprovacao;
  assert.match(id, /^[0-9a-f]{12}$/);
  await nav("abrir", { url: site.url });
  await nav("preencher", { seletor: "#leg", valor: "radar" });
  // pedido que não diz o site: a conferência passa, mas a requisição não
  let r = await nav("clicar", { seletor: "#pub", aprovacao: id, pedido: "publicar o video do radar" });
  assert.equal(r.status, 403, r.txt); assert.match(r.json.error, /não diz o site|não cobre/);
  // o SIM a publicar não cobre apagar (GET /apagar/7)
  r = await nav("clicar", { seletor: "#rasc", aprovacao: id, pedido: "publicar o video do radar no site 127.0.0.1" });
  assert.equal(r.status, 403); assert.match(r.json.error, /não diz "excluir"/);
  assert.deepEqual(site.st.recebidas, [], "até aqui, nada chegou");
  await nav("abrir", { url: site.url }); await nav("preencher", { seletor: "#leg", valor: "radar" });
  r = await nav("clicar", { seletor: "#pub", aprovacao: id, pedido: "publicar o video do radar no site 127.0.0.1" });
  assert.equal(r.status, 200, r.txt);
  assert.ok(r.json.liberadas.some((x) => x.metodo === "POST" && /\/postou$/.test(x.url)), "a resposta diz o que passou com a aprovação");
  for (let i = 0; i < 30 && !site.st.postou.length; i++) await esperar(100);
  assert.deepEqual(site.st.postou, ["radar"], "com o SIM conferido, o POST chegou");
  assert.deepEqual(site.st.recebidas, ["POST /postou"]);
  const reg = await registro(b);
  assert.ok(reg.some((e) => e.acao === "rede" && e.ok && e.aprovacao === id && /POST .*\/postou/.test(e.alvo)), "o registro diz qual requisição passou e com que aprovação");
});

test("Navegador: \"sempre pode\" por domínio + método + caminho, só pela tela, libera aquela requisição — e só ela", { skip: semChrome }, async () => {
  const { b, site, nav } = await preparar();
  const sempre = (corpo) => fetch(b.url + "/api/navegador/sempre", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify(corpo) });
  assert.equal((await sempre({ dominio: "*", metodo: "POST", caminho: "/postou" })).status, 400, "\"*\" não vale");
  assert.equal((await sempre({ dominio: "127.0.0.1", metodo: "POST", caminho: "/" })).status, 400, "o site inteiro não vale");
  assert.equal((await sempre({ dominio: "127.0.0.1", metodo: "POST", caminho: "/postou" })).status, 200);
  await nav("abrir", { url: site.url });
  let r = await nav("clicar", { seletor: "#pub" });
  assert.equal(r.status, 200, r.txt);
  for (let i = 0; i < 30 && !site.st.postou.length; i++) await esperar(100);
  assert.deepEqual(site.st.recebidas, ["POST /postou"]);
  assert.ok((await registro(b)).some((e) => e.acao === "rede" && e.ok && e.aprovacao === "sempre pode"));
  r = await nav("clicar", { seletor: "#ok" });
  assert.equal(r.status, 403, "sempre pode POST /postou não libera POST /publicar-post");
  await sempre({ dominio: "127.0.0.1", metodo: "POST", caminho: "/postou", ligar: false });
  await nav("abrir", { url: site.url });
  r = await nav("clicar", { seletor: "#pub" });
  assert.equal(r.status, 403);
  assert.deepEqual(site.st.recebidas, ["POST /postou"], "depois de tirar, nada mais chegou");
});

test("Navegador: SABOTAGEM — com a porta da rede desligada, as mesmas páginas chegam ao servidor (o teste morde)", { skip: semChrome }, async () => {
  const { site, nav } = await preparar(null, { BOARD_NAVEGADOR_REDE: "0" });
  for (const sel of ["#pub", "#ok2", "#lk1", "#js2"]) { await nav("abrir", { url: site.url }); await nav("clicar", { seletor: sel }); }
  for (let i = 0; i < 30 && site.st.recebidas.length < 4; i++) await esperar(100);
  assert.ok(site.st.recebidas.length >= 4, "sem a porta, o que o teste da trava proíbe chega ao servidor: " + JSON.stringify(site.st.recebidas));
});

test("Navegador pela CLI e pelo MCP (stdio): o mesmo navegador, o mesmo registro, a mesma recusa", { skip: semChrome }, async () => {
  const { caixa, b, site } = await preparar();
  // Assíncrono de propósito: o site falso mora NESTE processo — um execFileSync o deixaria sem responder ao Chrome.
  const cli = (...args) => new Promise((ok) => execFile(process.execPath, [join(caixa.board, "board-cli.mjs"), "navegador", ...args],
    { env: envDaCaixa(caixa, { BOARD_URL: b.url, BOARD_NAVEGADOR_QUEM: "codex (cli)" }), encoding: "utf8" },
    (e, out, err) => ok({ code: e ? e.code : 0, out: String(out) + String(err) })));
  let c = await cli("abrir", site.url); assert.equal(c.code, 0, c.out);
  c = await cli("ler"); assert.match(c.out, /Postagem/); assert.match(c.out, /controles/);
  c = await cli("clicar", "Publicar", "agora"); assert.equal(c.code, 3); assert.match(c.out, /RECUSADO/);
  c = await cli("registro"); assert.match(c.out, /codex \(cli\)/);
  // MCP
  const mcp = spawn(process.execPath, [join(caixa.board, "navegador-mcp.mjs")], { env: envDaCaixa(caixa, { BOARD_URL: b.url }), stdio: ["pipe", "pipe", "pipe"] });
  const resp = new Map(); let buf = "";
  mcp.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); resp.set(m.id, m); } } });
  const pedir = async (id, method, params) => { mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); for (let i = 0; i < 200 && !resp.has(id); i++) await esperar(100); return resp.get(id); };
  try {
    const ini = await pedir(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "gemini-cli" }, capabilities: {} });
    assert.equal(ini.result.serverInfo.name, "board-navegador");
    const lista = await pedir(2, "tools/list", {});
    assert.deepEqual(lista.result.tools.map((t) => t.name).sort(), ["navegador_abrir", "navegador_captura", "navegador_clicar", "navegador_esperar", "navegador_ler", "navegador_preencher", "navegador_subir"]);
    const ler = await pedir(3, "tools/call", { name: "navegador_ler", arguments: {} });
    assert.match(ler.result.content[0].text, /Postagem/);
    const clic = await pedir(4, "tools/call", { name: "navegador_clicar", arguments: { texto: "Publicar agora" } });
    assert.equal(clic.result.isError, true); assert.match(clic.result.content[0].text, /RECUSADO/);
    const cap = await pedir(5, "tools/call", { name: "navegador_captura", arguments: {} });
    assert.equal(cap.result.content[0].type, "image"); assert.ok(cap.result.content[0].data.length > 100);
  } finally { mcp.kill(); }
  assert.ok((await registro(b)).some((e) => e.quem === "gemini-cli (mcp)" && e.recusado), "o MCP aparece no registro com o nome do cliente");
  assert.deepEqual(site.st.recebidas, [], "nada chegou ao servidor");
});

test("\"sempre pode\" (a tela do Navegador saiu em 04/11; a rota segue): só com o Origin da tela, e libera a requisição barrada", { skip: semChrome }, async () => {
  const { caixa, b, site, nav } = await preparar();
  await nav("abrir", { url: site.url });
  assert.equal((await nav("clicar", { seletor: "#pub" })).status, 403, "barrada antes");
  const reg = readFileSync(join(caixa.board, "data", "logs", "navegador.jsonl"), "utf8");
  assert.match(reg, /"acao":"rede","alvo":"POST [^"]*\/postou"/); assert.match(reg, /"recusado":true/);
  const corpo = JSON.stringify({ dominio: "127.0.0.1", metodo: "POST", caminho: "/postou" });
  assert.equal((await fetch(b.url + "/api/navegador/sempre", { method: "POST", headers: { "content-type": "application/json" }, body: corpo })).status, 403, "agente (sem Origin) não se autoriza");
  assert.equal((await fetch(b.url + "/api/navegador/sempre", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: corpo })).status, 200);
  await nav("abrir", { url: site.url });
  assert.equal((await nav("clicar", { seletor: "#pub" })).status, 200, "liberado pelo \"sempre pode\" do dono");
});

// #219: o dono logou no Meta pelo `board navegador logar`, encerrou, e o agente abriu a tela de login. Aqui o login é um
// Chrome DE VERDADE com os argumentos do modo login (o embrulho só o deixa sem janela: a máquina de teste não tem tela),
// encerrado pelo board; o site falso grava um cookie persistente e uma sessão, e o modo agente tem de mandar o cookie.
test("Login salvo: o cookie gravado no Chrome de login chega ao site no modo agente — e o fim do login diz o que gravou", { skip: semChrome }, async () => {
  const caixa = criarCaixa(); criarProjeto(caixa, "alfa");
  const vistos = [];
  const s = createServer((req, res) => {
    vistos.push(`${req.url} cookie=${req.headers.cookie || ""}`);
    if (req.url === "/login") res.writeHead(200, { "content-type": "text/html", "set-cookie": ["sessao=dono-123; Max-Age=86400; Path=/; HttpOnly", "temporario=1; Path=/"] });
    else res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/eu" ? `<title>eu</title><p>cookie: ${String(req.headers.cookie || "nenhum").replace(/</g, "")}</p>` : "<title>ok</title>");
  });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${s.address().port}`;
  const bin = join(caixa.raiz, "chrome-login"); mkdirSync(bin, { recursive: true });
  const embrulho = join(bin, "chrome"), janelas = join(bin, "janelas");
  // Modo agente (já tem porta de depuração): o Chrome como veio. Modo login: os MESMOS argumentos, sem janela.
  writeFileSync(embrulho, `#!/bin/sh\ncase "$*" in *--remote-debugging-port*) exec ${JSON.stringify(CHROME)} "$@";; esac\nexec ${JSON.stringify(CHROME)} --headless=new --remote-debugging-port=0 "$@"\n`);
  writeFileSync(janelas, "#!/bin/sh\necho 1\n");
  // O "Sair" do app (no Mac, NSRunningApplication.terminate): o Chrome sem janela do teste não é app, então sai pelo CDP —
  // o mesmo desligamento limpo. O SIGTERM não serve: derruba o Chrome sem gravar o cookie de segundos atrás (medido).
  const sair = join(bin, "sair"), perfil = join(caixa.home, ".board-navegador");
  writeFileSync(sair, `#!${process.execPath}\nconst porta = require("fs").readFileSync(${JSON.stringify(join(perfil, "DevToolsActivePort"))}, "utf8").split("\\n")[0];
fetch("http://127.0.0.1:" + porta + "/json/version").then((r) => r.json()).then((v) => { const ws = new WebSocket(v.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); ws.onmessage = () => { console.log("ok"); process.exit(0); }; });
setTimeout(() => process.exit(1), 4000);\n`);
  for (const f of [embrulho, janelas, sair]) chmodSync(f, 0o755);
  const b = await subirBoard(caixa, { BOARD_NAVEGADOR_CHROME: embrulho, BOARD_NAVEGADOR_ARGS: "--use-mock-keychain --mute-audio --disable-audio-output", BOARD_NAVEGADOR_JANELAS: janelas, BOARD_NAVEGADOR_SAIR: sair });
  atual.push([b, caixa, s]);
  let r = await b.api("POST", "/api/navegador/logar", { url: url + "/login" });
  assert.equal(r.status, 200, r.txt); assert.ok(r.json.pid, "o login guardou o pid de quem segura o perfil");
  for (let i = 0; i < 100 && !vistos.some((v) => v.startsWith("/login")); i++) await esperar(100);
  assert.ok(vistos.some((v) => v.startsWith("/login")), "o Chrome de login abriu a página de login");
  await esperar(500);
  r = await b.api("POST", "/api/navegador/fechar", {});
  assert.equal(r.status, 200, r.txt); assert.equal(r.json.login, true); assert.equal(r.json.forcado, false);
  assert.equal(r.json.limpo, true, "saiu pelo Sair (desligamento limpo, que grava os cookies), não pelo SIGTERM");
  assert.deepEqual(r.json.cookies, [{ site: "127.0.0.1", n: 1 }], "o fechar diz o que ficou gravado");
  r = await b.api("POST", "/api/navegador/abrir", { quem: "teste", url: url + "/eu" });
  assert.equal(r.status, 200, r.txt);
  const eu = vistos.find((v) => v.startsWith("/eu"));
  assert.match(eu, /sessao=dono-123/, "o modo agente mandou o cookie que o login gravou: " + eu);
  assert.doesNotMatch(eu, /temporario=1/, "cookie de sessão (sem validade) não atravessa — o Chrome não guarda");
  const reg = (await b.api("GET", "/api/navegador")).json.registro;
  const fim = reg.find((e) => e.acao === "logar" && e.alvo === "login encerrado");
  assert.ok(fim, "o fim do login foi registrado");
  assert.deepEqual(fim.cookies, [{ site: "127.0.0.1", n: 1 }], "o registro diz o que ficou gravado (só o persistente)");
  assert.match(fim.texto, /Cookies gravados neste login: 127\.0\.0\.1 \(1\)/);
});

test("Login salvo: os dois Chromes do perfil (login e agente) sobem com as mesmas flags de cookie (Keychain)", () => {
  const src = readFileSync(new URL("../servidor/navegador.mjs", import.meta.url), "utf8");
  const login = src.match(/spawn\(chrome, \[`--user-data-dir=\$\{perfil\}`[^\n]*/)[0], agente = src.match(/spawn\(chrome, \["--headless=new"[\s\S]*?\], \{ stdio/)[0];
  for (const l of [login, agente]) { assert.match(l, /--user-data-dir=\$\{perfil\}/); assert.match(l, /\.\.\.ARGS_EXTRA\(\)/, "as flags a mais (BOARD_NAVEGADOR_ARGS) valem nas duas"); }
  for (const f of ["use-mock-keychain", "password-store", "profile-directory"]) assert.equal(login.includes(f), agente.includes(f), `--${f} igual nas duas formas`);
});

test("Rede: a decisão por requisição, o site citado e uma aprovação = um site (sem Chrome)", async () => {
  const caixa = criarCaixa();
  try {
    writeFileSync(join(caixa.board, "data", "navegador.json"), JSON.stringify({ liberar: [{ dominio: "cdn.x.com", caminho: "/assets" }],
      sempre: [{ dominio: "x.com", metodo: "POST", caminho: "/api/rascunho" }] }));
    const script = `
      import * as R from ${JSON.stringify(join(caixa.board, "servidor", "navegador-risco.mjs"))};
      const d = (metodo, url, lib, tipo) => { const r = R.decidirRequisicao({ metodo, url, tipo }, lib); return r.ok ? "ok:" + r.como : "nao:" + r.acao; };
      const out = {};
      out.leitura = d("GET", "https://x.com/feed?page=2");
      out.head = d("HEAD", "https://x.com/feed");
      out.local = d("GET", "data:image/gif;base64,R0lG");
      out.getDelete = d("GET", "https://x.com/api/delete-account");
      out.getLogout = d("GET", "https://x.com/logout");
      out.getPost = d("GET", "https://x.com/postar/novo");
      out.post = d("POST", "https://x.com/api/upload");
      out.del = d("DELETE", "https://x.com/item/5");
      out.put = d("PUT", "https://x.com/perfil");
      out.liberado = d("GET", "https://cdn.x.com/assets/publish-icon.png");
      out.liberadoFora = d("GET", "https://cdn.x.com/outra/publish.png");
      out.sempre = d("POST", "https://x.com/api/rascunho");
      out.sempreGet = d("GET", "https://x.com/api/rascunho/delete");
      out.comBr = ["mercadolivre.com.br", "lojaexemplo.com.br", "nubank.com.br"].map((h) => R.siteCitado("publicar o vídeo do radar no facebook com legenda", h));
      out.meta = R.siteCitado("postar o vídeo no Meta Business Suite", "upload.facebook.com");
      out.principal = [R.nomePrincipal("business.facebook.com"), R.nomePrincipal("loja.mercadolivre.com.br"), R.nomePrincipal("bbc.co.uk")];
      R.usarConferencia(() => ({ ok: true }));
      const lib = { id: "abcdefabcdef", pedido: "publicar o video do radar no Meta Business Suite", ate: Date.now() + 60000 };
      out.aprovado = d("POST", "https://business.facebook.com/api/upload", lib);
      out.outroSub = d("POST", "https://upload.facebook.com/x", lib);
      out.outroSite = d("POST", "https://mercadolivre.com.br/api/publicar", { ...lib, id: "cccccccccccc", pedido: "publicar o video do radar no facebook com legenda" });
      out.naoCobre = d("GET", "https://business.facebook.com/delete/7", lib);
      out.vencida = d("POST", "https://business.facebook.com/api/upload", { ...lib, ate: Date.now() - 1 });
      const usado = { ...lib, id: "dddddddddddd", pedido: "publicar no 10.0.0.1 e no 10.0.0.2" };
      out.umSite1 = d("POST", "http://10.0.0.1/a", usado); out.umSite2 = d("POST", "http://10.0.0.2/a", usado);
      R.usarConferencia(() => ({ ok: false, motivo: "venceu" }));
      try { R.abrirLiberacao("eeeeeeeeeeee", "publicar"); out.abrir = "abriu"; } catch (e) { out.abrir = e.status + " " + e.message; }
      // #219: as URLs reais da Meta que o 1º uso barrou ("publi" casava "public") — e as que têm de continuar barrando.
      out.meta1 = d("GET", "https://static.xx.fbcdn.net/mci_ab/public/cms/?ab_b=e&ab_page=CMS&ab_entry=1530&version=1");
      out.meta2 = d("GET", "https://static.xx.fbcdn.net/rsrc.php/v4/yS/r/publish-composer.js", null, "Script");
      out.meta3 = d("GET", "https://scontent.xx.fbcdn.net/v/t39.30808-1/send_postal_share.jpg?stp=dst-jpg", null, "Image");
      out.meta4 = d("GET", "https://static.xx.fbcdn.net/rsrc.php/v4/fonts/delete.woff2", null, "Font");
      out.palavras = ["https://x.com/publicidade", "https://x.com/postal/cep", "https://x.com/shareable-link", "https://x.com/public/sender-info",
        "https://x.com/remote/posterior", "https://business.facebook.com/business/loginpage/?next=%2Flatest%2Fcontent_calendar"].map((u) => d("GET", u));
      out.acoes = ["https://business.facebook.com/latest/composer?action=publish", "https://x.com/api/deleteAccount", "https://x.com/publicar-agora",
        "https://x.com/post/novo", "https://x.com/compartilhou", "https://x.com/r?op=send"].map((u) => d("GET", u, null, "Document"));
      out.assetPost = d("POST", "https://static.xx.fbcdn.net/x.png", null, "Image");
      out.assetSemTipo = d("GET", "https://static.xx.fbcdn.net/rsrc.php/v4/yS/r/publish-composer.js");
      out.aviso = [R.classificarRisco({ texto: "Publicar agora" }, "x.com"), R.classificarRisco({ texto: "Ver mais" }, "x.com")];
      console.log(JSON.stringify(out));`;
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: caixa.board, env: envDaCaixa(caixa), encoding: "utf8" }));
    assert.equal(out.leitura, "ok:leitura"); assert.equal(out.head, "ok:leitura"); assert.equal(out.local, "ok:local");
    assert.equal(out.getDelete, "nao:excluir", "GET com cara de ação para"); assert.equal(out.getLogout, "nao:sair"); assert.equal(out.getPost, "nao:postar");
    assert.equal(out.post, "nao:gravar", "toda escrita para"); assert.equal(out.del, "nao:gravar"); assert.equal(out.put, "nao:gravar");
    assert.equal(out.liberado, "ok:liberado", "leitura liberada no navegador.json"); assert.equal(out.liberadoFora, "nao:publicar", "só no caminho liberado");
    assert.equal(out.sempre, "ok:sempre"); assert.equal(out.sempreGet, "nao:excluir", "sempre pode é por método + caminho");
    assert.deepEqual(out.comBr, [false, false, false], "\"com\" de .com.br não é o nome do site (QA da #217)");
    assert.equal(out.meta, true); assert.deepEqual(out.principal, ["facebook", "mercadolivre", "bbc"]);
    assert.equal(out.aprovado, "ok:aprovacao"); assert.equal(out.outroSub, "ok:aprovacao", "upload.facebook.com é o mesmo site");
    assert.equal(out.outroSite, "nao:publicar", "o SIM que diz facebook não vale no mercadolivre.com.br");
    assert.equal(out.naoCobre, "nao:excluir", "o SIM a publicar não cobre apagar"); assert.equal(out.vencida, "nao:gravar");
    assert.equal(out.umSite1, "ok:aprovacao"); assert.equal(out.umSite2, "nao:gravar", "uma aprovação, um site");
    assert.match(out.abrir, /^403 .*venceu/);
    assert.deepEqual(out.aviso, ["publicar", null], "o HTML continua, só como aviso");
    assert.equal(out.meta1, "ok:leitura", "static.xx.fbcdn.net/mci_ab/public/cms é leitura: \"public\" não é publicar (#219)");
    assert.deepEqual([out.meta2, out.meta3, out.meta4], ["ok:asset", "ok:asset", "ok:asset"], "js/imagem/fonte de um GET só leem");
    assert.deepEqual(out.palavras, Array(6).fill("ok:leitura"), "publicidade, postal, shareable, sender, posterior: palavra que só começa igual não é ação");
    assert.deepEqual(out.acoes, ["nao:publicar", "nao:excluir", "nao:publicar", "nao:postar", "nao:compartilhar", "nao:enviar"], "a palavra de ação inteira (e camelCase) continua barrando");
    assert.equal(out.assetPost, "nao:gravar", "asset é só GET: escrita continua parando");
    assert.equal(out.assetSemTipo, "nao:publicar", "sem o tipo do CDP, o endereço é julgado");
  } finally { limparCaixa(caixa); }
});
