// `board tela <destino>` (#293): a Central muda a tela do dono, SÓ navegação. Tudo com o board inteiro numa caixa, a CLI de
// verdade e Chrome de verdade: lista fechada, só o aparelho em uso, texto do dono a salvo e NENHUMA ação disparada.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chamadas, criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, envDaCaixa } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [], navs = [];
afterEach(async () => {
  for (const n of navs) await n.fechar().catch(() => {});
  for (const [b, c] of atual) { await b.fim(); limparCaixa(c); }
  atual = []; navs = [];
});

async function preparar({ env = {}, conversa = ["ok"] } = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "alfa"); criarProjeto(caixa, "beta");
  writeFileSync(join(caixa.board, "data", "projetos.json"), JSON.stringify({ visiveis: ["alfa", "beta"], rotulos: { beta: "CRM" } }));
  caixa.cenario({ conversa });
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { b, caixa };
}
const board = (b, caixa, ...args) => new Promise((ok) => execFile(process.execPath, [join(caixa.board, "board-cli.mjs"), ...args], { env: envDaCaixa(caixa, { BOARD_URL: b.url }) },
  (e, stdout, stderr) => ok({ code: e ? e.code : 0, out: stdout + stderr })));
const pedir = (b, destino) => b.api("POST", "/api/tela", { destino });
const postar = (b, rota, corpo, origin) => fetch(b.url + rota, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(corpo) });

async function abrir(b, hash = "", opcoes = {}) {
  const nav = await abrirNavegador(opcoes); navs.push(nav);
  await nav.carregar(b.url + "/" + hash);
  await esperarNaTela(nav, `connected && S.tasks !== undefined && !!$("#navigation a")`);
  return nav;
}
async function esperarNaTela(nav, expr, ms = 8000) {
  for (let i = 0; i < ms / 100; i++) { if (await nav.avaliar(`!!(${expr})`).catch(() => false)) return; await esperar(100); }
  throw new Error(`não aconteceu na tela: ${expr}\n` + await nav.avaliar(`location.href + " · " + document.body.innerText.slice(0, 300)`));
}
/** Um clique de verdade (pelo Chrome) num canto vazio: é o dono usando ESTE aparelho. */
async function usar(nav) {
  for (const type of ["mousePressed", "mouseReleased"]) await nav.cmd("Input.dispatchMouseEvent", { type, x: 700, y: 3, button: "left", clickCount: 1 });
  await esperarNaTela(nav, `TELA.avisadoEm > 0`);
  await esperar(150);
}
const tituloDaTela = `document.querySelector("header h1").innerText`;

