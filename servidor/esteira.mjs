// A esteira: agente → portão → revisor → QA, a retentativa pelo motivo, a entrega por PR e o mesclar/publicar.
import { spawn, execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { C, DATA, DEPLOY_FILE, DEPLOY_TIMEOUT_MS, GATE_FILE, GATE_TIMEOUT_MS, MOTOR_PADRAO, PRODUCAO, QA_LIGADO, QA_MODEL, QA_TIMEOUT_MS, RETRY_DELAY_MS, RETRY_MAX, REVIEW_MODEL, REVIEW_ROUNDS, REVISOR_LIGADO, cut, now, stripAnsi } from "./config.mjs";
import { broadcast, gates, logEvent, save, state } from "./estado.mjs";
import { criarCopia, estadoDaArvore, haMudancas, nadaParaEntregar, nomeDeAgente, projectOf } from "./projetos.mjs";
import { ROMANEIO_LIGADO, montarRomaneio, sentidoDoPedido } from "./memoria.mjs";
import { MOTORES, runAgent, runMotor } from "./motores.mjs";
import { lerParecer, parecerDaRodada, pareceresAbertos, pedidoDeConserto, qaRules, reviewerRules, textoDosPareceres } from "./regras.mjs";
import { passarBastao, proximoMotorComCota, textoDaPassagem } from "./uso.mjs";
import { anexosValidos, comAnexos } from "./anexos.mjs";

/**
 * O PORTÃO — a verificação que o próprio projeto já tem (tsc, testes). Não usa IA: é o
 * comando da casa rodando de verdade. Existe porque o board acreditava no resumo do agente:
 * "check limpo, 39 testes verdes" era palavra dele, nunca conferida por ninguém.
 *
 * O comando sai de `data/portao.json` ({slug: comando}; "" desliga) ou, na falta, dos scripts
 * do package.json do projeto.
 */
export function gateCommand(project) {
  try {
    const cfg = JSON.parse(readFileSync(GATE_FILE, "utf8"));
    if (Object.prototype.hasOwnProperty.call(cfg, project.slug)) return String(cfg[project.slug] || "");
  } catch { /* sem arquivo de portão */ }
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(project.dir, "package.json"), "utf8")).scripts || {}; } catch { return ""; }
  const partes = [];
  const tipo = ["check", "typecheck", "lint"].find((k) => scripts[k]);
  if (tipo) partes.push(`npm run ${tipo}`);
  if (scripts.test) partes.push("npm test");
  return partes.join(" && ");
}

/** Mata o grupo de processos de um comando (bash + npm + vitest…), não só o bash. */
export function killGroup(cp) {
  try { process.kill(-cp.pid, "SIGKILL"); } catch { try { cp.kill("SIGKILL"); } catch { /* já morreu */ } }
}

