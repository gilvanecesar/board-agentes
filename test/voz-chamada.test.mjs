// 🎙 Palavra de chamada do modo voz (#305): "quando eu estiver em outra tela ou outro local do escritório, você só sabe que falo com
// você se eu falar o seu nome". Fora da Central à vista só vale a fala que começa com o nome; o resto não chega a lugar nenhum.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { comChrome, conferir, conversas, darPermissaoDoBloqueio, esconderDeVerdade, esperarEvento, esperarNaTela, eventos, ligada, limparVoz, ouvir, parar, preparar, registro, soar, tela } from "./voz-ajuda.mjs";
import { lerChamada } from "../servidor/voz-texto.mjs";

afterEach(limparVoz);
const NOME = "exige=nome", JANELA = "exige=janela";
const q = (extra) => `modo=conversa&${extra}`;
const mensagens = async (b) => (await eventos(b)).filter((e) => e.t === "dono");
const registroVoz = (caixa) => { const a = join(caixa.board, "data", "logs", "voz.jsonl"); return existsSync(a) ? readFileSync(a, "utf8") : ""; };
const falar = async (nav) => { await nav.avaliar(soar(0.3, 400)); await parar(nav); };

test("Chamada, reconhecer: o nome abre a frase, nas formas que o whisper escreve; parecido e nome no meio não valem", () => {
  for (const [t, resto] of [
    ["Atena, como estão as tarefas?", "Como estão as tarefas?"], ["atena como estão as tarefas", "Como estão as tarefas"], ["ATENA: tem PR aberto?", "Tem PR aberto?"],
    ["Ei, Atena, qual o status?", "Qual o status?"], ["Em Atena, qual o status?", "Qual o status?"], ["E Atena, qual o status?", "Qual o status?"], ["Oi Atena. Tudo bem?", "Tudo bem?"], ["Ok, Atena, modo texto.", "Modo texto."],
    ["Atena.", ""], ["Atena!", ""], ["Ei Atena", ""],
  ]) assert.deepEqual(lerChamada(t), { citou: true, resto, texto: t }, t);
  for (const t of ["Como estão as tarefas?", "O cliente ligou, Atena.", "O Atena caiu de novo", "Sábado eu vou na obra.", "Saturou o mercado de frete.", "Saturado de tanto trabalho.", "Seu turno acabou.", "O turno da noite.", "Sua turma chegou.", "Saudades de você.", "Saturnino chegou cedo.", "", "..."])
    assert.equal(lerChamada(t).citou, false, t);
  assert.equal(lerChamada("Atlas, abre o painel", "Atlas").citou, true, "o nome vem da configuração");
  assert.equal(lerChamada("Atena, abre o painel", "Atlas").citou, false);
});

test("Chamada, fora da Central: sem o nome nada chega à Central e nenhum texto fica; com o nome vai sem ele; só o nome chama", async () => {
  const { b, ouvido, caixa } = await preparar();
  ouvido("Como estão as tarefas?", "Vou almoçar daqui a pouco, Atena.", "Atena, como estão as tarefas?", "Atena.");
  for (let i = 0; i < 2; i++) {
    const r = await ouvir(b, q(NOME));
    assert.deepEqual(Object.keys(r.json).sort(), ["ms", "semNome"], "o texto não volta nem à tela");
  }
  assert.equal((await mensagens(b)).length, 0); assert.equal(registro(caixa).length, 0);
  assert.doesNotMatch(registroVoz(caixa), /tarefas|almoçar/, "voz.jsonl sem texto");
  const r = await ouvir(b, q(NOME));
  assert.equal(r.json.texto, "Como estão as tarefas?");
  await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Como estão as tarefas?");
  await esperarEvento(b, () => conversas(caixa).length === 1);
  assert.doesNotMatch(conversas(caixa)[0].msg, /Atena/, "o agente recebe sem o nome");
  assert.deepEqual(Object.keys((await ouvir(b, q(NOME))).json).sort(), ["chamado", "ms"]);
  assert.equal((await mensagens(b)).length, 1, "só o nome não vira mensagem");
  assert.match(registroVoz(caixa), /"exige":"nome".*"resultado":"semNome"/);
  assert.equal((await ouvir(b, q("exige=outra"))).status, 400);
});

