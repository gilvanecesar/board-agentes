// Usage and quota tests: the plan of each engine read from its REAL output (Claude's /usage text, agy's "remaining" table,
// Codex's rate_limits in the session file), the "no quota" decision that switches engines BEFORE a task starts, the reviewer's
// model when it has to run elsewhere, and the Consumo screen (cards, SEM COTA, the Trocar button).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { criarCaixa, criarProjeto, subirBoard, limparCaixa, esperar, esperarStatus, chamadas } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

const RELOGIO = join(dirname(fileURLToPath(import.meta.url)), "relogio.mjs");
let atual = [];
afterEach(async () => { for (const f of atual) await f(); atual = []; });

// The real texts (27/09/2026), with the names of the owner's skills/subagents replaced.
const USO_CLAUDE = (sessao = 3, semana = 20) => `You are currently using your subscription to power your Claude Code usage

Current session: ${sessao}% used · resets Sep 27 at 1pm (America/Sao_Paulo)
Current week (all models): ${semana}% used · resets Oct 1 at 10am (America/Sao_Paulo)
Current week (Fable): 0% used · resets Oct 1 at 10am (America/Sao_Paulo)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 1540 requests · 39 sessions
  75% of your usage came from subagent-heavy sessions
  73% of your usage was at >150k context

Last 7d · 11136 requests · 254 sessions
  93% of your usage was at >150k context
  Top skills: /exemplo:skill 1%`;
const USO_GEMINI = `Gemini Models\tWeekly Limit Remaining\t76%\t2026-09-29T12:04:59Z
Gemini Models\tFive Hour Limit Remaining\t100%\t2026-09-27T18:07:57Z
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-04T13:07:57Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-27T18:07:57Z`;
const RL_CODEX = { limit_id: "codex", primary: { used_percent: 50, window_minutes: 10080, resets_at: 1791048121 }, secondary: null, plan_type: "prolite" };

async function preparar({ cenario = {}, env = {}, codex = RL_CODEX } = {}) {
  const caixa = criarCaixa(); criarProjeto(caixa, "demo");
  caixa.cenario({ usoClaude: USO_CLAUDE(), usoGemini: USO_GEMINI, ...cenario });
  if (codex) { const d = join(caixa.home, ".codex", "sessions", "2026", "09", "25"); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "rollout-2026-09-25T08-50-12-x.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: codex } }) + "\n"); }
  const b = await subirBoard(caixa, { BOARD_RELOGIO: String(Date.parse("2026-09-27T12:00:00Z")), TZ: "America/Sao_Paulo", ...env }, { nodeArgs: ["--import", RELOGIO] });
  atual.push(async () => { await b.fim(); limparCaixa(caixa); });
  const uso = (await b.api("GET", "/api/claude-uso?fresco")).json;
  return { caixa, b, uso };
}

test("plano de cada motor, do jeito que cada CLI conta — e a mesma régua para a cota", async () => {
  const { uso } = await preparar();
  const c = uso.motores.claude, g = uso.motores.gemini, x = uso.motores.codex;
  assert.deepEqual(c.limites.map((l) => [l.nome, l.pct]), [["Sessão atual", 3], ["Semana · todos os modelos", 20], ["Semana · Fable", 0]]);
  assert.equal(c.limites[0].renovaEm, "2026-09-27T16:00:00.000Z", "1pm de Brasília");
  assert.equal(c.modo, "assinatura");
  assert.equal(c.contrib[0].janela, "Últimas 24h");
  assert.match(c.contrib[0].itens.join("\n"), /75% do uso veio de sessões com muitos subagentes/);
  assert.equal(c.pct, 3, "a janela mais apertada que não é a semanal");
  assert.deepEqual(g.limites.map((l) => l.pct), [24, 0, 0, 0], "o agy diz quanto RESTA: vira usado");
  assert.equal(x.limites[0].pct, 50); assert.equal(x.modo, "plano prolite"); assert.ok(x.medidoEm, "o Codex diz de quando é o número");
  for (const m of [c, g, x]) assert.equal(m.semCota, false);
  assert.equal(uso.motores.opencode.semPlano, true, "o opencode não informa plano — e aparece dizendo isso");
});

test("Claude SEM cota antes de começar: a tarefa já sai no motor com MAIS folga, sem tentar o Claude", async () => {
  // Gemini: 0% na janela de 5 h; Codex: 50% na semana. A reserva (codex primeiro) só desempata — quem assume é quem tem folga.
  const { caixa, b, uso } = await preparar({ env: { BOARD_MOTORES_RESERVA: "codex,gemini" }, cenario: { usoClaude: USO_CLAUDE(99, 60), gemini: ["feito no gemini"] } });
  assert.equal(uso.motores.claude.semCota, true);
  const [t] = (await b.api("POST", "/api/tasks", { text: "faça", project: "demo", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, "executada");
  assert.equal(fim.motor, "gemini", "o de mais folga, não o primeiro da lista");
  assert.equal(chamadas(caixa).filter((c) => (c.motor || "claude") === "claude" && c.papel === "agente").length, 0, "nem tentou o Claude");
  assert.ok((await b.api("GET", `/api/tasks/${t.id}/log`)).json.events.some((e) => /Claude sem cota — a tarefa vai de Gemini/.test(e.texto || "")));
});

test("Claude sem cota na hora da conferência: revisor e QA rodam em outro motor, com o modelo DELE (não 'sonnet')", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_MODELO_CODEX: "gpt-5-codex" }, cenario: { usoClaude: USO_CLAUDE(99, 60),
    usoGemini: USO_GEMINI.replace(/100%/g, "1%").replace("76%", "1%"), // Gemini também esgotado: sobra o Codex
    codex: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }] } });
  const [t] = (await b.api("POST", "/api/tasks", { text: "crie a.txt", project: "demo", queue: true })).json.tasks;
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  const cx = chamadas(caixa).filter((c) => c.motor === "codex");
  assert.equal(cx.length, 3, "agente, revisor e QA no Codex");
  for (const c of cx) { const i = c.args.indexOf("--model"); assert.equal(c.args[i + 1], "gpt-5-codex", "modelo da família do Codex"); }
  assert.ok(!cx.some((c) => c.args.includes("sonnet")), "o 400 da #127: mandar 'sonnet' para o Codex");
});