/** Roda o comando do portão e devolve o veredito com o rabo da saída (o que explica a falha). */
export function runGate(task, project, comando, limite = GATE_TIMEOUT_MS) {
  return new Promise((done) => {
    const env = { ...process.env, CI: "true", PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let cp;
    // `detached`: o comando vira líder de grupo, e o timeout mata o GRUPO. Matar só o bash
    // deixava npm/vitest vivos segurando o pipe — e o "close" nunca chegava (portão pendurado).
    try { cp = spawn("bash", ["-c", comando], { cwd: project.dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true }); }
    catch (e) { return done({ ok: false, code: -1, saida: "não consegui rodar o portão: " + e.message }); }
    gates.set(task.id, cp);
    let buf = "", estourou = false;
    const timer = setTimeout(() => { estourou = true; killGroup(cp); }, limite);
    // O parecer guarda só o rabo da saída (60 linhas). Com centenas de testes, o `not ok` do que falhou fica lá em cima e
    // a reprova chegava sem dizer QUAL teste quebrou (#351: duas reprovas assim). Cada `not ok` e as linhas seguintes
    // (onde o node:test põe local e erro) são guardados à parte, conforme a saída passa, e vão no começo do parecer.
    const falhas = [];
    let resto = "", pegar = 0;
    const olhar = (txt) => {
      const linhas = (resto + txt).split(/\r?\n/);
      resto = linhas.pop();
      for (const l of linhas) {
        if (/^\s*not ok\b/.test(l) && falhas.length < 200) { pegar = 13; falhas.push(""); }
        if (pegar > 0) { pegar--; if (l.trim()) falhas.push(l.slice(0, 400)); }
      }
    };
    const ler = (d) => { const t = stripAnsi(String(d)); olhar(t); buf += t; if (buf.length > 400000) buf = buf.slice(-200000); };
    cp.stdout.on("data", ler); cp.stderr.on("data", ler);
    cp.on("error", (e) => { buf += "\n" + e.message; });
    cp.on("close", (code) => {
      clearTimeout(timer); gates.delete(task.id);
      olhar("\n");
      let saida = buf.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join("\n");
      const quebrados = falhas.join("\n").trim();
      if (quebrados) saida = `Testes que falharam (not ok):\n${quebrados}\n\n… o fim da saída:\n${saida}`;
      done({ ok: !estourou && code === 0, code, estourou, saida: estourou ? saida + `\n(passou de ${limite / 60000} min e foi interrompido)` : saida });
    });
  });
}

/** O comando de publicação do projeto. Sem entrada aqui, o modo "mesclar e publicar" não existe. */
export function deployCommand(project) {
  try {
    const cfg = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
    const c = cfg[project.slug];
    return typeof c === "string" && c.trim() ? c : "";
  } catch { return ""; }
}

/** A assinatura do git — serve para saber se a rodada mexeu em arquivo de verdade. */
/**
 * "A rodada mexeu em arquivo?" — é isso que liga portão, revisor e QA.
 * ⚠️ Antes olhava só `git status --porcelain`, e ele NÃO muda quando o agente altera um arquivo
 * que já estava sujo ou não rastreado. Um agente que grava por comando de shell (o Codex faz isso
 * o tempo todo, e o Claude também com heredoc) passava batido por toda a conferência — visto no
 * teste do motor em 22/09. Agora a pergunta é feita ao disco: existe arquivo mais novo que a marca?
 * Marca fica em data/ (nunca dentro do projeto). Funciona em pasta sem git também.
 */
export function marcarInstante() {
  const marca = join(DATA, ".marca-tempo");
  writeFileSync(marca, now());
  return marca;
}

export function mexeuEmArquivo(dir, marca) {
  try {
    const achou = execFileSync("find", [dir, "-type", "f", "-newer", marca,
      "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/dist/*",
      "-not", "-path", "*/.next/*", "-not", "-name", "*.log", "-print", "-quit"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    return !!achou.trim();
  } catch { return false; }
}

/** A URL do PR sai no texto do agente; guardá-la é o que transforma "executada" em link clicável. */
export function catchPrUrl(task, texto) {
  const m = String(texto || "").match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  if (!m) return;
  // ⚠️ O PR da tarefa é o PRIMEIRO. Se uma rodada de conserto abrir outro, trocar aqui esconderia
  // o anterior, que fica aberto e esquecido — foi o que a #127 fez (três PRs, 22/09/2026).
  if (task.prUrl && task.prUrl !== m[0]) {
    task.prExtras = task.prExtras || [];
    if (!task.prExtras.includes(m[0])) {
      task.prExtras.push(m[0]);
      logEvent(task.id, { t: "solto", texto: `⚠️ O agente abriu OUTRO Pull Request (${m[0]}). A entrega desta tarefa continua sendo ${task.prUrl} — confira e feche o extra.` });
    }
    return;
  }
  task.prUrl = m[0];
}

export function applyRunInfo(task, r) {
  catchPrUrl(task, r.result);
  // ⚠️ A sessão da tarefa é SÓ a do agente (runClaude grava). Aqui isto sobrescrevia com a sessão
  // do REVISOR: a rodada de conserto e a entrega da #7 foram parar na sessão do revisor, que
  // (certo) recusou commitar. O sessionId não passa mais por aqui.
  task.cost = Number(((task.cost || 0) + (r.cost || 0)).toFixed(4));
  task.tokens = (task.tokens || 0) + (r.tokens || 0);
  task.turns = (task.turns || 0) + (r.turns || 0);
  task.durationMs = (task.durationMs || 0) + (r.dur || 0);
}

/** O veredito de revisor e QA: APROVADO, REPROVADO ou null, que nunca aprova. Quem decide é `lerParecer`: fail-closed, inclusive sem a classificação GRAVE × MENOR. */
export const lerVeredito = (texto) => lerParecer(texto).veredito;

const TETO_SOBRAS = 30;
/**
 * Registra o que o revisor ou o QA disse e guarda os defeitos menores em `task.sobras`, para o dono decidir (#300). A última leitura de cada
 * papel substitui a anterior: ele releu a entrega inteira, e o que saiu da lista pode ter sido consertado. Parecer ilegível não mexe nas sobras.
 */
function registrarParecer(task, quem, r) {
  const parecer = parecerDaRodada(r.resultados?.length ? r.resultados : [r.result]);
  const p = lerParecer(parecer);
  // APROVADO com texto solto no fim de vários turnos: o board não sabe se ele mudou de ideia. Não é parecer sem classificar, é conferência sem resposta legível (#306).
  const rotulo = p.semClassificacao ? (r.resultados?.length > 1 ? null : "SEM CLASSIFICAÇÃO") : p.veredito;
  if (p.veredito) {
    const novas = p.menores.slice(0, TETO_SOBRAS).map((texto) => ({ quem, texto: cut(texto, 600), em: now() }));
    if (p.menores.length > TETO_SOBRAS) novas.push({ quem, texto: `… e mais ${p.menores.length - TETO_SOBRAS}: o parecer inteiro está na linha do tempo`, em: now() });
    task.sobras = [...(task.sobras || []).filter((s) => s.quem !== quem), ...novas];
  }
  const texto = parecer || r.error || "";
  logEvent(task.id, { t: quem, veredito: rotulo || "SEM VEREDITO", texto, custo: r.cost, ...(p.veredito && p.menores.length ? { menores: p.menores.length } : {}) });
  return { aprovado: p.veredito === "APROVADO", veredito: rotulo, texto, ...(rotulo ? {} : { semVeredito: true, erro: r.error }) };
}

/**
 * O fim comum aos dois papéis. "Não rodou" é infraestrutura, e segue a retentativa: motor que nem abriu sessão, que disse que falhou, ou cota (repetir daria no mesmo muro).
 * Papel que abriu sessão e foi cortado sem resposta (teto do board, 143) RODOU e não deu veredito: com o segundo plano proibido, é por aqui que o QA longo termina (#306).
 */
function fimDoPapel(task, quem, nome, r) {
  const naoRodou = () => { if (r.cota) task.erroCota = true; return { falhou: true, motivo: `${nome} não rodou: ${cut(r.error, 160)}` }; };
  if (r.error && !String(r.result || "").trim() && (r.cota || r.motorErrou || !r.sessionId)) return naoRodou();
  const v = registrarParecer(task, quem, r);
  return v.semVeredito && r.cota ? naoRodou() : v;
}

/** Devolve o veredito do revisor. `aviso` é a volta depois de uma rodada sem veredito (#306). */
export async function runReviewer(task, project, aviso = "") {
  const r = await runMotor(task,
    [`Revise a tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000), ...(aviso ? ["", aviso] : [])].join("\n"),
    { quem: "revisor", regras: reviewerRules(task, project), modelo: REVIEW_MODEL, tools: "Read,Grep,Glob,Bash" });
  applyRunInfo(task, r);
  return fimDoPapel(task, "revisor", "o revisor", r);
}

/** Devolve o veredito do QA, igual ao revisor. */
export async function runQA(task, project, aviso = "") {
  const r = await runMotor(task,
    [`Teste a entrega da tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000), ...(aviso ? ["", aviso] : [])].join("\n"),
    { quem: "qa", regras: qaRules(task, project), modelo: QA_MODEL, tools: "Read,Grep,Glob,Bash", limite: QA_TIMEOUT_MS });
  applyRunInfo(task, r);
  return fimDoPapel(task, "qa", "o QA", r);
}

/**
 * Um papel da conferência, com a volta de quem terminou sem veredito legível (#306: na #305 o QA ficou esperando rodadas em segundo plano até o
 * teto do board, e "Aguardando a notificação" virou reprova: duas rodadas do agente sem nada a consertar, e uma tentativa). Isso diz que a CONFERÊNCIA
 * não terminou, nada sobre o trabalho: não abre conserto nem gasta tentativa, e o papel roda de novo UMA vez, sozinho.
 * Sem veredito de novo continua fail-closed: erro, sem repetir, e `task[quem]` fica não aprovado para a trava do Mesclar (#188) ver.
 */
async function parecerDe(task, project, quem, rodada) {
  const rodar = quem === "revisor" ? runReviewer : runQA, nome = quem === "revisor" ? "o revisor" : "o QA";
  const v = await rodar(task, project);
  if (!v.semVeredito || task.status !== "rodando") return v;
  logEvent(task.id, { t: "solto", texto: `↻ ${nome} terminou sem veredito${v.erro ? ` (${cut(v.erro, 100)})` : ""}: a conferência não terminou, roda de novo uma vez, sem voltar ao agente e sem gastar tentativa` });
  const aviso = [`⚠️ A rodada anterior desta conferência terminou sem veredito${v.erro ? ` (${cut(v.erro, 100)})` : ""}.${v.texto && v.texto !== v.erro ? ` Ela só disse: "${cut(v.texto, 200)}".` : ""}`,
    "Faça menos, em primeiro plano, e termine com o parecer no formato pedido, com o que conseguiu conferir. Sem veredito de novo, a tarefa para e o dono é chamado."].join("\n");
  const outra = await rodar(task, project, aviso);
  if (!outra.semVeredito || task.status !== "rodando") return outra;
  task[quem] = { veredito: "SEM VEREDITO", rodadas: rodada, em: now() };
  return { falhou: true, motivo: `${nome} terminou duas vezes sem veredito: a entrega não foi reprovada, mas também não foi conferida. Veja a linha do tempo e use ▶ Rodar de novo` };
}

/** Marca em que etapa a tarefa está (agente → portão → revisor → QA) e avisa a tela. */
export function etapa(task, nome) { task.etapa = nome; task.updatedAt = now(); save(); broadcast("state"); }

export function finaliza(task, status, motivo) {
  task.status = status; task.busy = false; task.etapa = null; task.finishedAt = now(); task.updatedAt = now();
  if (status === "erro") task.error = motivo || task.error;
  if (status === "executada") { task.tentativas = 0; task.retentativa = null; task.entregaPendente = false; task.semMesclar = false; }
  // ⚡ aprovado: o runner junta na pasta principal assim que ela estiver livre.
  if (status === "executada" && task.worktree && !task.worktree.producao && !task.worktree.removida) task.worktree.juntar = "pendente";
  logEvent(task.id, { t: "fim", status, motivo: motivo || "" });
  if (status === "erro") scheduleRetry(task, task.error);
  save(); broadcast("state");
}

// ── retentativa automática ────────────────────────────────────────────────────
/**
 * Erro volta pra fila sozinho — mas NÃO às cegas. Cada motivo pede um remédio:
 *  - COTA: tentar de novo na hora falha de novo, e a fila inteira morre em sequência (foi o que
 *    aconteceu em 16/09: #17, #18, #19 e #38 em dois minutos). A fila PAUSA até o horário que o
 *    próprio CLI informa e retoma sozinha. Não gasta tentativa: não é culpa da tarefa.
 *  - TEMPO, PORTÃO, REVISOR, falha do processo: volta pra fila depois de um respiro, retomando a
 *    mesma sessão ("continue de onde parou"), no máximo BOARD_RETENTATIVAS vezes.
 *  - MESCLAR/PUBLICAR: NUNCA automático. Um deploy que falhou pela metade pede olho humano.
 */
export function classifyError(motivo, task) {
  const m = String(motivo || "").trim();
  // A marca vem do MOTOR (ele sabe que foi cota); o texto é só reforço, e reconhece os três CLIs.
  if (task?.erroCota) return "cota";
  // Barrado por permissão: tentar de novo dá no mesmo muro. Nunca repete sozinho (ver runTask).
  if (/bloqueado por permissão/.test(m) || task?.negadas?.length) return "manual";
  // A conferência que terminou duas vezes sem veredito já teve a sua volta: não é defeito do agente, e a tentativa não é gasta (#306).
  if (/duas vezes sem veredito/.test(m)) return "manual";
  if (/cc_cli_limit_message/.test(m) || /^you'?ve hit your [\w ]*limit\b/i.test(m)) return "cota";
  if (/usage limit|rate limit|quota (exceeded|reached)|out of credits|limite de uso/i.test(m)) return "cota";
  if (/mescl|publica|deploy|URL do PR|URL de PR/i.test(m)) return "manual";
  if (/tempo esgotado/i.test(m)) return "tempo";
  if (/portão reprovou/i.test(m)) return "portao";
  if (/revisor reprovou/i.test(m)) return "revisor";
  if (/QA reprovou/i.test(m)) return "qa";
  return "falha";
}

/** O horário em que a cota volta, lido da própria mensagem do CLI ("resets 11:40pm"). */
export function parseReset(msg, ref = new Date()) {
  const m = String(msg || "").match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!m) return null;
  let h = Number(m[1]) % 12; if (/pm/i.test(m[3])) h += 12;
  const d = new Date(ref); d.setHours(h, Number(m[2] || 0), 0, 0);
  if (d <= ref) d.setDate(d.getDate() + 1); // já passou hoje → é amanhã
  return d;
}

export function scheduleRetry(task, motivo) {
  const tipo = classifyError(motivo, task);
  const hora = (ms) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (tipo === "manual") {
    task.retentativa = null;
    const bloqueio = /bloqueado por permissão/.test(String(motivo || "")) || task.negadas?.length;
    logEvent(task.id, { t: "retentativa", estado: "manual", texto: bloqueio
      ? "barrado por permissão: tentar de novo dá no mesmo muro — não repito sozinho; libere o acesso ou mude a tarefa"
      : /duas vezes sem veredito/.test(String(motivo || "")) ? "a conferência já rodou de novo e continuou sem veredito — não repito sozinho, e nenhuma tentativa foi gasta"
      : "erro em mesclar/publicar não é repetido sozinho — confira e decida" });
    return;
  }
  if (tipo === "cota") {
    const novo = proximoMotorComCota(task.motor || MOTOR_PADRAO);
    if (novo) { passarBastao(task, novo, "sem cota"); return; }
    const volta = parseReset(motivo);
    // +2 min de folga; nunca menos de 5 min, pra não virar laço se o horário vier estranho.
    const quando = Math.max(volta ? volta.getTime() + 2 * 60000 : Date.now() + 30 * 60000, Date.now() + 5 * 60000);
    state.pausaAte = Math.max(state.pausaAte || 0, quando);
    task.retentativa = { em: new Date(quando).toISOString(), tipo, conta: false };
    logEvent(task.id, { t: "retentativa", estado: "agendada", tipo, texto: `cota esgotada — a fila pausa e esta tarefa volta às ${hora(quando)}` });
    console.log(`${C.amber}⏸ fila pausada por cota até ${hora(quando)}${C.r}`);
    return;
  }
  const n = task.tentativas || 0;
  if (n >= RETRY_MAX) {
    task.retentativa = null;
    logEvent(task.id, { t: "retentativa", estado: "esgotada", tipo, texto: `sem mais tentativas automáticas (${n} de ${RETRY_MAX}) — precisa de você` });
    return;
  }
  task.tentativas = n + 1;
  const quando = Date.now() + RETRY_DELAY_MS;
  task.retentativa = { em: new Date(quando).toISOString(), tipo, conta: true, n: task.tentativas, max: RETRY_MAX };
  logEvent(task.id, { t: "retentativa", estado: "agendada", tipo, texto: `volta pra fila às ${hora(quando)} (tentativa ${task.tentativas} de ${RETRY_MAX}), continuando a mesma sessão` });
}

/**
 * A esteira de uma tarefa: AGENTE → PORTÃO (verificação do projeto) → REVISOR (só no modo PR).
 * O portão só roda se a rodada mexeu em arquivo — perguntar não precisa de teste.
 */
export async function runTask(task) {
  task.agente = nomeDeAgente(task);
  // 🔴 Projeto de PRODUÇÃO trabalha SEMPRE numa cópia, mesmo sem ⚡: a pasta do dono é a bancada
  // DELE. Em 24/09/2026 um bloco de documentação sem commit no CLAUDE.md de um projeto de produção fez o
  // `git pull --ff-only` do agente falhar, e a fila inteira do projeto parou — o sintoma que chegou
  // ao dono foi "o tmux não abre as abas dos eng", porque sem agente rodando não nasce aba.
  const precisaCopia = task.paralelo || PRODUCAO.includes(task.project);
  if (precisaCopia && (!task.worktree || task.worktree.removida || !existsSync(task.worktree.dir))) {
    try { criarCopia(task); }
    catch (e) { task.status = "rodando"; return finaliza(task, "erro", "não consegui criar a cópia isolada: " + cut(String(e.stderr || e.message), 300)); }
  }
  const project = projectOf(task);
  // Rodada que não voltou: o board caiu com o agente no meio (SIGTERM, kill -9, luz) e nada depois do `runAgent` rodou. A foto da
  // pasta é tirada ANTES da rodada por isso; pasta diferente (ou sem git, onde não há foto) = o agente escreveu e a conferência deve.
  if (task.rodadaAberta && (!task.rodadaAberta.arvore || estadoDaArvore(project.dir) !== task.rodadaAberta.arvore)) task.conferenciaPendente = true;
  // A aprovação vale para a pasta que foi aprovada: se ela mudou enquanto a entrega devia (chat, ou o próprio agente da entrega cortado
  // depois de escrever), ou se não há foto, confere de novo, em vez de mesclar com o veredito velho. Commit parcial da entrega também reconfere.
  if (task.entregaPendente && !task.conferenciaPendente && (!task.entregaPendente.arvore || estadoDaArvore(project.dir) !== task.entregaPendente.arvore)) task.conferenciaPendente = true;
  task.rodadaAberta = { arvore: estadoDaArvore(project.dir) };
  // Retomada depois de erro: a mesma sessão continua de onde parou, em vez de receber a tarefa
  // inteira de novo e recomeçar (o que repetiria o trabalho e, no caso de tempo, o mesmo buraco).
  const erroAnterior = task.retomar && task.sessionId ? task.error : null;
  const bastao = task.passagem && !task.sessionId ? task.passagem : null;
  // ⚡ Conflito na junção: a cópia recebeu a pasta atual e o agente resolve (o pedido vem pronto de juntar.mjs).
  const conserto = !bastao && task.consertoJuntar?.pedido ? task.consertoJuntar : null;
  if (task.consertoJuntar) task.consertoJuntar = null;
  // PR em conflito ou com check falhando (a vigia, #279): a rodada só atualiza o PR, e a marca fica até o GitHub confirmar.
  const atualizaPr = task.prVigia?.estado === "atualizando" ? task.prVigia : null;
  // Guarda a reprovação anterior ANTES de limpar: rodada que não mexe em nada não a resolve.
  const reprovaAnterior = task.reprovaPendente || task.revisor?.veredito === "REPROVADO" || task.qa?.veredito === "REPROVADO";
  // Aqui também, antes de limpar: `conferenciaDevida` lê os vereditos que a linha abaixo apaga.
  const parecer = parecerDaVolta(task);
  task.retomar = false;
  task.status = "rodando"; task.busy = true; task.startedAt = now(); task.updatedAt = now(); task.error = null;
  // Conferência já aprovada e só a entrega devendo: os vereditos ficam, porque valem para a entrega retomada (mesclar e a ficha leem).
  // Se a rodada mudar arquivo, a marca liga e a esteira os apaga antes de conferir de novo.
  if (!task.entregaPendente || task.conferenciaPendente) { task.gate = null; task.revisor = null; task.qa = null; }
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (conserto ? "resolver conflito da junção — " : atualizaPr ? "atualizar o PR — " : erroAnterior ? "retomada — " : "") + task.title, projeto: project.slug, dir: project.dir });

  const marca = marcarInstante();
  const base = bastao ? comAnexos(textoDaPassagem(task, MOTORES[bastao.de]?.rotulo || bastao.de, bastao.para, bastao.motivo), task.anexos)
    : conserto ? conserto.pedido
    : erroAnterior
    ? ["A rodada anterior desta tarefa terminou em ERRO:", erroAnterior, "",
        "Continue de onde parou e TERMINE a tarefa. Não recomece do zero e não refaça o que já está feito.",
        "Se o erro foi tempo esgotado: vá direto ao que falta e não abra investigação fora do escopo."].join("\n")
    : atualizaPr ? atualizaPr.pedido
    : comAnexos(task.text, task.anexos);
  // Bastão e retomada falam da tarefa inteira: sem o pedido, a rodada que devia só atualizar o PR refaria o trabalho.
  const semParecer = atualizaPr && !conserto && base !== atualizaPr.pedido ? `${base}\n\n---\n\n${atualizaPr.pedido}` : base;
  // Toda volta com reprova em aberto leva o parecer, qualquer que seja o pedido: retomada, bastão (outro motor nunca o viu), "rodar de novo", vigia.
  const comParecer = (texto) => (parecer ? `${texto}\n\n---\n\n${parecer}` : texto);
  const prompt = comParecer(semParecer);
  if (parecer) logEvent(task.id, { t: "solto", texto: "↻ o parecer da reprovação vai inteiro nesta rodada" });
  if (bastao) task.passagem = null; // o bastão só vale para a primeira rodada do novo motor
  // Romaneio: só quando o agente começa do zero (sessão nova ou outro motor). Na retomada, a sessão já tem.
  let pedido = prompt;
  if (ROMANEIO_LIGADO && !task.sessionId && !erroAnterior && !conserto && !atualizaPr) {
    let rom = null; try { rom = montarRomaneio(task, { sentido: await sentidoDoPedido(task) }); } catch (e) { logEvent(task.id, { t: "solto", texto: "⚠ romaneio falhou: " + cut(e.message, 160) }); }
    if (rom) {
      pedido = rom.texto + "\n\n---\n\n## A tarefa\n\n" + prompt;
      const { texto, ...registro } = rom; task.romaneio = registro;
      logEvent(task.id, { t: "romaneio", mentes: rom.mentes, itens: rom.itens, tokens: rom.tokensAprox, modo: rom.modo, semSentido: rom.semSentido });
    }
  }
  let r = await runAgent(task, pedido, { resume: task.sessionId || undefined, fresco: parecer ? comParecer(atualizaPr?.pedido || comAnexos(task.text, task.anexos)) : atualizaPr?.pedido });
  applyRunInfo(task, r);
  task.rodadaAberta = null;
  if (r.cota) task.erroCota = true;
  // No conserto da junção a cópia mudou pelas mãos do board (a pasta atual + a mescla): confere de novo mesmo que o
  // agente não tenha tocado em nada — senão um resultado com portão vermelho voltaria para a pasta sem conferência.
  const mexeu = r.escreveu || mexeuEmArquivo(project.dir, marca) || !!conserto;
  // A conferência é dívida da TAREFA, não da rodada (#290): vale antes dos retornos abaixo, porque agente cortado ou parado depois de escrever também deve.
  if (mexeu) task.conferenciaPendente = true;
  if (task.status !== "rodando") return finaliza(task, task.status, "parada pelo dono");
  if (r.error && !r.result) return finaliza(task, "erro", r.error);
  task.result = r.result;

  // BLOQUEIO DE PERMISSÃO não é defeito de código: repetir não resolve. Em 27/09 (arquivos sob ~/.claude, "sensitive file")
  // o board fez conserto + 2 retentativas = 6 rodadas numa tarefa impossível, US$ 3–4,50 cada. Barrado e nada mudou → para e chama o dono.
  if (r.negadas?.length) {
    task.negadas = [...new Set([...(task.negadas || []), ...r.negadas])];
    logEvent(task.id, { t: "solto", texto: `⚠ a permissão barrou: ${r.negadas.join(" · ")}` });
    if (!mexeu) return finaliza(task, "erro", `bloqueado por permissão (${r.negadas.join(" · ")}) — precisa de você: libere o acesso ou mude a tarefa`);
  }
  // Resposta vazia E nada mexido = o motor não trabalhou (permissão negada, saída vazia…).
  // Marcar isso como "executada" é o pior dos mundos: parece pronto e não é (#127 no Gemini).
  if (!String(task.result || "").trim() && !mexeu) {
    return finaliza(task, "erro", "o motor não produziu resposta nem mexeu em arquivo — veja o histórico");
  }
  // Reprovação pendente e rodada sem mudança: só é "o defeito continua" se a pasta está IGUAL à da reprovação. Se mudou,
  // o conserto foi feito numa rodada anterior e a conferência é que ficou pela metade (a #188, 08/10: o portão foi cortado
  // por tempo depois do conserto, e o board exigia mudança que não havia a fazer — erro duas vezes, sem saída).
  const consertoAnterior = reprovaAnterior && !mexeu && task.reprovaArvore && estadoDaArvore(project.dir) !== task.reprovaArvore;
  if (reprovaAnterior && !mexeu && !consertoAnterior) {
    return finaliza(task, "erro", "a conferência tinha REPROVADO e esta rodada não mexeu em nada — o defeito continua de pé");
  }
  if (consertoAnterior) logEvent(task.id, { t: "solto", texto: "↻ esta rodada não mudou nada, mas a pasta mudou desde a reprovação: o conserto já foi feito antes — a conferência roda de novo" });
  // Conferência cortada (QA encerrado sem veredito, portão por tempo, reinício) continua devida: sem isto, a retomada que
  // não muda arquivo fechava como "executada" sem revisor nem QA (o agente da #286 achou, 01/11). Vale para a entrega também.
  else if (task.conferenciaPendente && !mexeu) logEvent(task.id, { t: "solto", texto: "↻ esta rodada não mudou nada, mas a conferência ficou devendo (cortada antes do veredito): ela roda de novo" });
  const confere = mexeu || !!consertoAnterior || !!task.conferenciaPendente;
  const v = await esteira(task, project, { mexeu: confere });
  return fecharConferida(task, project, v, { mexeu: confere, atualizaPr });
}

