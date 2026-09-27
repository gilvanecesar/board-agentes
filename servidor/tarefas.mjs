// Criar, editar, reordenar e remover tarefas; o porte automático.
import { execFile } from "child_process";
import { tmpdir } from "os";
import { unlinkSync } from "fs";
import { CLASSIFICAR, ESFORCO_CLAUDE, MOTOR_PADRAO, PORTES, PRODUCAO, STATUSES, cut, modeloServe, now } from "./config.mjs";
import { broadcast, logEvent, logPath, rawPath, save, state, taskById, titleOf } from "./estado.mjs";
import { removerCopia } from "./projetos.mjs";
import { MOTORES } from "./motores.mjs";
import { stopTask } from "./fila.mjs";
import { anexosValidos } from "./anexos.mjs";

// ── tarefas ───────────────────────────────────────────────────────────────────
/** Mensagem com várias linhas "- item" / "1. item" vira várias tarefas; senão, uma só. */
export function splitTasks(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^([-*•]|\d+[.)])\s+/.test(l));
  if (lines.length >= 2 && bullets.length === lines.length) return bullets.map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ""));
  return [String(text).trim()];
}

export function createTasks(text, project, { queue = false, entrega = "direto", anexos = [], motor, modelo, porte, paralelo = false } = {}) {
  const anexados = anexosValidos(anexos);
  const created = [];
  for (const t of splitTasks(text)) {
    if (!t) continue;
    const id = ++state.seq;
    const task = {
      id, text: t, title: titleOf(t), project: project || "DEV", status: queue ? "fila" : "pendente",
      entrega: ["pr", "deploy"].includes(entrega) ? entrega : "direto", prUrl: null,
      etapa: null, gate: null, revisor: null, qa: null, merged: null, deploy: null, anexos: anexados,
      motor: MOTORES[motor] ? motor : MOTOR_PADRAO, modelo: cut(String(modelo || ""), 60) || null,
      porte: PORTES.includes(porte) ? porte : null, tokens: 0,
      order: id, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      sessionId: null, cost: 0, turns: 0, durationMs: 0, result: null, error: null, busy: false,
    };
    if (paralelo) {
      task.paralelo = true;
      // Produção só por PR (regra de ouro): o agente ⚡ entrega pela branch dele.
      if (PRODUCAO.includes(task.project) && task.entrega === "direto") task.entrega = "pr";
    }
    if (CLASSIFICAR && !task.porte && !task.modelo) task.classificando = true;
    state.tasks.push(task); created.push(task);
  }
  save(); broadcast("state");
  for (const t of created) if (t.classificando) classificarPorte(t);
  return created;
}

/**
 * Decide o porte da tarefa nova (leve/normal/pesado) com uma chamada curta e barata: haiku, sem
 * ferramenta, sem MCP, sem hooks, fora de qualquer projeto. Medido em 24/09: 5–7 s, US$ 0,004–0,015.
 * A tarefa não sai da fila enquanto isso (`classificando`); se falhar, vai sem porte (esforço padrão).
 */
export function classificarPorte(task) {
  const prompt = [
    "Classifique o PORTE desta tarefa de programação; ele decide quanto o agente pensa antes de agir.",
    "leve = mudança pequena, localizada e óbvia (texto, cor, um ajuste num lugar só, pergunta simples).",
    "pesado = mexe em várias partes, migração de banco, segurança, dinheiro, produção, bug difícil de achar, desenho de arquitetura.",
    "normal = todo o resto.",
    "Responda SÓ uma palavra: leve, normal ou pesado.",
    "", `Projeto: ${task.project}`, "Tarefa:", String(task.text || "").slice(0, 4000),
  ].join("\n");
  const args = ["-p", prompt, "--model", "haiku", "--output-format", "json", "--no-session-persistence",
    "--strict-mcp-config", "--setting-sources", "", "--tools", ""];
  const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
  execFile("claude", args, { cwd: tmpdir(), env, timeout: 60000, maxBuffer: 1 << 20 }, (_err, stdout) => {
    let porte = null, custo = 0;
    try {
      const d = JSON.parse(stdout);
      custo = d.total_cost_usd || 0;
      porte = (String(d.result || "").toLowerCase().match(/\b(leve|normal|pesado)\b/) || [])[1] || null;
    } catch { /* sem resposta legível: vai sem porte */ }
    task.classificando = false;
    task.cost = Number(((task.cost || 0) + custo).toFixed(4));
    // O automático só BAIXA o esforço (leve) ou mantém o normal: "pesado" (xhigh) é escolha do dono.
    // Decisão de 24/09 — a #165 foi classificada pesada, rodou em xhigh e gastou US$ 1,76 para parar no passo 0.
    if (porte === "pesado") porte = "normal";
    if (!task.porte && !task.modelo && porte) { task.porte = porte; task.porteAuto = true; }
    const esf = task.motor === "claude" ? ESFORCO_CLAUDE[porte] : "";
    logEvent(task.id, { t: "solto", texto: porte
      ? `porte ${porte} (automático${esf ? `, esforço ${esf}` : ""}) — dá pra trocar na ficha`
      : "⚠ não consegui classificar o porte — vai com o esforço padrão" });
    save(); broadcast("state");
  });
}

export function updateTask(task, patch) {
  // O dono mexeu no status à mão: a decisão é dele — cancela a retentativa agendada e zera a conta.
  if (patch.status && STATUSES.includes(patch.status)) { task.retentativa = null; task.tentativas = 0; }
  if (patch.status && STATUSES.includes(patch.status) && patch.status !== task.status) {
    if (task.status === "rodando" && patch.status !== "rodando") stopTask(task, patch.status);
    else if (patch.status === "rodando") throw new Error('use status "fila" — o runner é quem põe pra rodar');
    else { task.status = patch.status; if (patch.status === "concluida") { task.finishedAt = task.finishedAt || now(); removerCopia(task); } }
  }
  if (typeof patch.text === "string" && patch.text.trim()) { task.text = patch.text.trim(); task.title = titleOf(task.text); }
  if (typeof patch.project === "string") task.project = patch.project;
  if (["pr", "direto", "deploy"].includes(patch.entrega)) task.entrega = patch.entrega;
  if (MOTORES[patch.motor] && patch.motor !== task.motor) {
    task.motor = patch.motor;
    if (task.modelo && !modeloServe(patch.motor, task.modelo)) task.modelo = null;
  }
  if (typeof patch.modelo === "string") task.modelo = cut(patch.modelo, 60) || null;
  if (patch.porte === null || PORTES.includes(patch.porte)) { task.porte = patch.porte || null; task.porteAuto = false; task.classificando = false; }
  if (typeof patch.order === "number") task.order = patch.order;
  task.updatedAt = now();
  save(); broadcast("state");
}

export function reorder(ids) {
  const base = ids.map((id, i) => [taskById(id), i]).filter(([t]) => t);
  for (const [t, i] of base) t.order = i + 1;
  save(); broadcast("state");
}

export function removeTask(task) {
  if (task.status === "rodando") stopTask(task);
  removerCopia(task);
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  for (const p of [logPath(task.id), rawPath(task.id)]) { try { unlinkSync(p); } catch { /* sem log */ } }
  save(); broadcast("state");
}