test("Chamada, comandos: desligar pede o nome fora da Central, também na janela; cortar com o board falando não pede; na Central é como sempre", async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta da Central.", "segunda", "terceira"] });
  await b.api("POST", "/api/conversa/central", { texto: "oi" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const antes = (await mensagens(b)).length;
  ouvido("Modo texto.", "Para de falar.", "Modo texto.", "Espera.", "Espera.", "Atena, modo texto.", "Atena, espera.", "Quanto tempo levou?", "Atena, quanto tempo levou?");
  assert.equal((await ouvir(b, q(NOME))).json.semNome, true);
  assert.equal((await ouvir(b, q(JANELA))).json.semNome, true, "na janela desligar também pede o nome");
  assert.equal((await ouvir(b, `modo=falando&n=1&${NOME}`)).json.semNome, true, "falando por cima, idem");
  assert.equal((await ouvir(b, q(NOME))).json.semNome, true, "'espera' solto, sem o board falando, não é comando");
  assert.equal((await ouvir(b, `modo=falando&n=1&${NOME}`)).json.comando, "cortar", "calar o board é na hora");
  assert.equal((await ouvir(b, q(NOME))).json.comando, "desligar");
  assert.equal((await ouvir(b, `modo=falando&n=1&${NOME}`)).json.comando, "cortar");
  assert.equal((await ouvir(b, `modo=falando&n=1&${NOME}`)).json.semNome, true, "por cima sem o nome não é continuação");
  assert.ok((await ouvir(b, `modo=falando&n=1&${NOME}`)).json.enviado);
  assert.equal((await mensagens(b)).length, antes + 1);
  // A Central à vista: nada exige o nome, a mensagem segue como foi dita, e o comando com o nome também vale
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 2);
  ouvido("Como está a fila?", "Atena está lento hoje?", "Atena, modo texto.", "Modo texto.");
  assert.equal((await ouvir(b)).json.texto, "Como está a fila?");
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 3);
  assert.equal((await ouvir(b)).json.texto, "Atena está lento hoje?");
  assert.equal((await ouvir(b)).json.comando, "desligar");
  assert.equal((await ouvir(b)).json.comando, "desligar");
  assert.equal(registro(caixa).filter((a) => a.origem === "voz").length, 3, "só o que virou mensagem");
});

test("Chamada, janela: a continuação dispensa o nome, tira o nome se ele vier, e comando mal ouvido com o nome é salvo na 2ª passada", async () => {
  const { b, ouvido, caixa } = await preparar();
  const comando = (...l) => writeFileSync(join(caixa.home, "ouvido-comando.txt"), l.join("\n") + "\n");
  ouvido("E o CRM?", "Atena, e o ERP?");
  assert.equal((await ouvir(b, q(JANELA))).json.texto, "E o CRM?");
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  assert.equal((await ouvir(b, q(JANELA))).json.texto, "E o ERP?");
  ouvido("Atena, mal o texto."); comando("Atena, modo texto.");
  assert.equal((await ouvir(b, q(NOME))).json.comando, "desligar");
  // 🔴 Silêncio com o prompt devolvido e invenção do whisper não passam por ter o nome
  ouvido("", "Board, Loja, ERP, Atena");
  assert.equal((await ouvir(b, q(NOME))).json.nada, true);
  assert.equal((await ouvir(b, q(NOME))).json.nada, true);
});

test("Chamada, 🔴 SIM falado: com o nome, na janela e em outra tela continua sem valer", async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Posso?\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa", "Repita no botão.", "de novo"] });
  await b.api("POST", "/api/conversa/central", { texto: "mesclar?" });
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  ouvido("Atena, sim.", "Sim.");
  for (const [i, x] of [NOME, JANELA].entries()) {
    const r = await ouvir(b, q(x));
    const ap = registro(caixa).find((a) => a.id === r.json.enviado);
    assert.equal(ap.origem, "voz"); assert.equal(ap.texto, "Sim.");
    const nao = conferir(caixa, b, ap.id, "mesclar o PR #112 do alfa");
    assert.equal(nao.code, 1, nao.out); assert.match(nao.out, /SIM por voz não vale/);
    await esperarEvento(b, (e) => e.t === "resultado" && e.n === i + 2);
  }
});

