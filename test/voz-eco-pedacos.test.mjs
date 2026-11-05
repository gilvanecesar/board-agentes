// 🎙 O modo voz não se ouve com o Kokoro em pedaços (#327, 03/11: "acho que foi você ouvindo você mesmo"). Chrome de verdade, Kokoro
// FALSO que demora o que o teste mandar, e o filtro da voz do dono (#298) falso, barrando tudo (nota 0,05): todo trecho é "outra voz".
// (1) som que começa enquanto o pedaço 0 é gerado não faz o Kokoro gerar o pedaço 0 de novo; (2) trecho barrado no meio da fala volta de
// onde parou, sem repedir pedaço; (3) o começo de CADA pedaço e o intervalo entre dois não interrompem a fala, e o eco é medido de novo.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { esperar } from "./ajuda.mjs";
import { comChrome, esperarNaTela, limparVoz, parar, soar, tela } from "./voz-ajuda.mjs";
import { cadastrar, MOTOR_FALSO } from "./voz-quem-ajuda.mjs";
import { comKokoro } from "./voz-kokoro-ajuda.mjs";

afterEach(limparVoz);
const RESPOSTA = "Olha, terminei a tarefa do quadro. O portão passou, o revisor aprovou e o QA também. Ficou só uma observação menor sobre o texto do botão, que você pode ver na ficha. Se quiser, eu já coloco a próxima na fila agora mesmo e te aviso quando acabar. Beleza? Qualquer coisa me chama aqui.";
const falou = (caixa) => {
  const f = join(caixa.board, "data", "logs", "voz.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.acao === "falou") : [];
};
const ouviu = (caixa) => {
  const f = join(caixa.board, "data", "logs", "voz.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.acao === "ouviu") : [];
};

test("Kokoro em pedaços: trecho barrado não recomeça a resposta, e o eco de cada pedaço e do intervalo não interrompe", comChrome, async () => {
  const { b, caixa } = await comKokoro({ conversa: [RESPOSTA, "ok"], quem: MOTOR_FALSO, env: { BOARD_VOZ_CADASTRO_S: "2" } });
  await cadastrar(b);
  const H = caixa.home;
  writeFileSync(join(H, "quem-nota"), "0.05"); // tudo o que o microfone ouvir é "outra voz"
  writeFileSync(join(H, "kokoro-ms"), "3000"); // cada pedaço toca 3 s
  writeFileSync(join(H, "kokoro-demora"), "1500"); // e leva 1,5 s para ser gerado, como o de verdade
  const nav = await tela(caixa, [[0, 60000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await nav.avaliar(`store.set("vozVoz", "kokoro-pf_dora"); store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream && VOZ.fase === "ouvindo"`);
    await b.api("POST", "/api/conversa/central", { texto: "e a tarefa?" });

    // (1) Um som (TV, outra pessoa) começa enquanto o Kokoro gera o pedaço 0: a resposta espera, e o áudio já gerado também.
    await esperarNaTela(nav, `VOZ.pedindo === true`);
    await nav.avaliar(soar(0.3, 400));
    assert.equal(await nav.avaliar(`VOZ.fase`), "gravando");
    for (let i = 0; i < 60 && await nav.avaliar(`VOZ.pedindo`); i++) { await nav.avaliar(soar(0.3, 100)); await esperar(200); } // ele segue falando
    assert.equal(await nav.avaliar(`VOZ.pedindo`), false);
    assert.equal(await nav.avaliar(`VOZ.fala`), null, "com alguém falando, a resposta espera a vez");
    rmSync(join(H, "kokoro-demora"));
    await parar(nav); // o trecho acaba e o filtro barra: "voz não reconhecida"
    await esperarNaTela(nav, `VOZ.fala?.parte === 0 && VOZ.fase === "falando"`);
    assert.equal(ouviu(caixa).at(-1).resultado, "naoReconhecida");
    assert.equal(falou(caixa).filter((l) => l.parte === 0).length, 1, "o pedaço 0 foi gerado UMA vez: o barrado não manda gerar de novo");
    assert.equal(await nav.avaliar(`VOZ.barradas`), 1);

    // (2) Passados os 500 ms, um som forte no meio do pedaço 0 pausa a fala; barrado, ela volta DO MESMO PONTO, sem repedir nada.
    await esperar(700);
    await nav.avaliar(soar(0.6, 400));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), true, "falou por cima: a voz para na hora");
    const pos = await nav.avaliar(`VOZ.fala.pos`);
    assert.ok(pos > 0.5, `parou no meio do pedaço (${pos})`);
    const pedidos = falou(caixa).length;
    await parar(nav);
    await esperarNaTela(nav, `VOZ.barradas === 2 && VOZ.fala && !VOZ.fala.pausada`);
    assert.equal(await nav.avaliar(`VOZ.fala.parte`), 0, "continua no mesmo pedaço");
    assert.ok(Math.abs(await nav.avaliar(`VOZ.fala.pos`) - pos) < 0.01, "e do mesmo ponto");
    assert.equal(falou(caixa).length, pedidos, "nenhum pedaço pedido de novo");

    // (3a) O pedaço 2 vai demorar: a fala vai ter um intervalo entre o 1 e o 2.
    writeFileSync(join(H, "kokoro-demora"), "5000"); // pedido quando o 1 começa: chega 2 s depois de ele acabar
    // O começo do pedaço 1 é eco (o volume pode ser outro): não interrompe, não vira trecho, e o eco é medido de novo.
    await esperarNaTela(nav, `VOZ.fala?.parte === 1`, 10000);
    const extraAntes = await nav.avaliar(`VOZ.vad.extra`);
    const ouvidas = await nav.avaliar(`VOZ.ouvidas`);
    await nav.avaliar(soar(0.6, 300));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), false, "o começo do pedaço 1 não interrompe");
    assert.equal(await nav.avaliar(`VOZ.vad.emFala`), false, "nem começa um trecho");
    const extraDepois = await nav.avaliar(`VOZ.vad.extra`);
    assert.ok(extraDepois > extraAntes && extraDepois >= 0.6 * 2.5 - 1e-9, `o eco do pedaço 1 foi medido de novo (${extraAntes} → ${extraDepois})`);
    // (3b) No intervalo entre o pedaço 1 e o 2, logo depois de o 1 acabar: o rabo do som também não interrompe.
    await nav.avaliar(soar(0, 100));
    await esperarNaTela(nav, `VOZ.fala?.esperando === true`, 8000);
    await nav.avaliar(`VOZ.vad.extra = 0.02`); // como se o eco medido fosse baixo: só o intervalo segura
    await nav.avaliar(soar(0.6, 300));
    assert.equal(await nav.avaliar(`VOZ.fala.pausada`), false, "o intervalo logo depois de um pedaço não interrompe");
    assert.equal(await nav.avaliar(`VOZ.ouvidas`), ouvidas, "nada foi ao whisper nem ao filtro");
    await nav.avaliar(soar(0, 100));
    rmSync(join(H, "kokoro-demora"));
    await esperarNaTela(nav, `!VOZ.fala`, 30000);
    const pedacos = falou(caixa).map((l) => l.parte);
    assert.deepEqual(pedacos, [...Array(falou(caixa)[0].partes).keys()], "cada pedaço gerado uma vez, na ordem");
    assert.equal(await nav.avaliar(`VOZ.falas`), 1, "uma resposta, falada uma vez");
    assert.ok(!existsSync(join(H, "whisper.log")), "nada chegou ao whisper: tudo foi barrado antes");
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
