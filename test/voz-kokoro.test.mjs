// 🎙 Kokoro, a 2ª voz do modo voz (#314). O motor é FALSO (um "python" que fala o protocolo do voz-kokoro.py e anota cada pedido):
// vozes no estado e no seletor, a fala em pedaços, um processo só para muitas falas, só na CPU e sem rede, o Piper como reserva,
// a barreira do Origin, nada de texto no registro, e na tela o ▶ de cada voz tocando os pedaços em sequência.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { esperar } from "./ajuda.mjs";
import { esperarNaTela, limparVoz, preparar, tela, comChrome } from "./voz-ajuda.mjs";
import { comKokoro } from "./voz-kokoro-ajuda.mjs";
import { pedacosDaFala } from "../servidor/voz-kokoro.mjs";

afterEach(limparVoz);

const linhas = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
const kokoro = (caixa) => linhas(join(caixa.home, "kokoro.log")).map((l) => JSON.parse(l));
const pids = (caixa) => linhas(join(caixa.home, "kokoro-pids"));
const fala = (b, corpo, origem = b.url) => fetch(b.url + "/api/voz/fala", { method: "POST", headers: { "content-type": "application/json", ...(origem ? { origin: origem } : {}) }, body: JSON.stringify(corpo) });
const TEXTO = "Olha, terminei a tarefa do quadro. O portão passou, o revisor aprovou e o QA também. Ficou só uma observação menor sobre o texto do botão, que você pode ver na ficha. Se quiser, eu já coloco a próxima na fila agora mesmo e te aviso quando acabar. Beleza? Qualquer coisa me chama aqui.";

test("Kokoro, pedaços: o 1º curto (a voz começa logo), os outros até 150, frase inteira, nada perdido e sempre o mesmo corte", () => {
  const p = pedacosDaFala(TEXTO);
  assert.ok(p.length >= 3, JSON.stringify(p));
  assert.ok(p[0].length <= 90 && p.slice(1).every((x) => x.length <= 150), JSON.stringify(p.map((x) => x.length)));
  assert.equal(p.join(" "), TEXTO, "nada se perde nem muda");
  assert.ok(p.every((x) => /[.!?…]$/.test(x)), "corta no fim de frase");
  assert.deepEqual(pedacosDaFala(TEXTO), p);
  const longa = "Isto é uma frase muito longa, " + "com muitas partes separadas por vírgula, ".repeat(6) + "e um fim.";
  assert.ok(pedacosDaFala(longa).every((x) => x.length <= 150), "frase maior que o teto quebra na vírgula");
  assert.equal(pedacosDaFala(longa).join(" "), longa);
  assert.deepEqual(pedacosDaFala("Curta."), ["Curta."]);
});

test("Kokoro, estado: as vozes pt-BR entram no seletor depois do Piper (a Faber segue padrão); sem Kokoro, nada muda", async () => {
  const { b } = await comKokoro();
  const est = (await b.api("GET", "/api/voz/estado")).json;
  assert.equal(est.kokoro.ok, true);
  assert.deepEqual(est.vozes.map((v) => v.id), ["faber", "jeff", "kokoro-pf_dora", "kokoro-pm_alex", "kokoro-pm_santa"]);
  assert.equal(est.vozes.find((v) => v.id === "kokoro-pf_dora").nome, "Dora (Kokoro, feminina)");
  assert.deepEqual(est.piper.vozes, ["faber", "jeff"], "o Piper continua igual");
  await limparVoz();
  const { b: sem } = await preparar();
  const e2 = (await sem.api("GET", "/api/voz/estado")).json;
  assert.equal(e2.kokoro.ok, false); assert.match(e2.kokoro.motivo, /instalar-kokoro/);
  assert.deepEqual(e2.vozes.map((v) => v.id), ["faber", "jeff"]);
});