test("Chamada, o nome numa configuração só: BOARD_VOZ_NOME troca o reconhecer, o vocabulário do whisper e a tela", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ env: { BOARD_VOZ_NOME: "Atlas" } });
  ouvido("Atena, como estão as tarefas?", "Atlas, como estão as tarefas?");
  assert.equal((await ouvir(b, q(NOME))).json.semNome, true);
  assert.equal((await ouvir(b, q(NOME))).json.texto, "Como estão as tarefas?");
  assert.match(readFileSync(join(caixa.home, "whisper.log"), "utf8"), /--prompt Atlas, Board/, "o nome está no vocabulário");
  assert.doesNotMatch(readFileSync(join(caixa.home, "whisper.log"), "utf8"), /Atena/);
  assert.equal((await b.api("GET", "/api/voz/estado")).json.nome, "Atlas");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await esperarNaTela(nav, `/COMEÇA com “Atlas”/.test($(".voz-limites").textContent)`);
    await nav.avaliar(`navigateBoard("prs")`);
    await esperarNaTela(nav, `/comece com “Atlas”/.test($("#vozFora").innerText)`);
  } finally { await nav.fechar(); }
});

test("Tela: em outra tela só vale com o nome; a resposta abre a continuação, a continuação vence, e a Central à vista dispensa o nome", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Tudo em dia.", "O CRM também.", "E o ERP."] });
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /👂 ouvindo\b(?!:)/, "na Central o rótulo é o de sempre");
    await nav.avaliar(`navigateBoard("prs")`);
    await esperarNaTela(nav, `/comece com “Atena”/.test($("#vozFora").innerText)`);

    ouvido("Conversa com outra pessoa na sala.", "Atena, como estão as tarefas?", "E o CRM?", "Outra pessoa de novo.");
    await falar(nav);
    await esperarNaTela(nav, `VOZ.ouvidas === 1 && VOZ.ultima?.semNome && VOZ.fase === "ouvindo"`);
    assert.equal((await mensagens(b)).length, 0, "descartada, sem ir à Central");
    await falar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Como estão as tarefas?");
    assert.equal(await nav.avaliar(`location.hash`), "#/prs");
    await esperarNaTela(nav, `VOZ.falas === 1 && !VOZ.fala`);
    await esperarNaTela(nav, `/pode continuar/.test($("#vozFora").innerText)`);
    await falar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "E o CRM?");
    await esperarNaTela(nav, `VOZ.falas === 2 && !VOZ.fala`);
    // A janela venceu: volta a pedir o nome
    await nav.avaliar(`VOZ.janelaAte = Date.now() - 1; pintarVoz()`);
    await esperarNaTela(nav, `/comece com/.test($("#vozFora").innerText)`);
    await falar(nav);
    await esperarNaTela(nav, `VOZ.ouvidas === 4 && VOZ.ultima?.semNome`);
    assert.equal((await mensagens(b)).length, 2);

    // Ajustável, sem precisar de código
    await nav.avaliar(`location.hash = "#/central"`);
    await esperarNaTela(nav, `!!$("#vozJanela")`);
    assert.equal(await nav.avaliar(`$("#vozJanela").value`), "15", "padrão 15 s");
    await nav.avaliar(`(() => { const s = $("#vozJanela"); s.value = 30; s.dispatchEvent(new Event("input")); })()`);
    assert.equal(await nav.avaliar(`[VOZ.janela(), $("#vozJanelaTxt").textContent].join()`), "30,30 s");
    assert.equal(await nav.avaliar(`(vozAbrirJanela(), Math.round((VOZ.janelaAte - Date.now()) / 1000))`), 30);
    await nav.avaliar(`VOZ.janelaAte = 0; 1`);

    // Na Central à vista, sem o nome e sem janela, vai como sempre
    await esperarNaTela(nav, `!/comece com/.test($("#vozFora").innerText)`);
    ouvido("Pergunta na Central.");
    await falar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Pergunta na Central.");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: a Central com a aba escondida de verdade exige o nome; falar por cima sem o nome devolve a voz, com o nome corta; 'Atena' sozinho chama", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta.", "Segunda resposta."] });
  writeFileSync(join(caixa.home, "fala-ms"), "20000");
  const nav = await tela(caixa, [[0, 120000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await darPermissaoDoBloqueio(nav, b);
    await ligada(nav, b);
    await esperarNaTela(nav, `VOZ.sabeBloqueio`);
    await esconderDeVerdade(nav);
    assert.equal(await nav.avaliar(`[!!view.central, vozExige()].join()`), "true,nome");
    ouvido("Conversa na sala.");
    await falar(nav);
    await esperarNaTela(nav, `VOZ.ultima?.semNome === true`);
    assert.equal((await mensagens(b)).length, 0, "a Central escondida não está à vista");

    await b.api("POST", "/api/conversa/central", { texto: "e o backup?" });
    await esperarNaTela(nav, `VOZ.fase === "falando" && !!VOZ.fala?.fonte`);
    await esperar(600);
    ouvido("Conversa por cima da voz.");
    await nav.avaliar(`VOZ.ultima = null; VOZ.janelaAte = Date.now() + 60000; 1`); // janela aberta não vale por cima da voz
    await nav.avaliar(soar(0.9, 500));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), true);
    await parar(nav);
    await esperarNaTela(nav, `VOZ.ultima?.semNome === true && !!VOZ.fala && !VOZ.fala.pausada`);
    assert.equal((await mensagens(b)).length, 1, "a voz voltou e nada foi à Central");

    await esperar(600);
    ouvido("Atena.");
    await nav.avaliar(soar(0.9, 500)); await parar(nav);
    await esperarNaTela(nav, `VOZ.ultima?.chamado === true && !VOZ.fala`);
    assert.equal(await nav.avaliar(`vozExige()`), "janela", "chamou: pode dizer o resto sem repetir");
    ouvido("Fala do que chamou.");
    await falar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Fala do que chamou.");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: fala que começou na Central termina como começou; com a resposta cortada por 'espera' a continuação abre; a amostra da voz não abre", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Uma resposta qualquer da Central.", "Outra."] });
  writeFileSync(join(caixa.home, "fala-ms"), "20000");
  const nav = await tela(caixa, [[0, 120000]]);
  try {
    await ligada(nav, b);
    ouvido("Começou aqui.");
    await nav.avaliar(soar(0.3, 400));
    await esperarNaTela(nav, `VOZ.fase === "gravando"`);
    await nav.avaliar(`navigateBoard("prs")`);
    await nav.avaliar(soar(0.3, 400)); await parar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Começou aqui.");
    await esperarNaTela(nav, `VOZ.fase === "falando" && !!VOZ.fala?.fonte`);
    await esperar(600);
    ouvido("Espera.");
    await nav.avaliar(soar(0.9, 500)); await parar(nav);
    await esperarNaTela(nav, `!VOZ.fala && VOZ.ultima?.comando === "cortar"`);
    assert.equal(await nav.avaliar(`vozExige()`), "janela");
    await nav.avaliar(`VOZ.janelaAte = 0; vozTocar(null, { texto: "amostra" }, { amostra: true }); vozFimDaFala(); 1`);
    assert.equal(await nav.avaliar(`vozExige()`), "nome", "a amostra não é resposta");
    // Desligar na janela, sem o nome, não desliga; com o nome desliga
    await nav.avaliar(`vozAbrirJanela(); 1`);
    ouvido("Modo texto.", "Atena, modo texto.");
    await nav.avaliar(`VOZ.ultima = null; 1`);
    await falar(nav);
    await esperarNaTela(nav, `VOZ.ultima?.semNome === true`);
    assert.equal(await nav.avaliar(`VOZ.ligado()`), true);
    await falar(nav);
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