test("tela de Consumo: um cartão por motor, SEM COTA em vermelho, e o Trocar passa o que espera", { skip: !CHROME && "sem Chrome" }, async () => {
  const { b } = await preparar({ env: { BOARD_MOTORES_RESERVA: "codex" }, cenario: { usoClaude: USO_CLAUDE(99, 60) } });
  await b.api("POST", "/api/fila/pausar");
  const [t] = (await b.api("POST", "/api/tasks", { text: "esperando no claude", project: "demo", queue: true, motor: "claude" })).json.tasks;
  const nav = await abrirNavegador({ agora: Date.parse("2026-09-27T12:00:00Z") }); atual.push(() => nav.fechar());
  await nav.carregar(b.url + "/?a"); await nav.avaliar(`localStorage.setItem("board.tab", JSON.stringify("consumo"))`);
  await nav.carregar(b.url + "/?b"); await nav.quieto({ min: 800 });
  const cartoes = await nav.avaliar(`[...document.querySelectorAll(".mcard")].map((c) => ({ esgotado: /SEM COTA/.test(c.innerText), texto: c.innerText.replace(/\\s+/g, " ").slice(0, 120) }))`);
  assert.equal(cartoes.length, 4, "claude, gemini, codex e opencode");
  assert.equal(cartoes.filter((c) => c.esgotado).length, 1, "só o Claude está sem cota: " + JSON.stringify(cartoes));
  assert.ok(cartoes.find((c) => c.esgotado).texto.includes("Claude"));
  const bt = await nav.avaliar(`(() => { const b = [...document.querySelectorAll(".mcard button")].find((x) => /Trocar/.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);
  assert.ok(bt, "o cartão do Claude tem o botão Trocar");
  await esperar(300);
  await nav.avaliar(`[...document.querySelectorAll(".mcard button")].find((x) => /Codex/.test(x.textContent) && x.closest(".mdest, .mcard")).click()`);
  for (let i = 0; i < 40 && (await b.api("GET", `/api/tasks/${t.id}`)).json.task.motor !== "codex"; i++) await esperar(150);
  assert.equal((await b.api("GET", `/api/tasks/${t.id}`)).json.task.motor, "codex", "a tarefa que esperava foi para o Codex");
  assert.match(nav.dialogos.join("\n"), /Passar 1 tarefa\(s\) de Claude para Codex/, "com confirmação antes");
  assert.deepEqual(nav.erros, []);
});
