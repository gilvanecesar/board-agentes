// 🎙 Modo voz, as bordas (#296): o que acontece em volta da troca de tela. Aba escondida sem a permissão do bloqueio, trava de tela,
// microfone morto, recarregar, duas abas e o ditado. Chrome de verdade com microfone falso. A troca de tela está em voz-telas.test.mjs;
// o board em segundo plano com a permissão (#303), em voz-fundo.test.mjs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { comChrome, esconder, espiarMic, micFechado, esperarEvento, esperarNaTela, ligada, limparVoz, preparar, recarregar, soar, tela } from "./voz-ajuda.mjs";

afterEach(limparVoz);

test("Tela: sem saber se a tela bloqueou (sem a permissão), aba escondida fecha o microfone sem desligar o modo: a fala termina, o trecho no meio vai, a resposta é falada, e ele reabre na volta", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta.", "Segunda resposta."] });
  writeFileSync(join(caixa.home, "fala-ms"), "2500");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b, { espiar: true });
    await nav.avaliar(`navigateBoard("prs")`);
    await b.api("POST", "/api/conversa/central", { texto: "primeira" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    await esconder(nav);
    await esperarNaTela(nav, micFechado);
    assert.equal(await nav.avaliar(`VOZ.stream === null && VOZ.ligado() && !!VOZ.fala && !VOZ.fala.pausada`), true, "microfone fechado de verdade, fala seguindo");
    await esperarNaTela(nav, `!VOZ.fala && VOZ.falas === 1`);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /microfone fechado/);
    // A resposta que chega com a aba escondida também é falada
    await b.api("POST", "/api/conversa/central", { texto: "segunda" });
    await esperarNaTela(nav, `VOZ.falas === 2`);
    await esperarNaTela(nav, `!VOZ.fala`);
    await esconder(nav, false);
    await esperarNaTela(nav, `!!VOZ.stream && VOZ.fase === "ouvindo"`);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /ouvindo/);
    // Escondeu falando: o que ele já tinha dito vai para a Central
    ouvido("Olha isso aqui.");
    await nav.avaliar(soar(0.3, 500));
    await esperarNaTela(nav, `VOZ.fase === "gravando"`);
    await esconder(nav);
    await esperarNaTela(nav, `VOZ.stream === null`);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Olha isso aqui.");
    await esconder(nav, false);
    await esperarNaTela(nav, `!!VOZ.stream`);
    // Voltou com a voz ainda falando: reabre sem achar que está só ouvindo, e o microfone não cai na fala
    await esperarNaTela(nav, `VOZ.fala || VOZ.falas >= 3`);
    await esconder(nav); await esperarNaTela(nav, `VOZ.stream === null`);
    await esconder(nav, false); await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`vozTocar(null, { texto: "x", audio: VOZ.ctx.createBuffer(1, 44100, 22050) })`);
    await esconder(nav); await esconder(nav, false);
    await esperarNaTela(nav, `!!VOZ.stream`);
    assert.deepEqual(await nav.avaliar(`[VOZ.fase, VOZ.vad.extra >= 0.02]`), ["falando", true]);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: esconder e voltar não deixa trava de tela sobrando: uma só com o modo ligado, nenhuma depois de Desligar (3ª reprova da QA da #296)", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 60000]]);
  const ativas = `window.__travas.filter((t) => !t.released).length`;
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!$(".voz-botao") && connected`);
    // Conta as travas de verdade; a resposta demora um pouco, que é onde dois pedidos se atropelam
    await nav.avaliar(`window.__travas = []; window.__lenta = false; { const p = navigator.wakeLock.request.bind(navigator.wakeLock); navigator.wakeLock.request = async (...a) => { const t = await p(...a); window.__travas.push(t); if (window.__lenta) await new Promise((r) => setTimeout(r, 400)); return t; }; } 1`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!!VOZ.stream && !!VOZ.trava`);
    assert.equal(await nav.avaliar(ativas), 1, "ligou: uma trava");
    await esconder(nav);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.trava`);
    await esconder(nav, false);
    await esperarNaTela(nav, `!!VOZ.stream && !!VOZ.trava`);
    await esperar(300);
    assert.equal(await nav.avaliar(ativas), 1, "voltou: uma trava");
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null`);
    await esperarNaTela(nav, `${ativas} === 0`);
    // Desligou com o pedido ainda no ar: a trava que chega depois é solta
    await nav.avaliar(`window.__lenta = true; document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `!!VOZ.stream && window.__travas.length >= 3`);
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `!VOZ.ligado() && VOZ.stream === null && !VOZ.pedindoTrava`);
    await esperarNaTela(nav, `${ativas} === 0 && !VOZ.trava`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: com o microfone morto a barra não diz 'ouvindo', nem depois de uma fala; um toque reabre (4ª reprova da QA da #296)", comChrome, async () => {
  const { b, caixa } = await preparar({ conversa: ["Resposta curta."] });
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`navigateBoard("prs")`);
    await esperarNaTela(nav, `!!$("#vozFora")`);
    await nav.avaliar(`window.__t = VOZ.stream.getAudioTracks()[0]; __t.stop(); __t.dispatchEvent(new Event("ended")); 1`);
    await esperarNaTela(nav, `/microfone cortado/.test($("#vozFora").innerText)`);
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `VOZ.falas === 1`);
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.equal(await nav.avaliar(`VOZ.fase`), "cortado", "a fala acabou e o microfone continua morto");
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /microfone cortado/);
    await nav.avaliar(`location.hash = "#/busca"`);
    await esperar(200);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /microfone cortado/, "trocar de tela não engana");
    await nav.avaliar(`document.dispatchEvent(new Event("pointerdown"))`);
    await esperarNaTela(nav, `VOZ.fase === "ouvindo" && VOZ.stream.getAudioTracks()[0].readyState === "live"`);
    assert.equal(await nav.avaliar(`VOZ.ligado()`), true);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /ouvindo/);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: recarregar em qualquer tela mantém o modo ligado: microfone reaberto já com o aviso", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b);
    await nav.avaliar(`navigateBoard("controle")`);
    await esperarNaTela(nav, `!!$("#vozFora")`);
    await nav.avaliar(`location.hash = "#/prs"; window.__mesmaCarga = true`);
    await recarregar(nav);
    await esperarNaTela(nav, `!!VOZ.stream && !!$("#vozFora")`);
    assert.equal(await nav.avaliar(`window.__mesmaCarga`), undefined, "a página nasceu de novo");
    assert.equal(await nav.avaliar(`location.hash`), "#/prs");
    assert.equal(await nav.avaliar(`VOZ.ligado()`), true);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /ouvindo|toque/);
    await nav.avaliar(`$("#vozForaDesligar").click()`);
    await esperarNaTela(nav, `VOZ.stream === null`);
    await recarregar(nav);
    await esperarNaTela(nav, `connected`);
    await esperar(500);
    assert.equal(await nav.avaliar(`VOZ.stream === null && !$("#vozFora")`), true, "desligado continua desligado");
  } finally { await nav.fechar(); }
});

test("Tela: com duas abas do board só uma ouve e fala; clicar na outra passa o modo, e desligar numa desliga nas duas", comChrome, async () => {
  const { b, caixa } = await preparar({ conversa: ["Primeira.", "Segunda."] });
  writeFileSync(join(caixa.home, "fala-ms"), "20000");
  const nav = await tela(caixa, [[0, 60000]]);
  const outra = (expr) => nav.avaliar(`window.__o.eval(${JSON.stringify(expr)})`);
  try {
    await ligada(nav, b);
    await nav.avaliar(`window.__o = window.open(location.origin + "/#/prs", "_blank"); 1`);
    await esperarNaTela(nav, `window.__o?.document?.readyState === "complete" && window.__o.eval("typeof VOZ === 'object' && !!$('#navigation a')")`);
    await esperar(800);
    // Abriu visível e assumiu: a primeira largou. Volta para a primeira, que passa a ser a dona.
    await esperarNaTela(nav, `window.__o.eval("!!VOZ.stream") && VOZ.stream === null`);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /outra aba/, "quem não ouve diz por quê");
    await esconder(nav, false); // a aba de trás fica escondida de verdade: é ele voltando a ela
    await esperarNaTela(nav, `!!VOZ.stream && window.__o.eval("VOZ.stream === null")`);
    assert.match(await outra(`$("#vozFora").innerText`), /outra aba/);
    await b.api("POST", "/api/conversa/central", { texto: "oi" });
    await esperarNaTela(nav, `VOZ.fala`);
    await esperar(300);
    assert.equal(await outra(`VOZ.falas`), 0, "uma voz só");
    assert.equal(await nav.avaliar(`VOZ.falas`), 1);
    // A que não é dona passa a ser no clique, e a fala da outra acaba ali
    await outra(`document.dispatchEvent(new Event("pointerdown"))`);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.fala && window.__o.eval("!!VOZ.stream")`);
    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, `window.__o.eval("VOZ.stream === null && !$('#vozFora')")`);
  } finally { await nav.fechar(); }
});

