// #306: na #305 (01/11) o QA deixou as rodadas em segundo plano, escreveu "Aguardando a notificação do fim dessas rodadas." e ficou vivo até o teto
// do board cortá-lo. Esse texto virou reprova: duas rodadas do agente sem nada a consertar e uma tentativa gasta. Terminar sem veredito diz que a
// CONFERÊNCIA não acabou, nada sobre o trabalho: nunca aprova, mas roda de novo uma vez sozinha, sem conserto e sem gastar tentativa.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chamadas, criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar(cenario, env = {}) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, { BOARD_REVISOES: "1", BOARD_RETENTATIVAS: "2", BOARD_RETENTATIVA_MIN: "0.01", ...env });
  atual.push([b, caixa]);
  return { caixa, b };
}
const criar = async (b) => (await b.api("POST", "/api/tasks", { text: "faça a.txt", project: "demo", queue: true })).json.tasks[0];
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const papeis = (caixa) => chamadas(caixa).map((c) => c.papel);
const arg = (c, f) => c.args[c.args.indexOf(f) + 1];
const pedidos = (caixa, papel) => chamadas(caixa).filter((c) => c.papel === papel).map((c) => arg(c, "-p"));
const FIZ = { texto: "fiz", escreve: { arquivo: "a.txt" } };
const ESPERANDO = "Aguardando a notificação do fim dessas rodadas.";
const OK = "APROVADO\nnão quebrou\nGRAVES: nenhum\nMENORES: nenhum";

test("o caso da #305: QA preso depois do turno, cortado pelo teto, roda de novo e fecha, sem voltar ao agente nem gastar tentativa", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ texto: ESPERANDO, preso: true }, OK] }, { BOARD_QA_TIMEOUT_MIN: "0.05" });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "qa"], "sem agente entre as duas rodadas do QA, e o revisor não repete");
  assert.equal(fim.qa.veredito, "APROVADO");
  assert.ok(!fim.tentativas && !fim.reprovaPendente && !fim.conferenciaPendente);
  const ev = await log(b, t.id);
  assert.equal(ev.find((e) => e.t === "qa").veredito, "SEM VEREDITO");
  assert.ok(ev.some((e) => e.t === "solto" && /QA terminou sem veredito \(tempo esgotado.*sem gastar tentativa/.test(e.texto)));
  assert.ok(!ev.some((e) => e.t === "fim" && e.status === "erro"), "nem passou por erro");
  const [, segunda] = pedidos(caixa, "qa");
  assert.match(segunda, /^Teste a entrega/);
  assert.match(segunda, /terminou sem veredito \(tempo esgotado/);
  assert.ok(segunda.includes(ESPERANDO), "a rodada nova sabe o que deu errado");
  assert.ok(!pedidos(caixa, "qa")[0].includes("sem veredito"), "a 1ª rodada não leva o aviso");
});

test("reprova da QA da #306: QA cortado pelo teto sem nenhum turno fechado repete sozinho, sem agente e sem tentativa", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ dorme: 600000 }, OK] }, { BOARD_QA_TIMEOUT_MIN: "0.05" });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "qa"]);
  assert.ok(!fim.tentativas);
  const ev = await log(b, t.id);
  assert.ok(!ev.some((e) => e.t === "fim" && e.status === "erro"));
  assert.match(pedidos(caixa, "qa")[1], /terminou sem veredito \(tempo esgotado/);
  assert.doesNotMatch(pedidos(caixa, "qa")[1], /Ela só disse/, "não havia texto para repetir");
});

test("revisor saindo com 143 sem texto repete sozinho; cortado duas vezes chama o dono, sem gastar tentativa", async () => {
  const CORTE = { texto: "", codigo: 143 };
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: [CORTE, CORTE], qa: [OK] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro", "executada"], 20000);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /revisor terminou duas vezes sem veredito/);
  assert.ok(!fim.tentativas && !fim.retentativa);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "revisor"]);
});

