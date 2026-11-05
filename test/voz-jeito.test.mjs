// 🎙 O jeito de falar do modo voz (#313): tom de colega na regra da Central, texto lido como se fala e os ajustes do Piper
// (velocidade, entonação, variação, pausa entre frases) no painel. Piper e whisper falsos; o Piper falso anota os argumentos.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { conversas, esperarEvento, esperarNaTela, limparVoz, ouvir, preparar, tela, comChrome } from "./voz-ajuda.mjs";
import { paraPronuncia, textoDaFala } from "../servidor/voz-texto.mjs";

afterEach(limparVoz);
const piper = (caixa) => readFileSync(join(caixa.home, "piper.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const arg = (args, nome) => args[args.indexOf(nome) + 1];
const fala = (b, corpo) => fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", origin: b.url }, body: JSON.stringify(corpo) });

test("Voz, como se fala: data, hora, dinheiro, unidade, seta e sigla viram o que um colega diria; o resto fica", () => {
  const casos = [
    ["Subiu às 14:30 do dia 02/11.", "Subiu às 14 e 30 do dia 2 de novembro."],
    ["Em 01/11/2026 às 9h, depois 1h05 e 13:00.", "Em primeiro de novembro de 2026 às 9 horas, depois uma e 5 e 13 horas."],
    ["Custou US$ 0,15, US$ 2,5 e R$ 1.500,00; R$ 1,00.", "Custou 15 centavos de dólar, 2 dólares e 50 centavos e 1.500 reais; 1 real."],
    ["Levou 5 min, 1 s, 30 s, 1,5 s e 200 ms; 12 MB, 2x e 3 × 4.", "Levou 5 minutos, 1 segundo, 30 segundos, 1,5 segundos e 200 milissegundos; 12 megas, 2 vezes e 3 vezes 4."],
    ["PR → main, e.g. sim/não, ~3 tarefas.", "pê erre para main, por exemplo sim ou não, uns 3 tarefas."],
    ["A API devolveu JSON e a URL no CLI.", "A a pê í devolveu jêisson e a u erre ele no cê ele í."],
  ];
  for (const [de, para] of casos) assert.equal(paraPronuncia(de), para, de);
  assert.equal(paraPronuncia("Faltam 3/4 da fila."), "Faltam 3/4 da fila.", "fração não vira data");
  assert.equal(paraPronuncia("Os PRs estão em dia."), "Os pê erres estão em dia.");
});

test("Voz, texto da fala: título não se lê, parêntese e travessão viram pausa", () => {
  assert.equal(textoDaFala("## Resumo\nOlha, **terminei** (a #286) — tudo certo.\n- Commit pronto ✅"), "Olha, terminei, a 286, tudo certo. Commit pronto.");
  assert.equal(textoDaFala("# Só título"), "A resposta está na tela.");
  assert.equal(textoDaFala("Terminei a mudança no servidor (`servidor/voz.mjs`)."), "Terminei a mudança no servidor.", "parêntese que só tinha código some sem deixar vírgula");
});

test("Voz, rota: padrão medido (pausa 0,4 s); o ajuste pedido chega ao Piper dentro dos limites, o estado diz os limites, e o registro guarda o ajuste", async () => {
  const { b, caixa } = await preparar();
  const est = (await b.api("GET", "/api/voz/estado")).json;
  assert.deepEqual(est.piper.ajuste.pausa, { min: 0, max: 1, padrao: 0.4 });
  assert.equal(est.piper.ajuste.ritmo.padrao, 1);
  assert.equal((await fala(b, { amostra: true })).status, 200);
  let [p] = piper(caixa);
  assert.deepEqual(["--length_scale", "--noise_scale", "--noise_w", "--sentence_silence"].map((n) => arg(p.args, n)), ["1", "0.667", "0.8", "0.4"]);
  assert.match(p.texto, /^Oi, sou eu, a voz da Central\. Olha/, "a amostra fala como colega");
  assert.equal((await fala(b, { amostra: true, ajuste: { ritmo: 0.9, entonacao: 5, variacao: 0.5, pausa: 0.7, outro: "--rm" } })).status, 200);
  p = piper(caixa)[1];
  assert.deepEqual(["--length_scale", "--noise_scale", "--noise_w", "--sentence_silence"].map((n) => arg(p.args, n)), ["0.9", "1", "0.5", "0.7"]);
  assert.ok(!p.args.includes("--rm") && !p.args.includes("outro"), "só os quatro ajustes conhecidos viram argumento");
  assert.equal((await fala(b, { amostra: true, ajuste: { ritmo: null, entonacao: "x", variacao: "", pausa: -3 } })).status, 200);
  p = piper(caixa)[2];
  assert.deepEqual(["--length_scale", "--noise_scale", "--noise_w", "--sentence_silence"].map((n) => arg(p.args, n)), ["1", "0.667", "0.8", "0"], "torto vira padrão; fora do limite vira o limite");
  const log = readFileSync(join(caixa.board, "data", "logs", "voz.jsonl"), "utf8");
  assert.match(log, /"ajuste":\{"ritmo":0.9,"entonacao":1,"variacao":0.5,"pausa":0.7\}/);
});

test("Voz, regra 🔴: a mensagem falada pede tom de colega e mantém SIM recusado e PEDIDO DE SIM; a fala sai dita como colega", async () => {
  const { b, ouvido, caixa } = await preparar({ conversa: ["## Status\nOlha, a #286 subiu às 14:30 (R$ 0,15).\n\nPEDIDO DE SIM: mesclar o PR #112 do alfa"] });
  ouvido("Como estão as tarefas?");
  assert.match((await ouvir(b)).json.enviado, /^[0-9a-f]{12}$/);
  await esperarEvento(b, (e) => e.t === "resultado" && e.n === 1);
  const msg = conversas(caixa).at(-1).msg;
  assert.match(msg, /colega de trabalho/); assert.match(msg, /primeira pessoa/); assert.match(msg, /"olha", "beleza", "fechou"/);
  assert.match(msg, /NÃO é aprovação/); assert.match(msg, /repita a linha PEDIDO DE SIM e diga que ele aprova no botão/);
  const regras = readFileSync(join(caixa.board, "servidor", "central.mjs"), "utf8");
  assert.match(regras, /tom de colega.*SIM por voz continua sem valer e o PEDIDO DE SIM continua/);
  const r = await fala(b, { n: 1 });
  assert.equal(decodeURIComponent(r.headers.get("x-voz-texto")), "Olha, a 286 subiu às 14:30, R$ 0,15. Preciso do seu sim para: mesclar o PR 112 do alfa. Aprove no botão Aprovar da tela: sim falado não vale.");
  assert.equal(piper(caixa).at(-1).texto.trim(), "Olha, a 286 subiu às 14 e 30, 15 centavos. Preciso do seu sim para: mesclar o pê erre 112 do alfa. Aprove no botão Aprovar da tela: sim falado não vale.");
});

test("Tela: os ajustes do jeito de falar ficam no painel, vão no ▶ ouvir e voltam ao padrão", comChrome, async () => {
  const { b, caixa } = await preparar();
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await nav.avaliar(`store.set("vozAberto.ajustes", true); store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream && document.querySelectorAll("#vozJeito input[type=range]").length === 4`);
    assert.equal(await nav.avaliar(`$('[data-jeito-txt="pausa"]').textContent`), "0,4 s");
    assert.equal(await nav.avaliar(`$('[data-jeito-txt="ritmo"]').textContent`), "100%");
    await nav.avaliar(`for (const [k, v] of [["ritmo", -0.8], ["pausa", 0.6]]) { const i = $('[data-jeito="' + k + '"]'); i.value = v; i.dispatchEvent(new Event("input")); }`);
    assert.equal(await nav.avaliar(`$('[data-jeito-txt="ritmo"]').textContent`), "125%", "para a direita = mais rápida");
    assert.deepEqual(await nav.avaliar(`store.get("vozAjuste")`), { ritmo: 0.8, pausa: 0.6 });
    await nav.avaliar(`$("#vozVozes button").click()`);
    await esperarNaTela(nav, `VOZ.fala?.amostra === true`);
    const p = piper(caixa).at(-1);
    assert.equal(arg(p.args, "--length_scale"), "0.8"); assert.equal(arg(p.args, "--sentence_silence"), "0.6"); assert.equal(arg(p.args, "--noise_scale"), "0.667");
    await nav.avaliar(`[...document.querySelectorAll("#vozJeito button")].find((x) => /padrão/.test(x.textContent)).click()`);
    assert.deepEqual(await nav.avaliar(`[store.get("vozAjuste"), $('[data-jeito-txt="ritmo"]').textContent, $('[data-jeito="pausa"]').value]`), [{}, "100%", "0.4"]);
  } finally { await nav.fechar(); }
});
