// #300: revisor e QA classificam cada defeito. GRAVE reprova; MENOR não reprova, não abre retentativa nem conserto, e vai para o dono decidir.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chamadas, criarCaixa, criarProjeto, envDaCaixa, subirBoard, limparCaixa, esperar, esperarStatus } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

const SEM_VOLTA = { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "0" };
async function preparar(cenario, env = SEM_VOLTA) {
  const caixa = criarCaixa();
  criarProjeto(caixa, "demo");
  caixa.cenario(cenario);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b };
}
const criar = async (b) => (await b.api("POST", "/api/tasks", { text: "faça a.txt", project: "demo", queue: true })).json.tasks[0];
const faz = (arquivo, texto = "fiz") => ({ texto, escreve: { arquivo } });
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const papeis = (caixa) => chamadas(caixa).map((c) => c.papel);
const agentes = (caixa) => chamadas(caixa).filter((c) => c.papel === "agente");
const pedido = (c) => c.args[c.args.indexOf("-p") + 1];
const regras = (c) => c.args[c.args.indexOf("--append-system-prompt") + 1];
const APROVA_MENOR = (m) => `APROVADO\nrodei tudo\nGRAVES: nenhum\nMENORES:\n- ${m}`;
const LIMPO = "APROVADO\nGRAVES: nenhum\nMENORES: nenhum";
const umaVolta = () => esperar(2500);

test("só menores: aprovada de primeira, sem conserto nem retentativa, e as sobras ficam na tarefa", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt")], revisor: [APROVA_MENOR("texto do botão com erro de digitação")], qa: [APROVA_MENOR("cor do selo no tema claro")] },
    { BOARD_REVISOES: "2", BOARD_RETENTATIVAS: "2", BOARD_RETENTATIVA_MIN: "0.02" });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["executada"], 20000);
  await umaVolta();
  assert.deepEqual(papeis(caixa).filter((p) => ["agente", "revisor", "qa"].includes(p)), ["agente", "revisor", "qa"], "uma rodada de cada, nenhuma volta ao agente");
  const f = await tarefa(b, t.id);
  assert.equal(f.status, "executada"); assert.equal(f.retentativa, null); assert.equal(f.tentativas || 0, 0); assert.ok(!f.reprovaPendente); assert.ok(!f.conferenciaPendente);
  assert.equal(fim.revisor.veredito, "APROVADO"); assert.equal(fim.qa.veredito, "APROVADO");
  assert.deepEqual(f.sobras.map((s) => [s.quem, s.texto]), [["revisor", "texto do botão com erro de digitação"], ["qa", "cor do selo no tema claro"]]);
  const evs = await log(b, t.id);
  assert.ok(!evs.some((e) => e.t === "retentativa"), "nenhuma retentativa");
  assert.equal(evs.find((e) => e.t === "qa").menores, 1);
});

test("GRAVE segue reprovando, mesmo com APROVADO na primeira linha: volta ao agente e a tarefa não fecha", async () => {
  const GRAVE = "APROVADO\nGRAVES:\n- **vaza dado de outra empresa** em `/api/x`\nMENORES:\n- cor do botão";
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "consertei")], revisor: [LIMPO], qa: [GRAVE, GRAVE] }, { BOARD_REVISOES: "1", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro"], 20000);
  assert.match(fim.error, /QA reprovou \(REPROVADO\)/);
  assert.equal(fim.qa.veredito, "REPROVADO");
  const volta = pedido(agentes(caixa)[1]);
  assert.match(volta, /vaza dado de outra empresa/);
  assert.doesNotMatch(volta, /cor do botão/, "menor não é pedido de conserto");
  assert.deepEqual((await tarefa(b, t.id)).sobras.map((s) => s.texto), ["cor do botão"], "e o menor continua guardado para o dono");
  assert.equal((await log(b, t.id)).filter((e) => e.t === "qa").at(-1).veredito, "REPROVADO");
});

test("revisor com GRAVE também reprova, e o QA nem chega a rodar", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt")], revisor: ["REPROVADO\nGRAVES:\n- segredo no commit\nMENORES: nenhum"] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro"], 20000);
  assert.match(fim.error, /revisor reprovou \(REPROVADO\)/);
  assert.ok(!papeis(caixa).includes("qa"));
});

test("sem classificação legível continua reprovado: o log diz por quê, e o conserto avisa para não inventar", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "nada a mudar")], revisor: ["APROVADO\nnotei um bug no login, mas nada demais", LIMPO], qa: [LIMPO] }, { BOARD_REVISOES: "1", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.equal((await log(b, t.id)).find((e) => e.t === "revisor").veredito, "SEM CLASSIFICAÇÃO");
  assert.match(pedido(agentes(caixa)[1]), /sem os blocos GRAVES e MENORES/);
});

test("sem classificação e sem rodada de conserto: erro com o motivo, e a conferência fica devendo", async () => {
  const { b } = await preparar({ agente: [faz("a.txt")], qa: ["APROVADO\ntudo certo"] });
  const t = await criar(b);
  const fim = await esperarStatus(b, t.id, ["erro"], 20000);
  assert.match(fim.error, /QA reprovou \(SEM CLASSIFICAÇÃO\)/);
  assert.equal(fim.qa.veredito, "SEM CLASSIFICAÇÃO");
  assert.ok(fim.reprovaPendente, "a conferência fica devendo");
  assert.ok(!(fim.sobras || []).length);
});