for (const [nome, passo, motivo] of [["que nem abriu sessão", { semSessao: true }, /QA não rodou/], ["que disse que falhou", { texto: "API fora do ar", erro: true }, /QA não rodou: API fora/]]) {
  test(`motor ${nome} não é "sem veredito": segue a retentativa, gastando tentativa, com o agente na retomada`, async () => {
    const { caixa, b } = await preparar({ agente: [FIZ, "nada a mudar"], revisor: ["APROVADO"], qa: [passo, OK] });
    const t = await criar(b);
    await esperarStatus(b, t.id, ["executada"], 20000);
    assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "revisor", "qa"]);
    const ev = await log(b, t.id);
    assert.ok(ev.some((e) => e.t === "fim" && e.status === "erro" && motivo.test(e.motivo)));
    assert.ok(ev.some((e) => e.t === "retentativa" && e.estado === "agendada"));
  });
}

test("revisor sem veredito: ele repete, o QA segue depois, e a resposta vazia conta igual", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["", "APROVADO"], qa: [OK] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "revisor", "qa"]);
});

test("duas vezes sem veredito: fail-closed, chama o dono, sem conserto, sem retentativa, sem tentativa; ▶ confere de novo sem falso parecer", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ, "nada a mudar"], revisor: ["APROVADO"], qa: [ESPERANDO, "ainda rodando", OK] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro", "executada"], 20000);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /QA terminou duas vezes sem veredito/);
  assert.equal(fim.qa.veredito, "SEM VEREDITO", "fica não aprovado, para a trava do Mesclar ver");
  assert.ok(!fim.tentativas && !fim.retentativa && !fim.reprovaPendente);
  assert.ok(fim.conferenciaPendente, "a conferência continua devida");
  await esperar(1500); // com a retentativa de 0,6 s, isto já teria voltado para a fila
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).json.task.status, "erro");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "qa"]);
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "retentativa" && e.estado === "manual" && /nenhuma tentativa foi gasta/.test(e.texto)));

  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "fila" });
  const volta = await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal(volta.qa.veredito, "APROVADO");
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "qa", "agente", "revisor", "qa"]);
  // "Aguardando" não é parecer: o agente da #305 recebeu isso duas vezes e respondeu que não havia defeito.
  const volta2 = pedidos(caixa, "agente")[1];
  assert.ok(!volta2.includes(ESPERANDO) && !volta2.includes("ainda rodando"));
  assert.doesNotMatch(volta2, /conferência do board reprovou/);
});

test("a repetição dá REPROVADO: é reprova normal, com o parecer de verdade, e o texto sem veredito não vai junto", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ, { texto: "consertei", escreve: { arquivo: "a.txt", conteudo: "y" } }], revisor: ["APROVADO"], qa: [ESPERANDO, "REPROVADO\nGRAVES:\n- rodar X quebra\nMENORES: nenhum", OK] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "qa", "agente", "revisor", "qa"]);
  const conserto = pedidos(caixa, "agente")[1];
  assert.match(conserto, /rodar X quebra/);
  assert.ok(!conserto.includes(ESPERANDO));
});

test("revisor e QA rodam sem segundo plano, por regra e pela variável do CLI; o agente continua com ele", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [OK] });
  await esperarStatus(b, (await criar(b)).id, ["executada"], 20000);
  const [ag, rev, qa] = chamadas(caixa);
  assert.equal(ag.semFundo, undefined);
  for (const c of [rev, qa]) {
    assert.equal(c.semFundo, "1", c.papel);
    assert.match(arg(c, "--append-system-prompt"), /NADA em segundo plano/, c.papel);
  }
  assert.doesNotMatch(arg(ag, "--append-system-prompt"), /NADA em segundo plano/);
});

test("turno da notificação só com a palavra: vale o parecer inteiro, com as sobras, sem rodar de novo", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"],
    qa: [{ texto: "APROVADO\nrodei 5×\nGRAVES: nenhum\nMENORES:\n- cor do botão", depois: "APROVADO" }] });
  const fim = await esperarStatus(b, (await criar(b)).id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa"]);
  assert.deepEqual(fim.sobras.map((s) => s.texto), ["cor do botão"]);
});