test("Tela: com o 🎤 ditado gravando a fala não vai à Central e a barra diz; sair da caixa encerra, o texto fica no rascunho e o modo volta a ouvir (4ª reprova da QA da #296)", comChrome, async () => {
  const { b, caixa, ouvido } = await preparar();
  const nav = await tela(caixa, [[0, 60000]]);
  const quadros = (n) => `for (let i = 0; i < ${n}; i++) VOZ.no.port.onmessage({ data: new Float32Array(2400).fill(0.3) }); 1`; // o caminho do worklet, com a trava do ditado
  try {
    await ligada(nav, b);
    await nav.avaliar(`location.hash = "#/c/alfa"`);
    await esperarNaTela(nav, `!!$("#convIn") && !!$(".ib.microfone")`);
    await nav.avaliar(`$("#convIn").value = "antes"; $("#convIn").dispatchEvent(new Event("input")); $(".ib.microfone").click()`);
    await esperarNaTela(nav, `ditado === "gravando"`);
    await esperarNaTela(nav, `/ditando na caixa/.test($("#vozFora").innerText)`);
    await nav.avaliar(quadros(12));
    assert.equal(await nav.avaliar(`VOZ.vad.emFala`), false, "a fala é da caixa");
    ouvido("texto ditado aqui");
    await nav.avaliar(`navigateBoard("controle")`);
    await esperarNaTela(nav, `ditado === "parado"`);
    await esperarNaTela(nav, `/ouvindo/.test($("#vozFora").innerText) && !/ditando/.test($("#vozFora").innerText)`);
    assert.equal(await nav.avaliar(`store.get("rascunho.conversa.alfa", "")`), "antes texto ditado aqui", "o que ele ditou não se perde");
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 0, "nada foi à Central");
    await nav.avaliar(quadros(12));
    assert.equal(await nav.avaliar(`VOZ.vad.emFala`), true, "parou o ditado, volta a ouvir");
    await nav.avaliar(`VOZ.vad.limpar(); location.hash = "#/c/alfa"`);
    await esperarNaTela(nav, `$("#convIn")?.value === "antes texto ditado aqui"`);
    // Na mesma caixa continua como sempre: o texto entra nela
    ouvido("mais um pouco");
    await nav.avaliar(`$(".ib.microfone").click()`);
    await esperarNaTela(nav, `ditado === "gravando"`);
    await esperar(300);
    await nav.avaliar(`$(".ib.microfone").click()`);
    await esperarNaTela(nav, `ditado === "parado" && $("#convIn").value === "antes texto ditado aqui mais um pouco"`);
    // A conversa de OUTRO projeto tem o mesmo #convIn: o ditado não vai parar nela
    ouvido("sem caixa certa");
    await nav.avaliar(`$("#convIn").value = ""; $("#convIn").dispatchEvent(new Event("input")); $(".ib.microfone").click()`);
    await esperarNaTela(nav, `ditado === "gravando"`);
    await nav.avaliar(`location.hash = "#/central"`);
    await esperarNaTela(nav, `ditado === "parado" && !!view.central`);
    assert.equal(await nav.avaliar(`$("#convIn").value`), "");
    assert.equal(await nav.avaliar(`store.get("rascunho.conversa.alfa", "")`), "sem caixa certa");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