test("Kokoro, rota: fala em pedaços num processo só, na CPU e sem rede; ritmo e pausa chegam; Origin; registro sem texto; o Piper nem é chamado", async () => {
  const { b, caixa } = await comKokoro();
  assert.equal((await fala(b, { amostra: true, voz: "kokoro-pf_dora" }, null)).status, 403);
  assert.equal((await fala(b, { amostra: true, voz: "kokoro-pf_dora" }, "http://outro.site")).status, 403);
  const r0 = await fala(b, { amostra: true, voz: "kokoro-pf_dora", ajuste: { ritmo: 0.8, pausa: 0.6 } });
  assert.equal(r0.status, 200);
  assert.equal(r0.headers.get("content-type"), "audio/wav");
  assert.equal(r0.headers.get("x-voz-motor"), "kokoro");
  const partes = Number(r0.headers.get("x-voz-partes"));
  assert.equal(partes, 2);
  assert.match(decodeURIComponent(r0.headers.get("x-voz-texto")), /^Oi, sou eu, a voz da Central\./, "a tela recebe o texto inteiro");
  assert.equal(Buffer.from(await r0.arrayBuffer()).subarray(0, 4).toString("latin1"), "RIFF");
  const r1 = await fala(b, { amostra: true, voz: "kokoro-pf_dora", parte: 1 });
  assert.equal(r1.status, 200); assert.equal(r1.headers.get("x-voz-parte"), "1");
  assert.equal((await fala(b, { amostra: true, voz: "kokoro-pf_dora", parte: 2 })).status, 502, "pedaço que não existe");
  await fala(b, { amostra: true, voz: "kokoro-pm_alex" });
  const k = kokoro(caixa);
  assert.deepEqual(k.map((x) => x.texto), ["Oi, sou eu, a voz da Central. Olha, é desse jeito que eu vou te responder.", "Se quiser, ajusta aí que eu mudo. Beleza?", "Oi, sou eu, a voz da Central. Olha, é desse jeito que eu vou te responder."]);
  assert.deepEqual(k.map((x) => x.voz), ["pf_dora", "pf_dora", "pm_alex"]);
  assert.equal(k[0].velocidade, 1.25, "ritmo 0,8 (o Piper alonga) = velocidade 1,25 no Kokoro");
  assert.equal(k[0].pausa, 0.6);
  assert.ok(k.every((x) => x.cuda === "-1" && x.offline === "1" && x.args[0] === "-I" && x.args[1].endsWith("servidor/voz-kokoro.py")), "só CPU, sem rede, Python isolado");
  assert.equal(pids(caixa).length, 1, "um processo para todas as falas");
  assert.ok(!existsSync(join(caixa.home, "piper.log")), "voz do Kokoro não passa pelo Piper");
  const log = readFileSync(join(caixa.board, "data", "logs", "voz.jsonl"), "utf8");
  assert.match(log, /"motor":"kokoro","parte":0,"partes":2/);
  assert.ok(!/Oi, sou eu/.test(log), "o registro nunca guarda o texto");
  // pedaços de uma resposta de verdade (300 caracteres) também
  const r = await fala(b, { amostra: true, voz: "kokoro-pm_santa", parte: 0 });
  assert.equal(r.status, 200);
});

