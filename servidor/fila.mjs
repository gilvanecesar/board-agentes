// O runner da fila (um agente por projeto), parar tarefa e o desligamento limpo.
import { unlinkSync } from "fs";
import { C, PARALELO_POR_PROJETO, PARALLEL, PER_PROJECT, filaPausada, now } from "./config.mjs";
import { LOCK, broadcast, gates, logEvent, running, save, state, taskById } from "./estado.mjs";
import { TRANSCRICOES, limparSobrasDeAudio } from "./ditado.mjs";
import { JUNTANDO, conferirNaoJuntadas, juntarNaPasta } from "./juntar.mjs";
import { PUBLICANDO } from "./publicar.mjs";
import { conferirTask, killGroup, prTask, runTask } from "./esteira.mjs";
import { conversaOcupada } from "./conversa.mjs";
import { vigiarPrs } from "./prs-vigia.mjs";

export function stopTask(task, newStatus = "pendente") {
  const cp = running.get(task.id), g = gates.get(task.id);
  task.status = newStatus; task.busy = false; task.etapa = null; task.conferir = null; task.updatedAt = now();
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
  try { limparSobrasDeAudio(); } catch { /* sem tmp legível: não segura a fila */ }
  setInterval(() => {
    if (restartPending && !state.tasks.some((t) => t.status === "rodando" || t.busy) && !conversaOcupada() && !JUNTANDO.size && !PUBLICANDO.size && !TRANSCRICOES.size) {
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
    // nem conversa escrevendo lá), senão seria outro atropelo. Uma junção por projeto de cada vez:
    // a de três vias roda o portão (minutos) e confere a pasta de novo antes de escrever.
    const ocupada = (proj) => state.tasks.some((o) => o.project === proj && !o.paralelo && (o.status === "rodando" || o.busy))
      || !!(state.conversas || {})[proj]?.busy;
    for (const t of state.tasks) {
      if (t.worktree?.juntar !== "pendente" || JUNTANDO.has(t.id)) continue;
      if (state.tasks.some((o) => JUNTANDO.has(o.id) && o.project === t.project)) continue;
      if (!ocupada(t.project)) juntarNaPasta(t, { livre: () => !ocupada(t.project) }).catch((e) => console.log(`${C.red}junção #${t.id}: ${e.message}${C.r}`));
    }
    // "Não juntada" cujo trabalho já apareceu na pasta (o dono aplicou à mão) deixa de ser conflito sozinha.
    conferirNaoJuntadas(state.tasks);
    // PR de tarefa que ficou em conflito (ou com check falhando) volta sozinho para a tarefa atualizar o MESMO PR.
    vigiarPrs(agora);
    const active = state.tasks.filter((t) => t.status === "rodando");
    if (active.length >= PARALLEL) return;
    const naPasta = {}, emCopia = {};
    for (const t of active) { const m = t.paralelo ? emCopia : naPasta; m[t.project] = (m[t.project] || 0) + 1; }
    const cabe = (t) => (t.paralelo ? (emCopia[t.project] || 0) < PARALELO_POR_PROJETO : (naPasta[t.project] || 0) < PER_PROJECT);
    const next = state.tasks
      .filter((t) => t.status === "fila" && !t.busy && !t.classificando && !t.projetoSugerido && cabe(t)) // projeto em dúvida espera o dono
      .sort((a, b) => a.order - b.order)[0];
    if (next) {
      const acao = next.acao; next.acao = null;
      if (acao) prTask(next, acao); else if (next.conferir) conferirTask(next); else runTask(next);
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