test("reprova seguida do turno da notificação: o agente recebe o defeito, não \"o veredito não muda\"", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ, { texto: "consertei", escreve: { arquivo: "a.txt", conteudo: "y" } }], revisor: ["APROVADO"],
    qa: [{ texto: "REPROVADO\nGRAVES:\n- rodar X quebra\nMENORES: nenhum", depois: "REPROVADO\n\nO aviso é só do script. O veredito não muda." }, OK] });
  await esperarStatus(b, (await criar(b)).id, ["executada"], 20000);
  assert.match(pedidos(caixa, "agente")[1], /rodar X quebra/);
});

test("reprova da QA da #306: GRAVE no último turno ganha do parecer aprovado antes dele", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ, { texto: "consertei", escreve: { arquivo: "a.txt", conteudo: "y" } }], revisor: ["APROVADO"],
    qa: [{ texto: OK, depois: "APROVADO\n\nGRAVES:\n- a 5a rodada apagou dados" }, OK] });
  const fim = await esperarStatus(b, (await criar(b)).id, ["executada", "erro"], 20000);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa", "agente", "revisor", "qa"], "reprova normal: volta ao agente");
  assert.match(pedidos(caixa, "agente")[1], /a 5a rodada apagou dados/);
});

for (const fala of ["Na verdade a 5ª rodada falhou.", "A notificação é só a espera das 5 rodadas terminando."])
  test(`reprova da QA da #306: APROVADO com texto depois do parecer nunca aprova por si; repete ("${fala}")`, async () => {
    const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ texto: OK, depois: `APROVADO\n\n${fala}` }, "REPROVADO\nGRAVES:\n- a 5ª rodada falha\nMENORES: nenhum"] }, { BOARD_REVISOES: "0" });
    const t = await criar(b);
    const fim = await esperarStatus(b, t.id, ["erro", "executada"], 20000);
    assert.equal(fim.status, "erro");
    assert.match(fim.error, /QA reprovou \(REPROVADO\)/);
    assert.deepEqual(papeis(caixa).slice(0, 4), ["agente", "revisor", "qa", "qa"]);
    assert.equal((await log(b, t.id)).find((e) => e.t === "qa").veredito, "SEM VEREDITO");
  });

test("parecer aprovado e um último turno sem veredito não vale como aprovação: roda de novo", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ texto: OK, depois: "A 5ª rodada falhou, vou rodar de novo." }, "REPROVADO\nGRAVES:\n- a 5ª rodada falha\nMENORES: nenhum"] }, { BOARD_REVISOES: "0" });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro", "executada"], 20000);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /QA reprovou \(REPROVADO\)/);
  assert.deepEqual(papeis(caixa).slice(0, 4), ["agente", "revisor", "qa", "qa"]);
});

test("cota no meio, com texto solto: não repete a conferência, segue o caminho da cota", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ texto: ESPERANDO, depois: "You've hit your limit · resets 11:40pm" }] });
  const t = await criar(b);
  let ev = [];
  for (let i = 0; i < 100 && !ev.some((e) => e.t === "fim"); i++) { await esperar(100); ev = await log(b, t.id); }
  assert.ok(ev.some((e) => e.t === "fim" && e.status === "erro" && /QA não rodou.*hit your limit/.test(e.motivo)), "vira falha de cota, que passa o bastão ou pausa a fila");
  assert.ok(!ev.some((e) => e.t === "solto" && /terminou sem veredito/.test(e.texto)), "repetir daria no mesmo muro");
  assert.deepEqual(papeis(caixa).slice(0, 3), ["agente", "revisor", "qa"]);
  assert.notEqual(papeis(caixa)[3], "qa");
});

test("parado pelo dono no meio da espera: não roda de novo", async () => {
  const { caixa, b } = await preparar({ agente: [FIZ], revisor: ["APROVADO"], qa: [{ texto: ESPERANDO, preso: true }, OK] });
  const t = await criar(b);
  for (let i = 0; i < 100 && !papeis(caixa).includes("qa"); i++) await esperar(100);
  await esperar(300);
  await b.api("POST", `/api/tasks/${t.id}/stop`);
  await esperarStatus(b, t.id, ["pendente"], 10000);
  await esperar(1000);
  assert.deepEqual(papeis(caixa), ["agente", "revisor", "qa"]);
});