/** Fecha a tarefa de entrega por PR que não deixou nada para entregar: executada, com o resumo que o agente já deu. */
function fecharSemEntrega(task) {
  logEvent(task.id, { t: "solto", texto: "nada para entregar: a pasta está limpa e igual à publicada — fecha sem PR" });
  return finaliza(task, "executada");
}

/** Liga a dívida da entrega com a foto da pasta aprovada. Sem a foto, a retomada não teria como saber para o que a aprovação vale. */
function devendoEntrega(task, project, exigirPr) {
  task.entregaPendente = { exigirPr: task.entregaPendente?.exigirPr ?? exigirPr, arvore: estadoDaArvore(project.dir) };
  return task.entregaPendente;
}

/** O que vem depois da esteira, igual para a rodada do agente e para a conferência de um conserto feito no chat. */
async function fecharConferida(task, project, v, { mexeu, atualizaPr = null }) {
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  // Modo PR/deploy sem PR aberto: o agente fez o trabalho mas não entregou — entrega agora.
  // ⚠️ Só se a rodada MEXEU em arquivo: tarefa de diagnóstico ("pode verificar?") responde sem
  // mudar nada, e exigir PR dela virava erro (22/09/2026).
  // A entrega também é dívida da tarefa (#290): cortada no meio, a retomada sem mudança entrega de novo, sem repetir a conferência que já aprovou.
  if ((mexeu || task.entregaPendente) && (task.entrega === "pr" || task.entrega === "deploy") && !task.prUrl) {
    // Nada a entregar (pasta limpa, HEAD já publicado): fecha com o resumo, sem a rodada de entrega. Sem isto, a rodada que só
    // mexeu em arquivo ignorado (dependência instalada, rascunho apagado) pedia PR, a entrega voltava sem URL e cada ▶ repetia (#325).
    if (nadaParaEntregar(project.dir)) return fecharSemEntrega(task);
    return entregar(task, project, devendoEntrega(task, project, true));
  }
  // 🔴 Atualizar o PR nunca mescla: no modo "mesclar e publicar", a volta da vigia para antes do merge.
  if (task.entrega === "deploy" && !atualizaPr && !task.semMesclar) {
    const p = await mesclarEPublicar(task, project);
    if (!p.ok) return finaliza(task, "erro", p.motivo);
  }
  finaliza(task, "executada");
}

