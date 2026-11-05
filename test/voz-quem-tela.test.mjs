// 🎙 "Só a minha voz" na tela (#298), Chrome de verdade com microfone falso e o motor da voz falso.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { comChrome, esperarNaTela, espiarMic, eventos, limparVoz, ligada, micFechado, parar, soar, tela } from "./voz-ajuda.mjs";
import { cadastrar, comQuem } from "./voz-quem-ajuda.mjs";
import { esperar } from "./ajuda.mjs";

afterEach(limparVoz);
const arquivo = (caixa) => join(caixa.board, "data", "voz-impressao.json");
const falar = async (nav) => { await nav.avaliar(soar(0.3, 400)); await parar(nav); };
const TOM = [[0, 200], [220, 6000]];

test("Tela: gravar, sem áudio guardado, microfone fechado depois, medição, testar e apagar", comChrome, async () => {
  const { b, caixa, nota } = await comQuem();
  const nav = await tela(caixa, TOM);
  try {
    await nav.carregar(b.url + "/#/central");
    await esperarNaTela(nav, `!!document.querySelector("#vozMinhaVoz")`);
    await nav.avaliar(espiarMic);
    assert.equal(await nav.avaliar(`window.__trilhas.length`), 0, "abrir a tela não abre o microfone");
    await nav.avaliar(`location.hash = "#/voz"`);
    await esperarNaTela(nav, `!!$("#vozCadGravar")`);
    assert.match(await nav.avaliar(`$("#vozCad").innerText`), /Não é senha: gravação da sua voz ou uma voz parecida pode passar/);
    assert.match(await nav.avaliar(`$("#vozCad").innerText`), /SIM por voz continua sem valer/);
    await nav.avaliar(`$("#vozCadGravar").click()`);
    await esperarNaTela(nav, `CAD.gravando === "cadastro"`);
    await esperarNaTela(nav, `!CAD.gravando && !CAD.enviando && !!VOZ.servidor.impressao.cadastrada`);
    await esperarNaTela(nav, micFechado);
    assert.ok(existsSync(arquivo(caixa)));
    assert.equal(statSync(arquivo(caixa)).mode & 0o777, 0o600);
    assert.match(readFileSync(join(caixa.home, "quem.log"), "utf8"), /stdin cadastro \d{5,}/, "cerca de 2 s de WAV 16 kHz");
    await esperarNaTela(nav, `/2 de 3 pedaços/.test($("#vozCad").innerText)`);
    // Testar uma frase
    nota(0.05);
    await nav.avaliar(`void vozTestar()`);
    await esperarNaTela(nav, `CAD.gravando === "teste"`);
    await nav.avaliar(`vozPararGravacao(true)`);
    await esperarNaTela(nav, `$("#vozCadTeste")?.dataset.passou === "false"`);
    assert.match(await nav.avaliar(`$("#vozCadTeste").innerText`), /Voz não reconhecida: nota 0,05/);
    await esperarNaTela(nav, micFechado);
    // A sensibilidade, em duas abas não: no servidor
    await nav.avaliar(`vozAjustar(1)`);
    await esperarNaTela(nav, `VOZ.servidor.impressao.nivel === 1`);
    assert.equal(JSON.parse(readFileSync(arquivo(caixa), "utf8")).nivel, 1);
    await nav.avaliar(`window.confirm = () => true; vozApagar()`);
    await esperarNaTela(nav, `VOZ.servidor.impressao.cadastrada === false`);
    assert.equal(existsSync(arquivo(caixa)), false);
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});

test("Tela: sair da tela no meio da gravação descarta e fecha o microfone; pouca voz mostra o motivo e não grava nada", comChrome, async () => {
  const { b, caixa, quemSeg } = await comQuem();
  const nav = await tela(caixa, TOM);
  try {
    await nav.carregar(b.url + "/#/voz");
    await esperarNaTela(nav, `!!$("#vozCadGravar")`);
    await nav.avaliar(espiarMic);
    await nav.avaliar(`$("#vozCadGravar").click()`);
    await esperarNaTela(nav, `CAD.gravando === "cadastro"`);
    await nav.avaliar(`location.hash = "#/central"`);
    await esperarNaTela(nav, `!CAD.gravando`);
    await esperarNaTela(nav, micFechado);
    assert.equal(existsSync(arquivo(caixa)), false);
    assert.equal(existsSync(join(caixa.home, "quem.log")), false, "nada foi enviado");
    quemSeg(3);
    await nav.avaliar(`location.hash = "#/voz"`);
    await esperarNaTela(nav, `!!$("#vozCadGravar")`);
    await nav.avaliar(`$("#vozCadGravar").click()`);
    await esperarNaTela(nav, `!!$("#vozCadErro")`, 8000);
    assert.match(await nav.avaliar(`$("#vozCadErro").innerText`), /preciso de pelo menos/);
    assert.equal(existsSync(arquivo(caixa)), false);
  } finally { await nav.fechar(); }
});

test("Tela: gravando com o modo voz ligado, a leitura não vai à Central e a resposta espera; depois tudo volta", comChrome, async () => {
  const { b, caixa, ouvido } = await comQuem();
  const nav = await tela(caixa, TOM);
  try {
    await ligada(nav, b);
    ouvido("Não deveria chegar");
    await nav.avaliar(`location.hash = "#/voz"`);
    await esperarNaTela(nav, `!!$("#vozCadGravar")`);
    await nav.avaliar(`$("#vozCadGravar").click()`);
    await esperarNaTela(nav, `CAD.gravando === "cadastro"`);
    assert.equal(await nav.avaliar(`VOZ.cadastrando`), true);
    // O microfone do modo voz segue aberto: entrega a ele fala alta e a pausa, pelo mesmo caminho do worklet. Nada pode virar trecho.
    await nav.avaliar(`(() => { const bloco = (r) => new Float32Array(2400).fill(r).map((v, i) => i % 2 ? v : -v);
      for (let i = 0; i < 20; i++) VOZ.no.port.onmessage({ data: bloco(0.3) });
      for (let i = 0; i < 40; i++) VOZ.no.port.onmessage({ data: bloco(0) }); })()`);
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), 0, "a leitura do texto não virou mensagem");
    assert.ok(await nav.avaliar(`!!vozOcupado()`), "resposta que chegar espera a gravação");
    await esperarNaTela(nav, `!CAD.gravando && !CAD.enviando`);
    assert.equal(await nav.avaliar(`VOZ.cadastrando`), false);
    assert.equal(await nav.avaliar(`VOZ.ligado() && !!VOZ.stream`), true, "o modo voz segue");
  } finally { await nav.fechar(); }
});