test("Kokoro, reserva: motor quebrado cai no Piper (Faber) no 1º pedaço e o registro diz por quê; pedaço seguinte que falha é erro", async () => {
  const { b, caixa } = await comKokoro();
  writeFileSync(join(caixa.home, "kokoro-quebrado"), "1");
  const r = await fala(b, { amostra: true, voz: "kokoro-pf_dora" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-voz-motor"), "piper"); assert.equal(r.headers.get("x-voz-partes"), "1");
  const p = linhas(join(caixa.home, "piper.log")).map((l) => JSON.parse(l)).at(-1);
  assert.match(p.modelo, /faber/);
  assert.match(readFileSync(join(caixa.board, "data", "logs", "voz.jsonl"), "utf8"), /"reserva":"o Kokoro saiu \(código 3\): ModuleNotFoundError: torch"/);
  assert.equal((await fala(b, { amostra: true, voz: "kokoro-pf_dora", parte: 1 })).status, 502);
  // um pedido ruim não derruba o motor: o seguinte funciona no mesmo processo
  await limparVoz();
  const { b: b2, caixa: c2 } = await comKokoro();
  writeFileSync(join(c2.home, "santa-erro"), "1");
  assert.equal((await fala(b2, { amostra: true, voz: "kokoro-pm_santa" })).headers.get("x-voz-motor"), "piper");
  assert.equal((await fala(b2, { amostra: true, voz: "kokoro-pf_dora" })).headers.get("x-voz-motor"), "kokoro");
  assert.equal(pids(c2).length, 1);
  assert.equal((await fala(b2, { amostra: true, voz: "kokoro-xx_falsa" })).headers.get("x-voz-motor"), "piper", "voz que não existe não vira caminho");
});

test("Kokoro, aquecer: sobe o motor antes da 1ª resposta, só pela tela e só para voz do Kokoro", async () => {
  const { b, caixa } = await comKokoro();
  const aquecer = (voz, origem = b.url) => fetch(b.url + "/api/voz/aquecer", { method: "POST", headers: { "content-type": "application/json", ...(origem ? { origin: origem } : {}) }, body: JSON.stringify({ voz }) });
  assert.equal((await aquecer("kokoro-pf_dora", null)).status, 403);
  assert.deepEqual(await (await aquecer("faber")).json(), { ok: false });
  assert.equal(pids(caixa).length, 0);
  assert.deepEqual(await (await aquecer("kokoro-pf_dora")).json(), { ok: true });
  for (let i = 0; i < 50 && !pids(caixa).length; i++) await esperar(100);
  assert.equal(pids(caixa).length, 1);
  await fala(b, { amostra: true, voz: "kokoro-pf_dora" });
  assert.equal(pids(caixa).length, 1, "a fala usa o processo já aquecido");
});

test("Tela: as vozes do Kokoro no seletor e um ▶ por voz; a amostra toca os pedaços em sequência e acaba", comChrome, async () => {
  const { b, caixa } = await comKokoro();
  const nav = await tela(caixa, [[0, 30000]]);
  try {
    await nav.carregar(b.url + "/#/central");
    await nav.avaliar(`store.set("vozAberto.ajustes", true); store.set("vozLigado", true); vozAplicar()`);
    await esperarNaTela(nav, `!!VOZ.stream && document.querySelectorAll("#vozAmostras button").length === 5`);
    assert.deepEqual(await nav.avaliar(`[...document.querySelectorAll("#vozVoz option")].map((o) => o.textContent)`),
      ["Faber (Piper)", "Jeff (Piper)", "Dora (Kokoro, feminina)", "Alex (Kokoro, masculina)", "Santa (Kokoro, masculina)"]);
    assert.equal(await nav.avaliar(`$("#vozVoz").value`), "faber", "a Faber segue padrão até ele escolher");
    await nav.avaliar(`$('[data-amostra="kokoro-pm_alex"]').click()`);
    await esperarNaTela(nav, `VOZ.fala?.amostra === true && VOZ.fala.partes === 2`);
    await esperarNaTela(nav, `VOZ.fala?.parte === 1`);
    await esperarNaTela(nav, `!VOZ.fala`);
    assert.deepEqual(kokoro(caixa).map((x) => x.voz), ["pm_alex", "pm_alex"]);
    // escolher a voz guarda por aparelho e aquece o motor; a resposta da Central sai na voz escolhida, em pedaços
    await nav.avaliar(`$("#vozVoz").value = "kokoro-pf_dora"; $("#vozVoz").dispatchEvent(new Event("change"))`);
    assert.equal(await nav.avaliar(`store.get("vozVoz")`), "kokoro-pf_dora");
    await nav.avaliar(`ouvirAmostraVoz()`);
    await esperarNaTela(nav, `VOZ.fala?.parte === 1`);
    await nav.avaliar(`pararFalaBotao()`);
    assert.equal(await nav.avaliar(`VOZ.fala`), null);
    assert.equal(kokoro(caixa).at(-1).voz, "pf_dora");
    assert.equal(pids(caixa).length, 1);
  } finally { await nav.fechar(); }
});