test("a nova leitura do papel substitui as sobras dele, e a do outro papel fica", async () => {
  const { b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "consertei")], revisor: [APROVA_MENOR("só do revisor"), APROVA_MENOR("só do revisor")],
    qa: ["REPROVADO\nGRAVES:\n- quebra\nMENORES:\n- menor velho do QA", LIMPO] }, { BOARD_REVISOES: "1", BOARD_RETENTATIVAS: "0" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  assert.deepEqual((await tarefa(b, t.id)).sobras.map((s) => [s.quem, s.texto]), [["revisor", "só do revisor"]]);
});

test("a retomada depois de esgotar as rodadas leva o GRAVE e deixa o menor de fora (#299)", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt"), faz("b.txt", "consertei")], revisor: [LIMPO], qa: ["REPROVADO\nGRAVES:\n- o frete zera\nMENORES:\n- cor do botão", LIMPO] },
    { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const volta = pedido(agentes(caixa)[1]);
  assert.match(volta, /o frete zera/);
  assert.doesNotMatch(volta, /cor do botão/);
});

test("revisor e QA recebem a régua e o formato; o agente não", async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt")], revisor: [LIMPO], qa: [LIMPO] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const cs = chamadas(caixa);
  for (const papel of ["revisor", "qa"]) {
    const r = regras(cs.find((c) => c.papel === papel));
    assert.match(r, /GRAVE \(reprova\): segurança; isolamento entre empresas; perda ou vazamento de dado; documento fiscal ou valor errado; função pedida que não funciona; produção quebrada; teste instável em arquivo da entrega/);
    assert.match(r, /MENOR \(não reprova\): caso raro, texto, aparência, entrada improvável, melhoria/);
    assert.match(r, /Na dúvida entre as duas, é GRAVE/);
    assert.match(r, /GRAVES:[\s\S]*MENORES:/);
  }
  assert.doesNotMatch(regras(cs.find((c) => c.papel === "agente")), /Na dúvida entre as duas/);
});

test("Tela: as sobras só na ficha, recolhidas e sem contador; nada na Central nem no quadro, aberta ou concluída; a CLI também mostra (#311)", { skip: !CHROME && "sem Chrome" }, async () => {
  const { caixa, b } = await preparar({ agente: [faz("a.txt")], revisor: [APROVA_MENOR("<b>texto</b> do botão torto")], qa: [APROVA_MENOR("cor do selo")] });
  const t = await criar(b);
  await esperarStatus(b, t.id, ["executada"], 20000);
  const cli = execFileSync(process.execPath, [join(caixa.board, "board-cli.mjs"), "show", String(t.id)], { encoding: "utf8", env: { ...envDaCaixa(caixa), BOARD_URL: b.url } });
  assert.match(cli, /🧹 sobra \(revisor\): <b>texto<\/b> do botão torto/);
  const nav = await abrirNavegador();
  const texto = async (sel, rx) => { let txt = ""; for (let i = 0; i < 60 && !rx.test(txt); i++) { await esperar(150); txt = await nav.avaliar(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`); } return txt; };
  const ficha = async () => {
    await nav.carregar(b.url + `/#/t/${t.id}`); await nav.quieto();
    await texto("#app", /Observações menores do revisor e do QA/);
    const d = await nav.avaliar(`(() => { const d = document.querySelector("details.sobras"); return d && { aberto: d.open, resumo: d.querySelector("summary").innerText, lista: d.querySelector("ul").textContent, alerta: !!d.closest("[role=status],[role=alert]") || d.getAttribute("role") }; })()`);
    assert.ok(d, "a ficha tem o recolhido");
    assert.equal(d.aberto, false, "nasce fechado");
    assert.doesNotMatch(d.resumo, /\d|🧹/, "sem contador nem selo");
    assert.equal(d.alerta, null, "sem papel de aviso");
    assert.match(d.lista, /revisor <b>texto<\/b> do botão torto[\s\S]*QA cor do selo/);
    assert.equal(await nav.avaliar(`document.querySelector("details.sobras li b")`), null, "texto do parecer vai escapado");
  };
  try {
    await ficha();
    // abrir e o redesenho da ficha não fecha
    await nav.avaliar(`document.querySelector("details.sobras summary").click()`);
    await b.api("PATCH", `/api/tasks/${t.id}`, { title: "outro título" });
    await esperar(800);
    assert.equal(await nav.avaliar(`document.querySelector("details.sobras").open`), true);
    assert.match(await texto("#app", /menores? para o dono/i), /revisor: APROVADO[\s\S]*1 menor para o dono/i);
    await nav.carregar(b.url + "/#/central"); await nav.quieto(); await esperar(1000);
    const central = await nav.avaliar(`document.body.innerText`);
    assert.doesNotMatch(central, /sobra/i, "a Central não mostra sobras");
    assert.doesNotMatch(central, /botão torto|cor do selo/);
    await nav.carregar(b.url + "/#/"); await nav.quieto();
    await nav.avaliar(`(() => { const a = [...document.querySelectorAll("button,a,[role=tab]")].find((e) => /^Executadas/i.test(e.innerText.trim())); a && a.click(); })()`);
    await texto("#app", new RegExp(`#${t.id}`));
    assert.doesNotMatch(await nav.avaliar(`document.querySelector("#app").innerText`), /🧹|sobra/i, "o quadro não tem selo de sobra");
    await nav.carregar(b.url + `/#/t/${t.id}`); await nav.quieto(); await texto("#app", /Observações menores/);
    await nav.avaliar(`document.querySelector("details.sobras summary").click()`); // fecha de novo
    await b.api("PATCH", `/api/tasks/${t.id}`, { status: "concluida" });
    await ficha();
    assert.deepEqual(nav.erros, []);
  } finally { await nav.fechar(); }
});
