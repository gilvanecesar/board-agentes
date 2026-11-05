// 🎙 Modo voz com o board em segundo plano (#303): "preciso estar em outra tela e quando eu falar você me responde".
// Chrome de verdade, aba `hidden` de verdade (outra aba na frente, timers estrangulados), microfone falso tocando o tom com ela
// escondida e o IdleDetector real dizendo se a tela bloqueou. O falso de `visibilityState` das outras baterias não prova nada aqui.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { esperar } from "./ajuda.mjs";
import { bloquearTela, comChrome, darPermissaoDoBloqueio, esconderDeVerdade, espiarMic, esperarEvento, esperarNaTela, eventos, ligada, limparVoz, micFechado, parar, preparar, soar, tela } from "./voz-ajuda.mjs";

afterEach(limparVoz);

const comVigia = `VOZ.sabeBloqueio && !!VOZ.stream`;
async function ligadaComVigia(nav, b) {
  await nav.carregar(b.url + "/#/central");
  await darPermissaoDoBloqueio(nav, b);
  await ligada(nav, b, { espiar: true });
  await esperarNaTela(nav, comVigia);
}

test("Tela: aba escondida de verdade: a fala do microfone chega à Central, a resposta toca inteira, e a conversa segue sem voltar ao board", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Respondi com a aba escondida.", "Segunda resposta."] });
  writeFileSync(join(caixa.home, "fala-ms"), "2500");
  const nav = await tela(caixa, [[0, 6000], [220, 900], [0, 60000]]); // o tom sai do arquivo com a aba já escondida, pelo worklet
  try {
    await ligadaComVigia(nav, b);
    assert.match(await nav.avaliar(`document.title`), /🎙 ouvindo/);
    await nav.avaliar(`window.__s = VOZ.stream; navigateBoard("prs")`);
    ouvido("Atena, fala com a aba escondida.", "Segunda fala."); // a segunda, sem o nome: é a continuação depois da resposta (#305)
    await esconderDeVerdade(nav);
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 0, "o tom tem de sair com a aba escondida");
    // Os timers estão mesmo estrangulados: nada do caminho pode depender deles
    const ticks = await nav.avaliar(`new Promise((ok) => { let n = 0; const t = setInterval(() => n++, 50); new Promise((r) => { const c = VOZ.no.port; const antes = c.onmessage; let q = 0; c.onmessage = (e) => { antes(e); if (++q === 40) { c.onmessage = antes; r(); } }; }).then(() => { clearInterval(t); ok(n); }); })`);
    assert.ok(ticks <= 4, `em 2 s de áudio o timer de 50 ms rodaria 40 vezes; rodou ${ticks}`);

    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Fala com a aba escondida.", 15000);
    await esperarNaTela(nav, `VOZ.falas === 1 && !!VOZ.fala?.fonte`);
    const t0 = Date.now();
    assert.equal(await nav.avaliar(`document.visibilityState === "hidden" && VOZ.ctx.state === "running" && VOZ.fala.fonte.buffer.duration >= 2`), true, "tocando escondida");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.ok(Date.now() - t0 >= 1500, "a resposta toca no tempo do áudio, não acaba de cara");
    assert.equal(await nav.avaliar(`VOZ.stream === window.__s && VOZ.stream.getAudioTracks()[0].readyState === "live" && document.visibilityState === "hidden"`), true, "o mesmo microfone segue aberto");
    assert.match(await nav.avaliar(`document.title`), /🎙 ouvindo/, "o título é o aviso que sobra");

    // Sem tocar em nada: a próxima fala também vai, e também é respondida
    await nav.avaliar(soar(0.3, 500)); await parar(nav);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Segunda fala.");
    await esperarNaTela(nav, `VOZ.falas === 2`);
    assert.equal(await nav.avaliar(`VOZ.ligado() && VOZ.dona()`), true);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: tela do aparelho bloqueada fecha o microfone mesmo com a aba escondida: o trecho vai, a fala termina, e desbloquear reabre", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Primeira resposta.", "Segunda resposta."] });
  writeFileSync(join(caixa.home, "fala-ms"), "2500");
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligadaComVigia(nav, b);
    await b.api("POST", "/api/conversa/central", { texto: "primeira" });
    await esperarNaTela(nav, `VOZ.fase === "falando"`);
    await nav.avaliar(`window.__f = VOZ.fala; 1`);
    const aba = await esconderDeVerdade(nav);
    await bloquearTela(nav);
    await esperarNaTela(nav, `VOZ.bloqueada && VOZ.stream === null`);
    assert.equal(await nav.avaliar(`${micFechado} && VOZ.ligado()`), true, "microfone fechado de verdade, modo ligado");
    assert.equal(await nav.avaliar(`VOZ.fala === window.__f && !VOZ.fala.pausada`), true, "a fala em curso termina");
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /tela bloqueada/);
    assert.match(await nav.avaliar(`document.title`), /microfone fechado/);
    assert.doesNotMatch(await nav.avaliar(`document.title`), /ouvindo/);
    // Resposta que chega com a tela bloqueada também é falada
    await b.api("POST", "/api/conversa/central", { texto: "segunda" });
    await esperarNaTela(nav, `VOZ.falas === 2`);
    await esperarNaTela(nav, `!VOZ.fala`);
    // Desbloqueou com o board ainda escondido: ele está em outro programa, e a conversa volta sem precisar abrir o board
    await bloquearTela(nav, false);
    await esperarNaTela(nav, `!VOZ.bloqueada && !!VOZ.stream && VOZ.fase === "ouvindo" && document.visibilityState === "hidden"`);
    assert.match(await nav.avaliar(`document.title`), /🎙 ouvindo/);
    // Bloqueou falando: o que ele já tinha dito vai para a Central
    ouvido("Atena, olha isso aqui.");
    await nav.avaliar(soar(0.3, 500));
    await esperarNaTela(nav, `VOZ.fase === "gravando"`);
    await bloquearTela(nav);
    await esperarNaTela(nav, `VOZ.stream === null`);
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Olha isso aqui.");
    // À vista também: bloqueio manda, e voltar à aba não reabre com a tela bloqueada
    await aba.voltar();
    await esperar(300);
    assert.equal(await nav.avaliar(`VOZ.stream === null`), true);
    await bloquearTela(nav, false);
    await esperarNaTela(nav, `!!VOZ.stream`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: sem a permissão de saber do bloqueio, aba escondida de verdade fecha o microfone, e a tela diz por quê", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await ligada(nav, b, { espiar: true });
    assert.equal(await nav.avaliar(`VOZ.sabeBloqueio`), false);
    await esperarNaTela(nav, `/Fora de vista o microfone fecha/.test($("#vozAviso").textContent)`);
    assert.match(await nav.avaliar(`$(".voz-limites").textContent`), /ponto vermelho do Chrome.*título da aba/, "o que sobra de aviso está escrito");
    const aba = await esconderDeVerdade(nav);
    await esperarNaTela(nav, micFechado);
    assert.equal(await nav.avaliar(`VOZ.stream === null && VOZ.ligado()`), true);
    assert.match(await nav.avaliar(`document.title`), /microfone fechado/);
    await aba.voltar();
    await esperarNaTela(nav, `!!VOZ.stream`);
    // Deu a permissão com o modo ligado: vale sem desligar, e o aviso sai
    await darPermissaoDoBloqueio(nav, b);
    await esperarNaTela(nav, `VOZ.sabeBloqueio`);
    await esperarNaTela(nav, `!$("#vozAviso").textContent.includes("Fora de vista")`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: modo desligado escondido não abre microfone nem vigia nada, Desligar com a aba escondida solta tudo, e a escuta do comando continua só na Central à vista", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await darPermissaoDoBloqueio(nav, b);
    await esperarNaTela(nav, `!!$(".voz-botao") && connected`);
    await nav.avaliar(espiarMic);
    let aba = await esconderDeVerdade(nav);
    await esperar(300);
    assert.deepEqual(await nav.avaliar(`[window.__trilhas.length, VOZ.sabeBloqueio, document.title]`), [0, false, "Board"], "desligado: nada ouve");
    await aba.voltar();

    await nav.avaliar(`document.querySelector("#vozComando").click()`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    aba = await esconderDeVerdade(nav);
    await esperarNaTela(nav, `VOZ.stream === null`);
    await aba.voltar();
    await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`navigateBoard("prs")`);
    await esperarNaTela(nav, `VOZ.stream === null`);
    await nav.avaliar(`location.hash = "#/central"`);
    await esperarNaTela(nav, `!!VOZ.stream`);
    await nav.avaliar(`document.querySelector("#vozComando").click()`);
    await esperarNaTela(nav, `VOZ.stream === null`);

    await nav.avaliar(`document.querySelector(".voz-botao").click()`);
    await esperarNaTela(nav, comVigia);
    await esconderDeVerdade(nav);
    assert.equal(await nav.avaliar(`!!VOZ.stream`), true, "ligado: escondida segue ouvindo");
    await nav.avaliar(`vozDesligar()`);
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.sabeBloqueio && ${micFechado}`);
    await esperarNaTela(nav, `document.title === "Board"`);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: com duas abas do board atrás de outra, só a dona ouve e fala; a de trás fica sem microfone", comChrome, async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["Uma voz só."] });
  const nav = await tela(caixa, [[0, 60000]]);
  const outra = (expr) => nav.avaliar(`window.__o.eval(${JSON.stringify(expr)})`);
  try {
    await ligadaComVigia(nav, b);
    await nav.avaliar(`window.__o = window.open(location.origin + "/#/prs", "_blank"); 1`);
    await esperarNaTela(nav, `window.__o?.document?.readyState === "complete" && window.__o.eval("typeof VOZ === 'object' && !!VOZ.stream && VOZ.sabeBloqueio")`); // nasceu à vista e assumiu
    await esperarNaTela(nav, `VOZ.stream === null && !VOZ.sabeBloqueio`);
    assert.match(await nav.avaliar(`$("#vozFora").innerText`), /outra aba/);
    assert.equal(await nav.avaliar(`document.title`), "Board", "a de trás não diz que ouve");
    await esconderDeVerdade(nav);
    await esperarNaTela(nav, `window.__o.document.visibilityState === "hidden"`);
    await esperar(300);
    assert.equal(await outra(`!!VOZ.stream`), true, "a dona segue ouvindo, escondida");
    assert.equal(await nav.avaliar(`VOZ.stream === null`), true);
    ouvido("Atena, uma fala.");
    await outra(soar(0.3, 500)); await outra(soar(0, 1700));
    await esperarEvento(b, (e) => e.t === "dono" && e.voz && e.texto === "Uma fala.");
    await esperarNaTela(nav, `window.__o.eval("VOZ.falas === 1")`);
    assert.equal(await nav.avaliar(`VOZ.falas`), 0, "uma voz só");
    assert.equal((await eventos(b)).filter((e) => e.t === "dono" && e.voz).length, 1, "uma mensagem só");
  } finally { await nav.fechar(); }
});