test("Tela: voz não reconhecida aparece na barra, em qualquer tela, e na faixa; a fala do board continua; ao passar, some; filtro fora avisa", comChrome, async () => {
  const { b, caixa, ouvido, nota } = await comQuem();
  await cadastrar(b);
  const nav = await tela(caixa, TOM);
  try {
    await ligada(nav, b);
    await esperarNaTela(nav, `/só a sua voz: ligado/.test($("#vozMinhaVoz")?.innerText || "")`);
    assert.equal(await nav.avaliar(`$("#vozForaQuem").hidden`), true, "sem aviso antes de acontecer");
    ouvido("Não deveria chegar", "Agora sou eu");
    nota(0.05);
    await falar(nav);
    await esperarNaTela(nav, `VOZ.barradas === 1`);
    assert.equal(await nav.avaliar(`$("#vozForaQuem").innerText`), "🚫 voz não reconhecida");
    assert.match(await nav.avaliar(`$("#vozQuem").innerText`), /voz não reconhecida · 1 trecho descartado/);
    assert.match(await nav.avaliar(`document.title`), /voz não reconhecida/);
    assert.equal((await eventos(b)).filter((e) => e.t === "dono").length, 0);
    await nav.avaliar(`location.hash = "#/prs"`);
    await esperarNaTela(nav, `view.name === "prs"`);
    assert.equal(await nav.avaliar(`$("#vozForaQuem").hidden`), false, "em outra tela também");
    await nav.avaliar(`VOZ.naoReconhecidaAte = 0; pintarVoz()`);
    assert.equal(await nav.avaliar(`$("#vozForaQuem").hidden`), true, "passa sozinho");
    // Motor quebrado: a fala vai, e a barra avisa que está sem filtro
    await nav.avaliar(`location.hash = "#/central"`);
    await esperarNaTela(nav, `!!view.central && !!$("#vozFaixa")`);
    nota("quebrado");
    await falar(nav);
    await esperarNaTela(nav, `!!VOZ.filtroFora`);
    assert.match(await nav.avaliar(`$("#vozForaQuem").innerText`), /filtro de voz fora/);
    await esperar(50);
  } finally { await nav.fechar(); }
});