test("Lista fechada: destino fora dela é erro, antes de qualquer tela receber qualquer coisa", async () => {
  const { b, caixa } = await preparar();
  await b.api("POST", "/api/tasks", { text: "tarefa um", project: "alfa" });
  for (const d of ["aprovar", "mesclar", "publicar", "publicar alfa", "permissoes", "teclas", "sessao", "tarefa", "tarefa abc", "tarefa 1; rm -rf", "#/t/1", "../api/publicar", "javascript:alert(1)", "conversa alfa; x", "__proto__", "constructor", "", "   ", "x".repeat(200)]) {
    const r = await pedir(b, d);
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(d)} → ${r.status}`);
  }
  for (const d of [null, 7, { tipo: "aba", aba: "board" }, ["central"]]) assert.equal((await pedir(b, d)).status, 400, JSON.stringify(d));
  assert.equal((await pedir(b, "tarefa 999")).status, 404);
  assert.equal((await pedir(b, "conversa outroprojeto")).status, 404);
  assert.equal((await pedir(b, "sessao ninguem")).status, 404);
  // Na CLI: código 1 e a lista do que vale; sem argumento, o uso
  const r = await board(b, caixa, "tela", "aprovar");
  assert.equal(r.code, 1); assert.match(r.out, /✗ a tela não mudou/); assert.match(r.out, /controle/);
  assert.equal((await board(b, caixa, "tela")).code, 2);
  // Destino válido sem ninguém usando o board: erro, nunca "mudou"
  const s = await board(b, caixa, "tela", "central");
  assert.equal(s.code, 1); assert.match(s.out, /ninguém está usando o board/);
  await b.fim();
  const f = await board(b, caixa, "tela", "central");
  assert.equal(f.code, 1, "board fora do ar não é sucesso"); assert.match(f.out, /fora do ar/);
});

test("Barreiras: outra página não pede; só a tela diz que está em uso e responde; a CLI não finge ser a tela", async () => {
  const { b } = await preparar();
  const fora = "http://evil.example:4488";
  assert.equal((await postar(b, "/api/tela", { destino: "central" }, fora)).status, 403);
  for (const rota of ["/api/tela/ativa", "/api/tela/resposta"]) {
    assert.equal((await postar(b, rota, { tela: "aaaaaaaa" })).status, 403, rota + " sem Origin");
    assert.equal((await postar(b, rota, { tela: "aaaaaaaa" }, fora)).status, 403, rota + " de outra página");
  }
  assert.equal((await postar(b, "/api/tela/resposta", { tela: "aaaaaaaa", pedido: "x", resultado: "mudou" }, b.url)).status, 410, "pedido que não existe");
  assert.equal((await postar(b, "/api/tela/ativa", { tela: "aaaaaaaa" }, b.url)).status, 409, "tela que não está conectada");
  // As barreiras das ações seguem de pé para a CLI (sem Origin)
  assert.equal((await postar(b, "/api/publicar/alfa", { confirmo: "x" })).status, 403);
  assert.equal((await postar(b, "/api/sessoes/1/teclas", { texto: "1" })).status, 403);
});

test("Tela: cada destino da lista abre a tela certa, pelo comando de verdade", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const tarefa = (await b.api("POST", "/api/tasks", { text: "ver a ficha", project: "alfa" })).json.tasks[0];
  // Uma sessão no registro do CLI: fora do tmux ela aparece com a aba dela (o pid vivo é o deste teste).
  mkdirSync(join(caixa.home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(caixa.home, ".claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-1", cwd: join(caixa.dev, "alfa"), name: "minha-sessao", entrypoint: "cli", status: "idle" }));
  const nav = await abrir(b);
  await usar(nav);
  for (const [destino, titulo] of [["controle", "Controle"], ["central", "Central"], ["busca", "Busca"], ["Controle", "Controle"],
    ["sessoes", "Sessões"], ["prs", "Pull Requests"], ["conversa", "Conversas"], ["quadro", "Meu quadro"]]) {
    const r = await board(b, caixa, "tela", destino);
    assert.equal(r.code, 0, destino + ": " + r.out); assert.match(r.out, /^✓ a tela mudou/);
    await esperarNaTela(nav, `${tituloDaTela}.includes(${JSON.stringify(titulo)})`);
  }
  assert.equal((await board(b, caixa, "tela", "tarefa", "#" + tarefa.id)).code, 0);
  await esperarNaTela(nav, `location.hash === "#/t/${tarefa.id}" && view.name === "detail"`);
  // O projeto entra pelo rótulo ou pela pasta, e a saída nunca diz o nome da pasta (#249)
  const r = await board(b, caixa, "tela", "conversa", "crm");
  assert.equal(r.code, 0, r.out); assert.match(r.out, /Conversa de CRM/); assert.doesNotMatch(r.out, /beta/i);
  await esperarNaTela(nav, `location.hash === "#/c/beta"`);
  assert.equal((await board(b, caixa, "tela", "conversa", "alfa")).code, 0);
  await esperarNaTela(nav, `location.hash === "#/c/alfa"`);
  assert.equal((await board(b, caixa, "tela", "sessao", "minha-sessao")).code, 0);
  await esperarNaTela(nav, `view.name === "sessoes" && SES.pid === ${process.pid} && $(".ses-aba.on")?.innerText.includes("minha-sessao")`);
  assert.deepEqual(nav.erros, []);
  const log = readFileSync(join(caixa.board, "data", "logs", "tela.jsonl"), "utf8");
  assert.match(log, /Controle/); assert.match(log, /"resultado":"mudou"/);
});

test("Tela: os destinos das telas removidas em 04/11 (navegador, memória, consumo, monitoramento) respondem ✗ com o motivo, e a tela fica", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await abrir(b, "#/prs");
  await usar(nav);
  for (const [destino, nome] of [["navegador", "Navegador"], ["memoria", "Memória"], ["Memória", "Memória"], ["consumo", "Consumo"], ["monitoramento", "Monitoramento"], ["Monitoring", "Monitoramento"]]) {
    const r = await board(b, caixa, "tela", destino);
    assert.equal(r.code, 1, destino + ": " + r.out);
    assert.match(r.out, new RegExp(`^✗ a tela não mudou: a tela ${nome} foi removida em 04/11`), destino);
    assert.doesNotMatch(r.out, /Vale:.*(navegador|memoria|consumo|monitoramento)/, "a lista de destinos não oferece tela que saiu");
    assert.equal((await pedir(b, destino)).status, 410, destino);
  }
  // os outros seguem valendo, e nada chegou à tela
  assert.match((await board(b, caixa, "tela", "controle")).out, /^✓ a tela mudou/);
  await esperarNaTela(nav, `${tituloDaTela}.includes("Controle")`);
  // a tela também não aceita a aba se um pedido forjado chegar
  assert.equal(await nav.avaliar(`["navegador", "memoria", "consumo", "monitoring"].some((aba) => destinoValido({ tipo: "aba", aba }))`), false);
  assert.deepEqual(nav.erros, []);
});

test("Tela: só o aparelho em uso muda — os outros ficam onde estão, e quem acabou de usar passa a ser ele", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const mac = await abrir(b, "#/prs"), celular = await abrir(b, "#/busca", { largura: 390, altura: 800 }), parada = await abrir(b, "#/central");
  await usar(mac); await usar(celular);
  // Conta o que CHEGA a cada aba: a outra não pode nem receber (a recusa do servidor a uma aba errada é só a 2ª trava)
  const contar = `window.__pedidos = 0; { const o = aoPedidoDeTela; aoPedidoDeTela = (d) => { window.__pedidos++; return o(d); }; } 1`;
  await mac.avaliar(contar); await parada.avaliar(contar); await celular.avaliar(contar);
  assert.equal((await board(b, caixa, "tela", "sessoes")).code, 0);
  await esperarNaTela(celular, `${tituloDaTela}.includes("Sessões")`);
  await esperar(400);
  assert.equal(await mac.avaliar(`location.hash`), "#/prs", "o outro aparelho não mexe");
  assert.equal(await parada.avaliar(`location.hash`), "#/central", "a aba parada não mexe");
  assert.deepEqual([await celular.avaliar(`window.__pedidos`), await mac.avaliar(`window.__pedidos`), await parada.avaliar(`window.__pedidos`)], [1, 0, 0], "só a aba em uso recebe o pedido");
  // Voltou para o Mac: agora é ele — mesmo o celular tendo avisado há pouco (a marca não pode ser engolida pelo "só de vez em quando")
  await usar(mac);
  await usar(celular); await usar(mac);
  assert.equal((await board(b, caixa, "tela", "busca")).code, 0);
  await esperarNaTela(mac, `${tituloDaTela}.includes("Busca")`);
  assert.ok((await celular.avaliar(tituloDaTela)).includes("Sessões"));
  // Fechou a aba em uso: vale a anterior, se ainda estiver no prazo
  await usar(celular); await usar(mac);
  await mac.fechar(); navs = navs.filter((n) => n !== mac);
  for (let i = 0; i < 30 && (await pedir(b, "controle")).status !== 200; i++) await esperar(100);
  await esperarNaTela(celular, `${tituloDaTela}.includes("Controle")`);
  assert.equal(await parada.avaliar(`location.hash`), "#/central");
  assert.deepEqual([...celular.erros, ...parada.erros], []);
});

test("Tela: passou do prazo sem ninguém usar, nada muda sozinho", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar({ env: { BOARD_TELA_ATIVA_MIN: "0.02" } }); // 1,2 s
  const nav = await abrir(b, "#/prs");
  await usar(nav);
  assert.match((await board(b, caixa, "tela", "controle")).out, /^✓/, "dentro do prazo");
  await esperar(1500);
  const r = await board(b, caixa, "tela", "central");
  assert.equal(r.code, 1); assert.match(r.out, /ninguém está usando/);
  assert.ok((await nav.avaliar(tituloDaTela)).includes("Controle"));
});

test("Tela: o board reiniciar não faz a tela em uso ser esquecida, e ela volta a responder", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const nav = await abrir(b);
  await usar(nav);
  await b.fim(); atual = [];
  const n = await subirBoard(caixa, { BOARD_PORT: String(b.porta) }); atual.push([n, caixa]); // mesma porta: `b.url` continua sendo o endereço dele
  await esperarNaTela(nav, `connected && TELA.sou`, 15000);
  const r = await board(b, caixa, "tela", "controle");
  assert.equal(r.code, 0, r.out);
  await esperarNaTela(nav, `${tituloDaTela}.includes("Controle")`);
});

test("Tela: digitando, a tela fica e o texto também; parado, muda e o rascunho volta; o clique em Abrir é dele", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar();
  const tarefa = (await b.api("POST", "/api/tasks", { text: "conversar", project: "alfa" })).json.tasks[0];
  const nav = await abrir(b);
  const digitar = async (seletor, texto) => { await nav.avaliar(`document.querySelector(${JSON.stringify(seletor)}).focus()`); await nav.cmd("Input.insertText", { text: texto }); };
  const apagarTempo = () => nav.avaliar(`TELA.digitouEm = 0`); // os 8 s sem digitar, sem esperar 8 s

  for (const [hash, caixaDeTexto] of [["", "#newTask"], ["#/central", "#convIn"], ["#/c/alfa", "#convIn"], [`#/t/${tarefa.id}`, "#chatIn"]]) {
    await nav.avaliar(`location.hash = ${JSON.stringify(hash)}`);
    await esperarNaTela(nav, `document.querySelector(${JSON.stringify(caixaDeTexto)})`);
    await digitar(caixaDeTexto, "metade de uma frase");
    await usar(nav);
    await nav.avaliar(`document.querySelector(${JSON.stringify(caixaDeTexto)}).focus()`);
    await nav.cmd("Input.insertText", { text: " e mais" });
    const r = await board(b, caixa, "tela", "sessoes");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /⏸ a tela não mudou/, hash);
    await esperarNaTela(nav, `$("#telaGuardada")`);
    assert.equal(await nav.avaliar(`location.hash`), hash, "digitando, a tela não sai");
    assert.equal(await nav.avaliar(`document.activeElement.id`), caixaDeTexto.slice(1), "e o foco fica com ele");
    await nav.cmd("Input.insertText", { text: " continua" });
    assert.equal(await nav.avaliar(`document.querySelector(${JSON.stringify(caixaDeTexto)}).value`), "metade de uma frase e mais continua");
    await nav.avaliar(`esquecerPedido()`);
    // Parou de digitar: o rascunho guarda, a tela pode mudar, e o texto volta inteiro
    await apagarTempo();
    assert.match((await board(b, caixa, "tela", "sessoes")).out, /^✓/);
    await esperarNaTela(nav, `${tituloDaTela}.includes("Sessões")`);
    await nav.avaliar(`location.hash = "#/prs"`); await esperarNaTela(nav, `view.name === "prs"`);
    if (hash) await nav.avaliar(`location.hash = ${JSON.stringify(hash)}`); else await nav.avaliar(`navigateBoard("board")`);
    await esperarNaTela(nav, `document.querySelector(${JSON.stringify(caixaDeTexto)})?.value === "metade de uma frase e mais continua"`);
    await nav.avaliar(`(() => { const t = document.querySelector(${JSON.stringify(caixaDeTexto)}); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  }

  // O aviso: o clique dele abre; "Agora não" deixa como está
  await nav.avaliar(`location.hash = "#/central"`); await esperarNaTela(nav, `$("#convIn")`);
  await digitar("#convIn", "texto"); 
  await board(b, caixa, "tela", "controle");
  await esperarNaTela(nav, `$("#telaGuardada")?.innerText.includes("Controle")`);
  await nav.avaliar(`[...$("#telaGuardada").querySelectorAll("button")].find((x) => x.textContent === "Abrir").click()`);
  await esperarNaTela(nav, `${tituloDaTela}.includes("Controle") && !$("#telaGuardada")`);
  await nav.avaliar(`location.hash = "#/central"`); await esperarNaTela(nav, `$("#convIn")?.value === "texto"`);
  await digitar("#convIn", " de novo");
  await board(b, caixa, "tela", "busca");
  await esperarNaTela(nav, `$("#telaGuardada")`);
  await nav.avaliar(`[...$("#telaGuardada").querySelectorAll("button")].find((x) => x.textContent === "Agora não").click()`);
  await esperarNaTela(nav, `!$("#telaGuardada")`);
  assert.equal(await nav.avaliar(`location.hash`), "#/central");

  // Sem rascunho: campo da sessão (pode ser senha) e busca não enviada seguram mesmo sem digitar agora
  await apagarTempo();
  await nav.avaliar(`location.hash = "#/busca"`); await esperarNaTela(nav, `$("#buscaIn")`);
  await nav.avaliar(`$("#buscaIn").value = "aquela do rate"; $("#buscaIn").blur()`);
  assert.match((await board(b, caixa, "tela", "controle")).out, /^⏸/, "busca escrita e não enviada");
  await nav.avaliar(`esquecerPedido(); $("#buscaIn").value = BUSCA.q`);
  // O campo da sessão não tem rascunho (pode ser senha): com texto nele, segura mesmo sem foco
  await nav.avaliar(`document.body.insertAdjacentHTML("beforeend", '<input id="sesTexto" value="uma senha">')`);
  assert.match((await board(b, caixa, "tela", "controle")).out, /^⏸/, "texto no campo da sessão");
  await nav.avaliar(`esquecerPedido(); $("#sesTexto").remove()`);
  // Ditado no meio também segura
  await nav.avaliar(`ditado = "gravando"`);
  assert.match((await board(b, caixa, "tela", "controle")).out, /^⏸/, "ditado no meio");
  await nav.avaliar(`ditado = "parado"; esquecerPedido()`);
  assert.match((await board(b, caixa, "tela", "controle")).out, /^✓/);
  assert.deepEqual(nav.erros, []);
});

test("🔴 Tela: nenhuma ação é disparada — com cartão de permissão, pedido de SIM e terminal na tela, só /api/tela/* sai dela", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar({ conversa: ["Posso mesclar?\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa"] });
  const tarefa = (await b.api("POST", "/api/tasks", { text: "x", project: "alfa" })).json.tasks[0];
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  for (let i = 0; i < 60 && !(await b.api("GET", "/api/conversa/central")).json.events.some((e) => e.pedidoSim); i++) await esperar(100);
  // Um pedido de permissão esperando resposta: o que alguém clicaria.
  const pedido = fetch(b.url + "/api/permissoes/pedido", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool_name: "Bash", input: { command: "ssh vps reboot" }, de: { slug: "alfa", tipo: "conversa" } }) }).catch(() => {});
  for (let i = 0; i < 30 && !(await b.api("GET", "/api/permissoes")).json.pendentes.length; i++) await esperar(100);
  const nav = await abrir(b, "#/central");
  await esperarNaTela(nav, `document.querySelector(".pedido-sim, [data-aprovar], .sim-pedido") || document.body.innerText.includes("Pedido de SIM")`);
  await nav.avaliar(`window.__cliques = 0; document.addEventListener("click", () => window.__cliques++, true);`);
  const saidas = [];
  nav.ouvir((d) => { if (d.method === "Network.requestWillBeSent" && d.params.request.method !== "GET") saidas.push(new URL(d.params.request.url).pathname); });
  await usar(nav);
  const antes = await nav.avaliar(`window.__cliques`);
  for (const d of ["prs", "central", "quadro", "controle", "conversa alfa", `tarefa ${tarefa.id}`, "sessoes", "busca", "central"]) {
    assert.equal((await pedir(b, d)).status, 200, d);
    await esperar(150);
  }
  // Pedido forjado que tentasse mais que navegar: a tela não obedece (e os "alvos" de clique nem existem no protocolo)
  await nav.avaliar(`location.hash = "#/central"`);
  // (o servidor aceita a resposta aqui de propósito: quem tem de recusar é a própria tela, sem contar com o 410)
  await nav.avaliar(`window.__respostas = []; window.__fetch = window.fetch; window.fetch = async (u, o) => { if (String(u) === "/api/tela/resposta") { window.__respostas.push(JSON.parse(o.body).resultado); return { ok: true }; } return window.__fetch(u, o); }; 1`);
  const forjados = [{ tipo: "clique", alvo: ".btn" }, { tipo: "aba", aba: "javascript:alert(1)" }, { tipo: "aba", aba: "aprovar" }, { tipo: "conversa", slug: "../../x?y" }, { tipo: "tarefa", id: "1/../../publicar" }];
  for (const f of forjados) await nav.avaliar(`aoPedidoDeTela(${JSON.stringify({ ...f, pedido: "forjado" })})`);
  await esperar(300);
  await nav.avaliar(`window.fetch = window.__fetch; 1`);
  assert.deepEqual(await nav.avaliar(`window.__respostas`), forjados.map(() => "recusou"));
  assert.equal(await nav.avaliar(`location.hash`), "#/central");
  assert.equal(await nav.avaliar(`window.__cliques`), antes, "nenhum clique na página");
  assert.deepEqual([...new Set(saidas)].filter((p) => !p.startsWith("/api/tela/")), [], "só a marca de uso e a resposta saem da tela");
  assert.deepEqual(nav.dialogos, [], "nenhuma confirmação aberta");
  assert.equal((await b.api("GET", "/api/permissoes")).json.pendentes.length, 1, "o pedido de permissão segue esperando o dono");
  assert.ok(!existsSync(join(caixa.board, "data", "aprovacoes.jsonl")), "nenhum SIM gravado");
  const cartao = (await b.api("GET", "/api/permissoes")).json.pendentes[0];
  assert.equal((await postar(b, `/api/permissoes/${cartao.id}`, { acao: "uma" })).status, 403, "a barreira do Origin segue valendo para quem não é a tela");
  assert.equal((await b.api("GET", "/api/conversa/central")).json.events.filter((e) => e.t === "dono").length, 1, "nenhuma mensagem nova na Central");
  void pedido;
});

test("🔴 O script da tela não tem como clicar: sem .click(), sem evento forjado, sem rota além de /api/tela/*", () => {
  const js = readFileSync(new URL("../web/js/tela.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(js, /\.click\(|dispatchEvent|\.submit\(|requestSubmit|new (Mouse|Pointer|Keyboard)Event/);
  assert.deepEqual([...new Set(js.match(/\/api\/[\w/-]+/g))].sort(), ["/api/tela/ativa", "/api/tela/resposta"]);
  const srv = readFileSync(new URL("../servidor/tela.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(srv, /from "\.\/(publicar|prs|permissoes|aprovacoes|esteira|navegador|voz)\.mjs"/, "o módulo não alcança nenhuma ação");
  assert.doesNotMatch(srv, /mandarTeclas/);
});

test("Tela: pedido atrasado não muda nada (tela presa num confirm, celular dormindo), e tela muda não vira sucesso falso", { skip: !CHROME }, async () => {
  const { b, caixa } = await preparar({ env: { BOARD_TELA_ESPERA_MS: "600" } });
  const nav = await abrir(b, "#/prs");
  await usar(nav);
  // A tela fica presa (o que um confirm faz com o JS) durante o prazo do pedido
  const presa = nav.avaliar(`(() => { const t = performance.now(); while (performance.now() - t < 1500); })()`);
  const r = await board(b, caixa, "tela", "controle");
  assert.equal(r.code, 1, r.out); assert.match(r.out, /não respondeu/);
  await presa; await esperar(500);
  assert.equal(await nav.avaliar(`location.hash`), "#/prs", "acordou depois do prazo: o pedido vencido não muda a tela");
});

test("A regra da Central ensina o comando e o limite dele", async () => {
  const { b, caixa } = await preparar();
  await b.api("POST", "/api/conversa/central", { texto: "abre os PRs" });
  let regras = "";
  for (let i = 0; i < 60 && !regras.includes("--append-system-prompt"); i++) { regras = chamadas(caixa).filter((c) => c.papel === "conversa").map((c) => JSON.stringify(c.args).replaceAll("\\n", "\n")).join("\n"); await esperar(100); }
  assert.match(regras, /board-cli\.mjs tela <destino>/);
  assert.match(regras, /NUNCA clica/);
  assert.match(regras, /controle/);
  assert.doesNotMatch(regras, /Destinos \(lista fechada\):[^\n]*(navegador|memoria|consumo|monitoramento)/, "a regra não oferece tela removida");
});