/**
 * A CONFERÊNCIA: portão (verificação do projeto) e, no modo PR, revisor — com uma rodada de
 * conserto pelo próprio agente. Vale para a tarefa recém-rodada e para o "Virar PR" de uma
 * tarefa antiga, por isso mora fora do runTask.
 */
export async function esteira(task, project, { mexeu }) {
  const comando = gateCommand(project);
  let rodada = 0;
  if (mexeu) { task.conferenciaPendente = true; task.gate = null; task.revisor = null; task.qa = null; } // só a linha `ok: true` no fim tira a marca: parada, corte e reprova deixam devendo

  while (true) {
    // ── portão ──────────────────────────────────────────────────────────────
    if (comando && mexeu) {
      etapa(task, "portao");
      logEvent(task.id, { t: "portao", estado: "rodando", comando });
      const g = await runGate(task, project, comando);
      if (task.status !== "rodando") return { parou: true };
      task.gate = { comando, ok: g.ok, code: g.code, em: now() };
      logEvent(task.id, { t: "portao", estado: g.ok ? "passou" : "falhou", comando, code: g.code, saida: g.saida, ...(g.estourou ? { cortado: true } : {}) });
      if (!g.ok) {
        // Cortado por tempo não é teste falhando: mandar o agente "consertar" era pedir mudança que não existe.
        if (g.estourou) return { ok: false, motivo: `o portão passou de ${GATE_TIMEOUT_MS / 60000} min e foi interrompido (${comando}) — não é teste falhando; se a bateria do projeto cresceu, aumente BOARD_PORTAO_TIMEOUT_MIN` };
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o portão reprovou (${comando})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task, pedidoDeConserto("portao", g.saida, comando), { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // roda o portão de novo
      }
    }
    // ── revisor: em TODA tarefa que mexeu em arquivo (antes era só no modo PR) ─
    // Decisão do dono em 16/09 ("fica Revisor > QA"): o revisor custou 1,1% do gasto e pegou
    // entrega com teste instável que o portão, rodando uma vez só, deixou passar.
    if (REVISOR_LIGADO && mexeu) {
      etapa(task, "revisor");
      const rev = await parecerDe(task, project, "revisor", rodada);
      if (task.status !== "rodando") return { parou: true };
      if (rev.falhou) return { ok: false, motivo: rev.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.revisor = { veredito: rev.veredito, rodadas: rodada, em: now() };
      if (!rev.aprovado) {
        task.reprovaPendente = true; task.reprovaArvore = estadoDaArvore(project.dir); // só sai com a conferência inteira aprovada (fim da esteira)
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o revisor reprovou (${rev.veredito})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task, pedidoDeConserto("revisor", rev.texto), { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // volta pro portão e revisa de novo
      }
    }
    // ── QA: tenta quebrar, rodando de verdade (inclui instabilidade da entrega) ─
    if (QA_LIGADO && mexeu) {
      etapa(task, "qa");
      const qa = await parecerDe(task, project, "qa", rodada);
      if (task.status !== "rodando") return { parou: true };
      if (qa.falhou) return { ok: false, motivo: qa.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.qa = { veredito: qa.veredito, rodadas: rodada, em: now() };
      if (!qa.aprovado) {
        task.reprovaPendente = true; task.reprovaArvore = estadoDaArvore(project.dir);
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o QA reprovou (${qa.veredito})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task, pedidoDeConserto("qa", qa.texto), { resume: task.sessionId || undefined });
        applyRunInfo(task, fix);
        if (task.status !== "rodando") return { parou: true };
        // ⚠️ A rodada de CONSERTO também pode estourar cota ou falhar. Ignorar isso fazia o board
        // seguir para o portão, reprovar e culpar o código por uma falha de motor (#127, 22/09).
        if (fix.cota) { task.erroCota = true; return { ok: false, motivo: fix.error || "cota esgotada no conserto" }; }
        if (fix.error && !String(fix.result || "").trim()) return { ok: false, motivo: fix.error };
        if (fix.result) task.result = fix.result;
        continue; // portão → revisor → QA de novo
      }
    }
    break;
  }
  task.conferenciaPendente = false;
  // Aqui, e não em cada aprovação: o revisor aprovar não desfaz a reprova do QA, e o QA cortado depois do conserto voltaria dizendo "o defeito continua" sem foto para comparar.
  task.reprovaPendente = false; task.reprovaArvore = null;
  return { ok: true };
}

/**
 * MESCLAR E PUBLICAR — o passo que a casa sempre deixou na mão do dono. Só roda com trava:
 * comando declarado pelo dono em data/deploy.json, portão verde, revisor APROVADO e PR aberto.
 * Quem mescla e quem publica são COMANDOS FIXOS, não o agente improvisando: publicação
 * improvisada é o caminho mais curto para derrubar produção.
 */
export async function mesclarEPublicar(task, project) {
  const comando = deployCommand(project);
  if (!comando) return { ok: false, motivo: `o projeto "${project.slug}" não tem comando de publicação declarado (data/deploy.json)` };
  if (!task.prUrl) return { ok: false, motivo: "não achei a URL do PR para mesclar" };
  if (!task.revisor || task.revisor.veredito !== "APROVADO") return { ok: false, motivo: "o revisor não aprovou — não mesclo" };
  if (task.gate && !task.gate.ok) return { ok: false, motivo: "o portão não passou — não mesclo" };

  etapa(task, "merge");
  const mergeCmd = `gh pr merge ${JSON.stringify(task.prUrl)} --squash --delete-branch`;
  logEvent(task.id, { t: "passo", nome: "merge", estado: "rodando", comando: mergeCmd });
  const m = await runGate(task, project, mergeCmd);
  logEvent(task.id, { t: "passo", nome: "merge", estado: m.ok ? "passou" : "falhou", comando: mergeCmd, code: m.code, saida: m.saida });
  if (!m.ok) return { ok: false, motivo: "não consegui mesclar o PR" };
  task.merged = { em: now() };

  etapa(task, "deploy");
  logEvent(task.id, { t: "passo", nome: "deploy", estado: "rodando", comando });
  const d = await runGate(task, project, comando, DEPLOY_TIMEOUT_MS);
  logEvent(task.id, { t: "passo", nome: "deploy", estado: d.ok ? "passou" : "falhou", comando, code: d.code, saida: d.saida });
  task.deploy = { comando, ok: d.ok, em: now() };
  if (!d.ok) return { ok: false, motivo: `a publicação falhou (${comando}) — ⚠️ o PR JÁ FOI MESCLADO, confira o servidor` };
  return { ok: true };
}

/**
 * VIRAR PR — o trabalho já está feito na pasta; isto só ENTREGA (confere e abre o Pull Request),
 * na mesma sessão do agente. Existe porque a decisão de virar PR quase sempre vem DEPOIS de ver
 * o resultado, e refazer a tarefa inteira só para ganhar um PR seria pagar duas vezes pelo mesmo.
 */
export async function prTask(task, alvo = "pr") {
  const project = projectOf(task);
  task.entrega = alvo; task.status = "rodando"; task.busy = true; task.error = null; task.conferir = null;
  task.gate = null; task.revisor = null; task.qa = null;
  // Pedido na mão: sem mudança na pasta, não é erro. A dívida guarda isso para a retentativa, que volta pelo runTask, inclusive com a conferência cortada.
  task.entregaPendente = { exigirPr: false }; task.semMesclar = false;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (alvo === "deploy" ? "entregar, mesclar e publicar — " : "entrega por PR — ") + task.title, projeto: project.slug, dir: project.dir });

  const v = await esteira(task, project, { mexeu: true });
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  await entregar(task, project, devendoEntrega(task, project, false));
}

/**
 * O passo de ENTREGA (branch, commit, push, PR) e, no modo deploy, mesclar e publicar.
 * Chamado pelo "Virar PR" e também no fim de uma tarefa em modo PR cujo agente terminou sem
 * abrir o PR — já aconteceu: 20 arquivos prontos na main, revisor aprovando, e
 * ninguém para abrir o PR.
 */
export async function entregar(task, project, { exigirPr = true } = {}) {
  etapa(task, "entrega");
  const r = await runMotor(task,
    ["O trabalho desta tarefa JÁ ESTÁ FEITO nesta pasta. NÃO refaça nada e não mude o comportamento do código.",
      "Sua única função agora é ENTREGAR por Pull Request, seguindo a sequência de entrega das regras.",
      "Se não houver mudança nenhuma para entregar, diga isso e não invente commit.",
      "Responda com a URL do PR."].join("\n"),
    { resume: task.sessionId || undefined });
  applyRunInfo(task, r);
  if (task.status !== "rodando") return finaliza(task, task.status, "parada pelo dono");
  if (r.error && !r.result) return finaliza(task, "erro", r.error);
  task.result = r.result;
  if (!task.prUrl) {
    // Sem PR pode ser as duas coisas: não havia nada a entregar (certo) ou o agente falhou (erro).
    // Automático (a rodada mexeu em arquivo) exige PR; pedido na mão só reclama se a pasta tem
    // mudança pendente — e mesmo assim ela pode ser do dono, então o texto diz isso.
    if (!exigirPr && !haMudancas(project.dir)) { logEvent(task.id, { t: "solto", texto: "nada para entregar: a pasta não tem mudança pendente" }); return finaliza(task, "executada"); }
    // Automático também: o agente da entrega disse "não há o que entregar" e a pasta confirma (limpa, HEAD já publicado). Branch
    // empurrada sem PR não passa aqui: o HEAD dela não está no origin/HEAD, e continua erro.
    if (nadaParaEntregar(project.dir)) return fecharSemEntrega(task);
    return finaliza(task, "erro", "a entrega terminou sem URL de PR — veja o resumo do agente (se a tarefa não mudou arquivo, não havia o que entregar)");
  }
  if (task.entrega === "deploy") {
    const p = await mesclarEPublicar(task, project);
    if (!p.ok) return finaliza(task, "erro", p.motivo);
  }
  finaliza(task, "executada");
}

/** O chat que responde pela tarefa agora: ⏹ seguido de outro chat deixa o primeiro terminando por trás. */
const CHAT_DA_VEZ = new Map();

/** A conferência está devendo: algo reprovou e nada aprovou depois (portão, revisor ou QA), ou ela foi cortada antes do veredito. */
export const conferenciaDevida = (task) => !!(task.reprovaPendente || task.conferenciaPendente || task.gate?.ok === false || task.revisor?.veredito === "REPROVADO" || task.qa?.veredito === "REPROVADO");

/**
 * O parecer que esta volta ao agente leva, ou "". Com as rodadas de conserto esgotadas ele nunca chegou à sessão, e a retomada só
 * tinha a frase do erro: nas #286 e #289 o agente disse que o parecer não chegou e foi ao log, ou consertou outra coisa (#299).
 * `soNovo` é o chat: ele não repete a cada mensagem o que a sessão já recebeu.
 */
function parecerDaVolta(task, { soNovo = false } = {}) {
  if (!conferenciaDevida(task)) return "";
  const abertos = pareceresAbertos(task);
  if (!abertos.length) return "";
  const ultimo = abertos.at(-1).at;
  if (soNovo && task.parecerEntregue >= ultimo) return "";
  task.parecerEntregue = ultimo;
  return textoDosPareceres(abertos);
}

/**
 * A conferência de um conserto feito no chat (#288): só a esteira, sem rodar o agente. Vem pela fila (`task.conferir`)
 * porque o portão leva minutos e a pasta é uma só: respeita a vaga do projeto e a pausa, como a retentativa.
 */
export async function conferirTask(task) {
  const project = projectOf(task);
  task.agente = nomeDeAgente(task);
  task.conferir = null; task.retomar = false;
  task.status = "rodando"; task.busy = true; task.startedAt = now(); task.updatedAt = now(); task.error = null;
  task.gate = null; task.revisor = null; task.qa = null;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: "conferir o conserto do chat — " + task.title, projeto: project.slug, dir: project.dir });
  const v = await esteira(task, project, { mexeu: true });
  // 🔴 Com marca da vigia (#279) o PR está em conflito ou com check falhando: aprovar o conserto do chat não mescla.
  return fecharConferida(task, project, v, { mexeu: true, atualizaPr: task.prVigia || null });
}

