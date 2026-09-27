// A esteira: agente → portão → revisor → QA, a retentativa pelo motivo, a entrega por PR e o mesclar/publicar.
import { spawn, execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { C, DATA, DEPLOY_FILE, DEPLOY_TIMEOUT_MS, GATE_FILE, GATE_TIMEOUT_MS, MOTOR_PADRAO, PRODUCAO, QA_LIGADO, QA_MODEL, QA_TIMEOUT_MS, RETRY_DELAY_MS, RETRY_MAX, REVIEW_MODEL, REVIEW_ROUNDS, REVISOR_LIGADO, cut, now, stripAnsi } from "./config.mjs";
import { broadcast, gates, logEvent, save, state } from "./estado.mjs";
import { criarCopia, haMudancas, nomeDeAgente, projectOf } from "./projetos.mjs";
import { ROMANEIO_LIGADO, montarRomaneio, sentidoDoPedido } from "./memoria.mjs";
import { MOTORES, runAgent, runMotor } from "./motores.mjs";
import { qaRules, reviewerRules } from "./regras.mjs";
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
    const ler = (d) => { buf += stripAnsi(String(d)); if (buf.length > 400000) buf = buf.slice(-200000); };
    cp.stdout.on("data", ler); cp.stderr.on("data", ler);
    cp.on("error", (e) => { buf += "\n" + e.message; });
    cp.on("close", (code) => {
      clearTimeout(timer); gates.delete(task.id);
      const saida = buf.split(/\r?\n/).filter((l) => l.trim()).slice(-60).join("\n");
      done({ ok: !estourou && code === 0, code, saida: estourou ? saida + `\n(passou de ${limite / 60000} min e foi interrompido)` : saida });
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

/**
 * O veredito de revisor e QA. Prefere a LINHA que é só a palavra: o modelo às vezes escreve uma
 * frase antes (visto no teste do QA em 16/09), e procurar a primeira ocorrência solta leria
 * "o revisor tinha APROVADO, mas…" como aprovação. Sem veredito legível → null (fail-closed).
 */
export function lerVeredito(texto) {
  const t = String(texto || "");
  const linha = t.match(/^[\s*_#>`-]*(APROVADO|REPROVADO)[\s*_.!`]*$/im);
  if (linha) return linha[1].toUpperCase();
  const m = t.match(/\b(APROVADO|REPROVADO)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** Devolve o veredito do revisor. Sem veredito legível é REPROVA — fail-closed. */
export async function runReviewer(task, project) {
  const r = await runMotor(task,
    [`Revise a tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000)].join("\n"),
    { quem: "revisor", regras: reviewerRules(task, project), modelo: REVIEW_MODEL, tools: "Read,Grep,Glob,Bash" });
  applyRunInfo(task, r);
  if (r.error && !String(r.result || "").trim()) { if (r.cota) task.erroCota = true; return { falhou: true, motivo: `o revisor não rodou: ${cut(r.error, 160)}` }; }
  const veredito = lerVeredito(r.result);
  const ev = { t: "revisor", veredito: veredito || "SEM VEREDITO", texto: r.result || r.error || "", custo: r.cost };
  logEvent(task.id, ev);
  return { aprovado: veredito === "APROVADO", veredito, texto: r.result || "" };
}

/** Devolve o veredito do QA. Sem veredito legível é REPROVA — fail-closed, igual ao revisor. */
export async function runQA(task, project) {
  const r = await runMotor(task,
    [`Teste a entrega da tarefa #${task.id}.`, "", "O que o dono pediu:", comAnexos(task.text, task.anexos), "",
      "O que o agente respondeu que fez:", cut(task.result || "(sem resumo)", 2000)].join("\n"),
    { quem: "qa", regras: qaRules(task, project), modelo: QA_MODEL, tools: "Read,Grep,Glob,Bash", limite: QA_TIMEOUT_MS });
  applyRunInfo(task, r);
  if (r.error && !String(r.result || "").trim()) { if (r.cota) task.erroCota = true; return { falhou: true, motivo: `o QA não rodou: ${cut(r.error, 160)}` }; }
  const veredito = lerVeredito(r.result);
  logEvent(task.id, { t: "qa", veredito: veredito || "SEM VEREDITO", texto: r.result || r.error || "", custo: r.cost });
  return { aprovado: veredito === "APROVADO", veredito, texto: r.result || r.error || "" };
}

/** Marca em que etapa a tarefa está (agente → portão → revisor → QA) e avisa a tela. */
export function etapa(task, nome) { task.etapa = nome; task.updatedAt = now(); save(); broadcast("state"); }

export function finaliza(task, status, motivo) {
  task.status = status; task.busy = false; task.etapa = null; task.finishedAt = now(); task.updatedAt = now();
  if (status === "erro") task.error = motivo || task.error;
  if (status === "executada") { task.tentativas = 0; task.retentativa = null; }
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
  // Retomada depois de erro: a mesma sessão continua de onde parou, em vez de receber a tarefa
  // inteira de novo e recomeçar (o que repetiria o trabalho e, no caso de tempo, o mesmo buraco).
  const erroAnterior = task.retomar && task.sessionId ? task.error : null;
  const bastao = task.passagem && !task.sessionId ? task.passagem : null;
  // Guarda a reprovação anterior ANTES de limpar: rodada que não mexe em nada não a resolve.
  const reprovaAnterior = task.reprovaPendente || task.revisor?.veredito === "REPROVADO" || task.qa?.veredito === "REPROVADO";
  task.retomar = false;
  task.status = "rodando"; task.busy = true; task.startedAt = now(); task.updatedAt = now(); task.error = null;
  task.gate = null; task.revisor = null; task.qa = null;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (erroAnterior ? "retomada — " : "") + task.title, projeto: project.slug, dir: project.dir });

  const marca = marcarInstante();
  const prompt = bastao ? comAnexos(textoDaPassagem(task, MOTORES[bastao.de]?.rotulo || bastao.de, bastao.para, bastao.motivo), task.anexos)
    : erroAnterior
    ? ["A rodada anterior desta tarefa terminou em ERRO:", erroAnterior, "",
        "Continue de onde parou e TERMINE a tarefa. Não recomece do zero e não refaça o que já está feito.",
        "Se o erro foi tempo esgotado: vá direto ao que falta e não abra investigação fora do escopo."].join("\n")
    : comAnexos(task.text, task.anexos);
  if (bastao) task.passagem = null; // o bastão só vale para a primeira rodada do novo motor
  // Romaneio: só quando o agente começa do zero (sessão nova ou outro motor). Na retomada, a sessão já tem.
  let pedido = prompt;
  if (ROMANEIO_LIGADO && !task.sessionId && !erroAnterior) {
    let rom = null; try { rom = montarRomaneio(task, { sentido: await sentidoDoPedido(task) }); } catch (e) { logEvent(task.id, { t: "solto", texto: "⚠ romaneio falhou: " + cut(e.message, 160) }); }
    if (rom) {
      pedido = rom.texto + "\n\n---\n\n## A tarefa\n\n" + prompt;
      const { texto, ...registro } = rom; task.romaneio = registro;
      logEvent(task.id, { t: "romaneio", mentes: rom.mentes, itens: rom.itens, tokens: rom.tokensAprox, modo: rom.modo, semSentido: rom.semSentido });
    }
  }
  let r = await runAgent(task, pedido, { resume: task.sessionId || undefined });
  applyRunInfo(task, r);
  if (r.cota) task.erroCota = true;
  if (task.status !== "rodando") return finaliza(task, task.status, "parada pelo dono");
  if (r.error && !r.result) return finaliza(task, "erro", r.error);
  task.result = r.result;

  const mexeu = r.escreveu || mexeuEmArquivo(project.dir, marca);
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
  if (reprovaAnterior && !mexeu) {
    return finaliza(task, "erro", "a conferência tinha REPROVADO e esta rodada não mexeu em nada — o defeito continua de pé");
  }
  const v = await esteira(task, project, { mexeu });
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  // Modo PR/deploy sem PR aberto: o agente fez o trabalho mas não entregou — entrega agora.
  // ⚠️ Só se a rodada MEXEU em arquivo: tarefa de diagnóstico ("pode verificar?") responde sem
  // mudar nada, e exigir PR dela virava erro (22/09/2026).
  if (mexeu && (task.entrega === "pr" || task.entrega === "deploy") && !task.prUrl) return entregar(task, project);
  if (task.entrega === "deploy") {
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

  while (true) {
    // ── portão ──────────────────────────────────────────────────────────────
    if (comando && mexeu) {
      etapa(task, "portao");
      logEvent(task.id, { t: "portao", estado: "rodando", comando });
      const g = await runGate(task, project, comando);
      if (task.status !== "rodando") return { parou: true };
      task.gate = { comando, ok: g.ok, code: g.code, em: now() };
      logEvent(task.id, { t: "portao", estado: g.ok ? "passou" : "falhou", comando, code: g.code, saida: g.saida });
      if (!g.ok) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o portão reprovou (${comando})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O PORTÃO do board reprovou o seu trabalho. O comando de verificação do projeto falhou:",
            "", "$ " + comando, g.saida.slice(-4000), "",
            "Conserte de verdade (não desligue teste nem afrouxe conferência) e responda o que mudou."].join("\n"),
          { resume: task.sessionId || undefined });
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
      const rev = await runReviewer(task, project);
      if (task.status !== "rodando") return { parou: true };
      if (rev.falhou) return { ok: false, motivo: rev.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.revisor = { veredito: rev.veredito, rodadas: rodada, em: now() };
      task.reprovaPendente = !rev.aprovado; // só sai quando alguém aprovar de verdade
      if (!rev.aprovado) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o revisor reprovou (${rev.veredito || "sem veredito"})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O REVISOR do board reprovou o seu trabalho:", "", rev.texto, "",
            "Corrija o que ele apontou e responda o que mudou. Se discordar, explique com evidência."].join("\n"),
          { resume: task.sessionId || undefined });
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
      const qa = await runQA(task, project);
      if (task.status !== "rodando") return { parou: true };
      if (qa.falhou) return { ok: false, motivo: qa.motivo }; // falha de infraestrutura, não reprova o trabalho
      task.qa = { veredito: qa.veredito, rodadas: rodada, em: now() };
      task.reprovaPendente = !qa.aprovado;
      if (!qa.aprovado) {
        if (rodada >= REVIEW_ROUNDS) return { ok: false, motivo: `o QA reprovou (${qa.veredito || "sem veredito"})` };
        rodada++;
        etapa(task, "agente");
        const fix = await runMotor(task,
          ["O QA do board testou a sua entrega e REPROVOU:", "", qa.texto, "",
            "Reproduza cada defeito com o passo que ele deu, conserte na causa, deixe um teste que morda o defeito, e responda o que mudou.",
            "Instabilidade que ele marcou como PRÉ-EXISTENTE não é sua: não mexa nela."].join("\n"),
          { resume: task.sessionId || undefined });
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
  task.entrega = alvo; task.status = "rodando"; task.busy = true; task.error = null;
  task.gate = null; task.revisor = null; task.qa = null;
  etapa(task, "agente");
  logEvent(task.id, { t: "inicio", titulo: (alvo === "deploy" ? "entregar, mesclar e publicar — " : "entrega por PR — ") + task.title, projeto: project.slug, dir: project.dir });

  const v = await esteira(task, project, { mexeu: true });
  if (v.parou) return finaliza(task, task.status, "parada pelo dono");
  if (!v.ok) return finaliza(task, "erro", v.motivo);
  await entregar(task, project, { exigirPr: false }); // pedido na mão: sem mudança, não é erro
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
    return finaliza(task, "erro", "a entrega terminou sem URL de PR — veja o resumo do agente (se a tarefa não mudou arquivo, não havia o que entregar)");
  }
  if (task.entrega === "deploy") {
    const p = await mesclarEPublicar(task, project);
    if (!p.ok) return finaliza(task, "erro", p.motivo);
  }
  finaliza(task, "executada");
}

export async function chatTask(task, text, anexos = []) {
  task.busy = true; task.updatedAt = now(); save(); broadcast("state");
  const fotos = anexosValidos(anexos);
  logEvent(task.id, { t: "dono", texto: text, anexos: fotos.map((a) => ({ id: a.id, nome: a.nome })) });
  const contexto = `Tarefa #${task.id} do board:\n${task.text}\n\nO dono diz sobre ela:\n${text}`;
  const prompt = comAnexos(task.sessionId ? text : contexto, fotos);
  const r = await runAgent(task, prompt, { resume: task.sessionId || undefined, fresco: comAnexos(contexto, fotos) });
  applyRunInfo(task, r);
  task.busy = false; task.updatedAt = now();
  if (r.error && !r.result) logEvent(task.id, { t: "solto", texto: "⚠ " + r.error });
  save(); broadcast("state");
}
