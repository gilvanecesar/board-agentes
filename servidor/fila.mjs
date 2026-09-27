// O runner da fila (um agente por projeto), parar tarefa e o desligamento limpo.
import { unlinkSync } from "fs";
import { C, PARALELO_POR_PROJETO, PARALLEL, PER_PROJECT, filaPausada, now } from "./config.mjs";
import { LOCK, broadcast, gates, logEvent, running, save, state, taskById } from "./estado.mjs";
import { juntarNaPasta } from "./projetos.mjs";
import { killGroup, prTask, runTask } from "./esteira.mjs";
import { conversaOcupada } from "./conversa.mjs";

export function stopTask(task, newStatus = "pendente") {
  const cp = running.get(task.id), g = gates.get(task.id);
  task.status = newStatus; task.busy = false; task.etapa = null; task.updatedAt = now();
  if (cp) cp.kill("SIGTERM");
  if (g) killGroup(g);
  save(); broadcast("state");
}

// O runner: a cada 1,5s, se tem vaga, pega a próxima da fila (na ordem do quadro).
// Só começa depois que a porta é nossa (ver listen) — senão um segundo board rodaria a fila.
// Reinício pedido pela tela/CLI: o board sai sozinho (código 75, o board.sh sobe de novo) no
// primeiro instante em que nada estiver rodando — nunca no meio de uma tarefa. Antes disso,
// carregar código novo significava alguém derrubar o servidor com tarefa no meio.
export let restartPending = false;
/** O reinício pedido pela tela/CLI: o runner sai sozinho no primeiro instante sem nada rodando. */
export function pedirReinicio() { restartPending = true; }
export function startRunner() {
  setInterval(() => {
    if (restartPending && !state.tasks.some((t) => t.status === "rodando" || t.busy) && !conversaOcupada()) {
      console.log(`${C.amber}↻ reiniciando (nada rodando) — o board.sh sobe de novo${C.r}`);
      try { save(); } catch { /* disco */ }
      try { unlinkSync(LOCK); } catch { /* sem lock */ }
      process.exit(75);
    }
    // Pausada pelo dono: nada novo começa, e nem retentativa volta pra fila, até ele retomar.
    if (filaPausada()) return;
    // Cota esgotada: nada novo começa até o horário em que ela volta.
    const agora = Date.now();
    if (state.pausaAte && agora < state.pausaAte) return;
    if (state.pausaAte && agora >= state.pausaAte) { state.pausaAte = 0; console.log(`${C.green}▶ cota de volta — fila retomada${C.r}`); save(); broadcast("state"); }
    // Retentativas vencidas voltam pra fila, retomando a sessão.
    for (const t of state.tasks) {
      if (t.status === "erro" && t.retentativa && Date.parse(t.retentativa.em) <= agora) {
        t.status = "fila"; t.retomar = true; t.retentativa = null; t.updatedAt = now();
        logEvent(t.id, { t: "retentativa", estado: "na-fila", texto: "voltou pra fila automaticamente" });
        save(); broadcast("state");
      }
    }
    // ⚡ Trabalho aprovado numa cópia volta pra pasta principal — só com ela livre (sem agente
    // nem conversa escrevendo lá), senão seria outro atropelo.
    for (const t of state.tasks) {
      if (t.worktree?.juntar !== "pendente") continue;
      const ocupada = state.tasks.some((o) => o.project === t.project && !o.paralelo && (o.status === "rodando" || o.busy))
        || !!(state.conversas || {})[t.project]?.busy;
      if (!ocupada) juntarNaPasta(t);
    }
    const active = state.tasks.filter((t) => t.status === "rodando");
    if (active.length >= PARALLEL) return;
    const naPasta = {}, emCopia = {};
    for (const t of active) { const m = t.paralelo ? emCopia : naPasta; m[t.project] = (m[t.project] || 0) + 1; }
    const cabe = (t) => (t.paralelo ? (emCopia[t.project] || 0) < PARALELO_POR_PROJETO : (naPasta[t.project] || 0) < PER_PROJECT);
    const next = state.tasks
      .filter((t) => t.status === "fila" && !t.busy && !t.classificando && cabe(t))
      .sort((a, b) => a.order - b.order)[0];
    if (next) {
      const acao = next.acao; next.acao = null;
      if (acao) prTask(next, acao); else runTask(next);
    }
  }, 1500);
}

// Ao parar o board (Ctrl+C, kill), derruba os agentes filhos e deixa as tarefas pendentes —
// agente órfão continua editando o projeto sem ninguém gravar o que ele faz.
export function shutdown(signal) {
  for (const [id, cp] of running) {
    const t = taskById(id);
    if (t) {
      // Pergunta do chat morre calada se ninguém disser nada: o dono fica esperando uma
      // resposta que não vem. Tarefa interrompida volta pra pendente; conversa ganha o aviso.
      if (t.status === "rodando") { t.status = "pendente"; logEvent(id, { t: "fim", status: "pendente", motivo: `board parado (${signal}) — rode de novo` }); }
      else logEvent(id, { t: "solto", texto: `⚠ o board foi parado (${signal}) antes da resposta — mande a pergunta de novo` });
      t.busy = false;
    }
    try { cp.kill("SIGKILL"); } catch { /* já morreu */ }
  }
  for (const [, g] of gates) killGroup(g);
  try { save(); } catch { /* disco */ }
  try { unlinkSync(LOCK); } catch { /* sem lock */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