/**
 * Reprovada e consertada pelo chat: sem isto, portão, revisor e QA não rodavam e a tarefa seguia em erro, calada (#286,
 * 31/10: ~10 h assim). Só vale se a rodada mudou a pasta: pergunta não confere nada. Concluída não volta, e rodada
 * parada pelo dono (`busy` já caiu) fica como ele deixou.
 */
function conferirDepoisDoChat(task, r, parou) {
  if (r.result) task.result = r.result;
  if (parou) return logEvent(task.id, { t: "solto", texto: "⚠ você parou o chat e a pasta mudou: a reprovação segue de pé e o conserto não foi conferido — rode a tarefa de novo" });
  if (task.status === "concluida") return logEvent(task.id, { t: "solto", texto: "⚠ a pasta mudou no chat de uma tarefa concluída com reprovação: portão, revisor e QA não rodam" });
  task.conferir = { em: now() };
  task.status = "fila"; task.retomar = false; task.retentativa = null;
  logEvent(task.id, { t: "retentativa", estado: "na-fila", texto: "o chat mudou arquivo numa tarefa reprovada: na fila para portão, revisor e QA" });
}

export async function chatTask(task, text, anexos = []) {
  task.busy = true; task.updatedAt = now(); save(); broadcast("state");
  const fotos = anexosValidos(anexos);
  logEvent(task.id, { t: "dono", texto: text, anexos: fotos.map((a) => ({ id: a.id, nome: a.nome })) });
  const contexto = `Tarefa #${task.id} do board:\n${task.text}\n\nO dono diz sobre ela:\n${text}`;
  const parecer = parecerDaVolta(task, { soNovo: true });
  const comParecer = (t) => (parecer ? `${t}\n\n---\n\nQuem manda nesta conversa é o dono: faça o que ele disse acima. O que vem abaixo é o contexto da reprovação.\n\n${parecer}` : t);
  const prompt = comAnexos(comParecer(task.sessionId ? text : contexto), fotos);
  const dir = conferenciaDevida(task) ? projectOf(task).dir : null;
  // A árvore do git, não o `find -newer`: ele acha o data/ do próprio board, e a marca é uma só para todas as rodadas.
  const antes = dir && estadoDaArvore(dir);
  const marca = dir && !antes ? marcarInstante() : null;
  // Gravada ANTES da rodada: board que cai no meio não chega ao fim desta função (conferirChatCortado, ao subir).
  if (dir) { task.chatAberto = { arvore: antes }; save(); }
  const eu = {}; CHAT_DA_VEZ.set(task.id, eu);
  const r = await runAgent(task, prompt, { resume: task.sessionId || undefined, fresco: comAnexos(comParecer(contexto), fotos) });
  applyRunInfo(task, r);
  if (CHAT_DA_VEZ.get(task.id) !== eu) return; // o dono parou este e já mandou outro: quem responde pela tarefa é o outro
  CHAT_DA_VEZ.delete(task.id);
  const parou = !task.busy;
  task.busy = false; task.updatedAt = now(); task.chatAberto = null;
  if (r.error && !r.result) logEvent(task.id, { t: "solto", texto: "⚠ " + r.error });
  // Pasta diferente da reprovada também conta: o conserto veio de um chat que não fechou, e repetir o chat só ouviria "já está feito".
  const agora = dir && antes ? estadoDaArvore(dir) : null;
  const mudou = r.escreveu || (antes ? agora !== antes || (task.reprovaArvore && agora !== task.reprovaArvore) : mexeuEmArquivo(dir, marca));
  if (dir && mudou) conferirDepoisDoChat(task, r, parou);
  save(); broadcast("state");
}

/**
 * Ao subir: chat de tarefa reprovada que o board não viu terminar (SIGTERM, `kill -9`, luz). Pasta diferente da foto (ou sem git,
 * onde não há foto) = o conserto pode estar lá, e a tarefa não pode voltar a ficar em erro calada, como a #286 (QA da #288).
 */
export function conferirChatsCortados() {
  for (const t of state.tasks) {
    if (!t.chatAberto) continue;
    const { arvore } = t.chatAberto;
    t.chatAberto = null;
    let mudou = true;
    try { mudou = !arvore || estadoDaArvore(projectOf(t).dir) !== arvore; } catch { /* sem pasta: fica o aviso */ }
    if (!mudou) continue;
    logEvent(t.id, { t: "solto", texto: "⚠ o board caiu no meio do chat e a pasta mudou: o agente pode não ter terminado" });
    conferirDepoisDoChat(t, {}, false);
  }
}
