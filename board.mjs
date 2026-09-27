#!/usr/bin/env node
/**
 * BOARD — o quadro de tarefas do dono, com runner de `claude`.
 *
 * O que faz: você inclui tarefas por um chat (tela principal), cada tarefa entra na fila e
 * o runner roda `claude -p` na pasta do projeto. A tela de detalhe mostra o que está
 * acontecendo com a tarefa (texto do agente, ferramentas, resultado, custo) e tem um chat
 * pra discutir a tarefa — a conversa continua a MESMA sessão do claude (--resume).
 * No terminal onde o board roda aparece, ao vivo, o que está rodando.
 *
 *   node board.mjs            → http://localhost:4488
 *
 * Sem dependência npm — só Node built-in. Estado em data/board.json, log por tarefa em
 * data/logs/<id>.jsonl (eventos compactos) e data/raw/<id>.jsonl (stream-json cru).
 *
 * Variáveis (opcionais):
 *   BOARD_PORT=4488            BOARD_PARALELO=4 (teto geral) · BOARD_POR_PROJETO=1 (agentes por projeto)
 *   BOARD_MODELO=opus          BOARD_TIMEOUT_MIN=90
 *   BOARD_TOOLS="Read,Edit,..." BOARD_PERMISSAO=acceptEdits|bypass
 */
import { unlinkSync, realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { C, MODEL, PARALLEL, PERMISSION, PER_PROJECT, PORT, filaPausada } from "./servidor/config.mjs";
import { LOCK, interrupted, logEvent, save, state } from "./servidor/estado.mjs";
import "./servidor/projetos.mjs";
import "./servidor/infra.mjs";
import "./servidor/memoria.mjs";
import "./servidor/controle.mjs";
import "./servidor/motores.mjs";
import "./servidor/regras.mjs";
import { scheduleRetry } from "./servidor/esteira.mjs";
import "./servidor/conversa.mjs";
import { startRunner } from "./servidor/fila.mjs";
import "./servidor/tarefas.mjs";
import { USO_TTL, buscarUsos, usosCache } from "./servidor/uso.mjs";
import "./servidor/anexos.mjs";
import { server } from "./servidor/http.mjs";

// Rodado direto (`node board.mjs`, o board.sh) sobe servidor e fila. Importado (os testes em test/) só expõe as funções.
const PRINCIPAL = !!process.argv[1] && (() => { try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`a porta ${PORT} já está em uso — o board já está rodando em outro terminal? (ou mude BOARD_PORT)`);
  else console.error("não consegui subir o servidor:", e.message);
  try { unlinkSync(LOCK); } catch { /* sem lock */ }
  process.exit(1);
});
// Só na máquina, por padrão: quem abre a tela manda agentes rodarem comandos. No Docker é 0.0.0.0, e a porta
// é publicada só no 127.0.0.1 do host (docker run -p 127.0.0.1:4488:4488).
if (PRINCIPAL) server.listen(PORT, process.env.BOARD_HOST || "127.0.0.1", () => {
  for (const t of interrupted) logEvent(t.id, { t: "fim", status: "pendente", motivo: "o board caiu enquanto rodava — confira o projeto e rode de novo" });
  // Erro de ANTES da retentativa existir (campo `retentativa` nunca gravado) ganha a sua chance
  // uma vez. Erro já tratado pelo código novo tem o campo (objeto ou null) e não é reagendado.
  for (const t of state.tasks) if (t.status === "erro" && t.retentativa === undefined) scheduleRetry(t, t.error);
  if (filaPausada()) console.log(`${C.amber}⏸ a fila está PAUSADA — nada novo começa até retomar (botão na tela ou: node board-cli.mjs retomar)${C.r}`);
  buscarUsos(); // aquece os painéis: a primeira abertura da tela não espera
  setInterval(() => { if (!usosCache || Date.now() - usosCache.t >= USO_TTL) buscarUsos(); }, USO_TTL);
  save();
  startRunner();
  console.log(`${C.green}BOARD${C.r} ${C.txt}http://localhost:${PORT}${C.r}  ${C.dim}paralelo=${PARALLEL} (${PER_PROJECT} por projeto) · modelo=${MODEL || "padrão"} · permissão=${PERMISSION}${C.r}`);
  console.log(`${C.dim}${state.tasks.length} tarefa(s) no quadro · ${state.tasks.filter((t) => t.status === "fila").length} na fila. O que rodar aparece aqui embaixo.${C.r}`);
});

// Para os testes (test/unidade.test.mjs): as funções que decidem sozinhas — veredito, erro, cota, entrega, anexos, memória.
export { anexosValidos, comAnexos, salvarAnexo } from "./servidor/anexos.mjs";
export { modeloServe, cut } from "./servidor/config.mjs";
export { titleOf } from "./servidor/estado.mjs";
export { lerVeredito, classifyError, parseReset, catchPrUrl, gateCommand, mexeuEmArquivo, marcarInstante } from "./servidor/esteira.mjs";
export { montarRomaneio, inventariar, dataDaMemoria, tipoDaMemoria, resultadoDaConferencia } from "./servidor/memoria.mjs";
export { deliveryRules, houseRules } from "./servidor/regras.mjs";
export { splitTasks } from "./servidor/tarefas.mjs";
export { pctDeLimites, semCotaDoUso } from "./servidor/uso.mjs";
