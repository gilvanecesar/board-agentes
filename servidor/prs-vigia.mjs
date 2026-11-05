// A vigia dos PRs (30/10/2026, a #279, pedido do dono depois de um dia de PRs do ERP conflitando: "muitas coisas com
// conflito o tempo todo"). Mesclar um PR deixa os outros em conflito, e alguém tinha de perceber e devolver a tarefa à mão.
// O runner chama `vigiarPrs` a cada volta; ela lê os PRs a cada ~5 min e devolve a tarefa à fila, na mesma sessão, com o
// pedido fixo de atualizar o MESMO PR. Nunca abre PR, nunca força push, nunca mescla: quem faz é o agente, com as regras
// de entrega de sempre, e portão → revisor → QA conferem de novo. A marca fica em `task.prVigia`.
import { C, PR_CARENCIA_MS, PR_TENTATIVAS, PR_VIGIA_MS, cut, now } from "./config.mjs";
import { broadcast, logEvent, save, state } from "./estado.mjs";
import { classifyError, conferenciaDevida } from "./esteira.mjs";
import { listarPrs } from "./prs.mjs";
import { pedidoAtualizarPr } from "./regras.mjs";

const REGISTRO = "prs-vigia"; // data/logs/prs-vigia.jsonl: tudo o que a vigia decidiu, de todas as tarefas
const RELEITURA_MS = 60000; // tarefa que espera resposta do GitHub é relida neste passo, não a cada volta do runner

/** O PR hoje: conflito, check falhando, sadio ou "ainda não dá para dizer" (GitHub calculando, CI rodando). */
function diagnostico(pr) {
  if (pr.conflito) return "conflito";
  if (pr.checksFalhos?.length) return "checks";
  return pr.mesclavel === "MERGEABLE" && pr.checks?.estado !== "rodando" ? "sadio" : "indeciso";
}

/** Tarefa que anda (ou que o dono ainda precisa resolver): o PR espera ela terminar. */
const andando = (t) => t.status === "rodando" || t.status === "fila" || !!t.busy || !!t.etapa || !!t.classificando || !!t.projetoSugerido
  || !!t.retentativa || !!t.acao || ["pendente", "consertando"].includes(t.worktree?.juntar);
// Logo depois do push o GitHub ainda pode responder o estado velho: decidir agora gastaria uma tentativa à toa.
const carencia = (t) => !!t.finishedAt && Date.now() - Date.parse(t.finishedAt) < PR_CARENCIA_MS;

const oQueHouve = ({ motivo, falhos, mesclado }, numero) => motivo === "checks"
  ? `PR #${numero} com check falhando (${falhos.slice(0, 4).join(", ")})`
  : `PR #${numero} ficou em conflito depois ${mesclado ? `do merge de #${mesclado}` : "de mudanças na main"}`;

function anotar(t, pr, evento, texto, extra = {}) {
  logEvent(t.id, { t: "solto", texto });
  logEvent(REGISTRO, { t: evento, tarefa: t.id, projeto: t.project, pr: pr.url, texto, ...extra });
  t.updatedAt = now();
}

/**
 * Limpa a marca. Rodada ainda na fila não roda mais: o motivo sumiu, e sem o pedido ela refaria a tarefa inteira.
 * Menos com conferência devendo (#288, #290): tirar da fila fecharia a tarefa sem conferir, então ela segue só para a esteira, salvo a
 * concluída cuja rodada nem começou: ela não tem cópia e a conferência cairia na pasta do dono (runTask recria a cópia, conferirTask não).
 * A marca sair não libera o merge: o que veio da volta da vigia e ainda vai andar continua sem mesclar (`semMesclar`).
 */
function encerrar(t, pr, texto) {
  const v = t.prVigia;
  if (v.estado === "atualizando") {
    const rodou = Date.parse(t.startedAt || 0) >= Date.parse(v.em);
    const conferir = conferenciaDevida(t) && (v.statusAntes !== "concluida" || rodou);
    if (t.status === "fila") {
      if (conferir && !t.conferir) { t.conferir = { em: now() }; t.retomar = false; }
      if (t.conferir) t.semMesclar = true;
      else { t.status = v.statusAntes || "executada"; t.retomar = false; }
    } else if (t.status === "rodando" || t.status === "erro") t.semMesclar = true; // a rodada em curso ou a retomada ainda vêm da volta da vigia
  }
  t.prVigia = null;
  anotar(t, pr, "resolvido", texto);
}

function esgotar(t, pr, achado, porque) {
  const v = t.prVigia || {};
  t.prVigia = { url: pr.url, numero: pr.numero, ...achado, n: v.n || 0, max: PR_TENTATIVAS, em: now(), estado: "esgotado", porque: cut(porque, 400) };
  anotar(t, pr, "esgotado", `⚠ ${oQueHouve(achado, pr.numero)} — precisa de você: ${cut(porque, 300)}`, { motivo: achado.motivo });
}

function devolver(t, pr, achado, n) {
  t.prVigia = { url: pr.url, numero: pr.numero, ...achado, n, max: PR_TENTATIVAS, em: now(), estado: "atualizando",
    statusAntes: t.status, pedido: pedidoAtualizarPr(t, pr.url, pr.numero, achado) };
  t.status = "fila"; t.retomar = false; t.retentativa = null; t.tentativas = 0;
  const feito = achado.motivo === "checks" ? "devolvida para consertar no mesmo PR" : "devolvida para atualizar";
  anotar(t, pr, "devolvida", `⇄ ${oQueHouve(achado, pr.numero)}; ${feito} (tentativa ${n} de ${PR_TENTATIVAS})`, { motivo: achado.motivo, n, mesclado: achado.mesclado });
}

/** Decide um PR aberto. Devolve true se mudou alguma coisa. */
function cuidarDoPr(pr, ultimoMesclado) {
  const t = state.tasks.find((x) => x.prUrl === pr.url);
  // Tarefa "direto" com prUrl só citou um PR no resumo: as regras dela proíbem push.
  if (!t || !["pr", "deploy"].includes(t.entrega) || t.merged?.url === pr.url) return false;
  const v = t.prVigia, d = diagnostico(pr);
  if (d === "sadio") {
    if (!v) return false;
    encerrar(t, pr, v.estado === "esperando" ? `✓ PR #${pr.numero} não está mais em conflito` : `✓ PR #${pr.numero} sem conflito e sem check falhando`);
    return true;
  }
  // Check falhando só volta em tarefa já executada; em conflito, qualquer tarefa parada.
  if (d === "indeciso" || (d === "checks" && t.status !== "executada" && v?.estado !== "atualizando")) return false;
  const achado = { motivo: d, ...(d === "checks" ? { falhos: pr.checksFalhos } : { mesclado: ultimoMesclado || null }) };
  if (andando(t)) {
    if (v || d !== "conflito") return false;
    t.prVigia = { url: pr.url, numero: pr.numero, ...achado, n: 0, max: PR_TENTATIVAS, em: now(), estado: "esperando" };
    anotar(t, pr, "esperando", `⏳ ${oQueHouve(achado, pr.numero)}; a tarefa está andando: volta para atualizar quando ela terminar`, { motivo: d });
    return true;
  }
  if (carencia(t) || v?.estado === "esgotado") return false;
  // Rodada parada no meio não recomeça sozinha: quem parou foi o dono, ou o board caiu.
  if (t.status === "pendente" && v?.estado === "atualizando") { esgotar(t, pr, achado, "a atualização foi parada no meio (pelo dono ou por um reinício do board)"); return true; }
  // Barrado por permissão, mesclar ou publicar que falhou: tentar de novo dá no mesmo muro (a mesma regra da retentativa).
  if (t.status === "erro" && classifyError(t.error, t) === "manual") { esgotar(t, pr, achado, `a tarefa está num erro que o board não repete sozinho: ${t.error || "sem detalhe"}`); return true; }
  const n = v?.n || 0;
  if (n >= PR_TENTATIVAS) { esgotar(t, pr, achado, `${n} tentativa(s) e o PR continua assim. Último resumo do agente: ${t.error || t.result || "(sem resumo)"}`); return true; }
  devolver(t, pr, achado, n + 1);
  return true;
}

/** O que vem do último merge da main; `gh pr list` ordena por criação, não por merge. */
const ultimoMerge = (p) => [...p.mesclados].sort((a, b) => String(b.mescladoEm).localeCompare(String(a.mescladoEm)))[0]?.numero;

async function umaRodada() {
  const dados = await listarPrs({ fresco: true }); // a leitura fica no cache de 30 s: a tela aproveita
  let mudou = false;
  for (const p of dados.projetos) {
    if (p.erro) continue; // sem leitura não se conclui nada
    for (const pr of p.abertos) mudou = cuidarDoPr(pr, ultimoMerge(p)) || mudou;
    // PR mesclado ou fechado: não há mais o que atualizar.
    for (const t of state.tasks) {
      if (!t.prVigia || t.project !== p.slug || p.abertos.some((pr) => pr.url === t.prVigia.url)) continue;
      encerrar(t, { url: t.prVigia.url }, `✓ PR #${t.prVigia.numero} não está mais aberto`);
      mudou = true;
    }
  }
  if (mudou) { save(); broadcast("state"); broadcast("prs"); }
}

let ultima = 0, lendo = false;
/** Chamada pelo runner, DEPOIS da pausa da fila: com dois boards no mesmo quadro, só o da fila ligada devolve tarefa. */
export function vigiarPrs(agora = Date.now()) {
  if (!PR_VIGIA_MS || lendo) return;
  if (!ultima) ultima = agora;
  // Tarefa marcada que parou de andar não espera os 5 min.
  const liberada = state.tasks.some((t) => t.prVigia && t.prVigia.estado !== "esgotado" && !andando(t) && !carencia(t));
  if (agora - ultima < (liberada ? Math.min(PR_VIGIA_MS, RELEITURA_MS) : PR_VIGIA_MS)) return;
  ultima = agora; lendo = true;
  umaRodada().catch((e) => console.log(`${C.red}vigia dos PRs: ${e.message}${C.r}`)).finally(() => { lendo = false; });
}
