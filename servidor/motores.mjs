// Os motores (claude, codex, gemini, opencode): linha de comando, tradução dos eventos e o modelo de cada rodada.
import { spawn, execFileSync } from "child_process";
import { readFileSync, appendFileSync } from "fs";
import { join } from "path";
import { ANEXOS, ESFORCO_CLAUDE, MODELOS_FILE, MODELO_PADRAO, MOTOR_QA, MOTOR_REVISOR, PERMISSION, QA_MODEL, RAW_LIGADO, REVIEW_MODEL, TIMEOUT_MS, TOOLS, cut, modeloServe, stripAnsi } from "./config.mjs";
import { logEvent, rawPath, running, save, state, toolTarget } from "./estado.mjs";
import { projectOf } from "./projetos.mjs";
import { houseRules } from "./regras.mjs";
import { escolherMotor } from "./uso.mjs";

/**
 * O catálogo de modelos de cada motor: o que dá para escolher na tela e o que cada porte usa.
 * A lista do opencode vem do próprio CLI (`opencode models`); a do Claude são os nomes da casa.
 * O Codex não lista modelos pela CLI, então ali o campo fica livre.
 */
export let modelosCache = null;
export function catalogoModelos() {
  if (modelosCache && Date.now() - modelosCache.t < 300000) return modelosCache.v;
  let mapa = {};
  try { mapa = JSON.parse(readFileSync(MODELOS_FILE, "utf8")); } catch { /* usa o padrão abaixo */ }
  const padraoPortes = {};
  const v = {};
  for (const [id, m] of Object.entries(MOTORES)) {
    if (!temBin(m.bin)) continue;
    let lista = [];
    if (id === "claude") lista = ["haiku", "sonnet", "opus"];
    else if (id === "gemini") {
      try {
        lista = execFileSync("agy", ["models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } })
          .split(/\r?\n/).map((l) => stripAnsi(l).split("\t")[0].trim()).filter((l) => /^[a-z0-9][\w.-]+$/i.test(l));
      } catch { lista = []; }
    }
    else if (id === "opencode") {
      try {
        lista = execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } })
          .split(/\r?\n/).map((l) => stripAnsi(l).trim()).filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l));
      } catch { lista = []; }
    }
    // Claude: porte não troca modelo (é esforço) — o mapa antigo do modelos.json não vale para ele.
    v[id] = { lista, portes: id === "claude" ? {} : { ...(padraoPortes[id] || {}), ...((mapa[id] || {})) },
      esforcos: id === "claude" ? ESFORCO_CLAUDE : null, exemplo: m.exemploModelo };
  }
  modelosCache = { t: Date.now(), v };
  return v;
}

/**
 * O modelo do REVISOR/QA para o motor que vai rodar. O modelo configurado (ex.: `sonnet`) vale só
 * para o motor configurado; quando o papel cai para outro motor por falta de cota, mandar o modelo
 * antigo é 400 na hora ("The 'sonnet' model is not supported when using Codex", 22/09/2026).
 */
export function modeloDePapel(quem, id) {
  const cfg = quem === "revisor" ? { motor: MOTOR_REVISOR, modelo: REVIEW_MODEL } : { motor: MOTOR_QA, modelo: QA_MODEL };
  if (id === cfg.motor && modeloServe(id, cfg.modelo)) return cfg.modelo;
  const padrao = MODELO_PADRAO[id] || "";
  return modeloServe(id, padrao) ? padrao : "";
}

/** O modelo que a rodada usa: escolha explícita > porte > padrão do board > padrão do CLI. */
export function modeloPara(motorId, task) {
  if (task?.modelo) {
    if (modeloServe(motorId, task.modelo)) return task.modelo;
    logEvent(task.id, { t: "solto", texto: `⚠ o modelo "${task.modelo}" não é deste motor (${motorId}) — usando o padrão dele` });
  }
  const porte = task?.porte;
  if (porte && motorId !== "claude") {
    const c = catalogoModelos()[motorId];
    if (c?.portes?.[porte]) return c.portes[porte];
  }
  const padrao = MODELO_PADRAO[motorId] || "";
  return modeloServe(motorId, padrao) ? padrao : "";
}

/**
 * Roda `claude -p` e vai gravando o percurso no log da tarefa, evento a evento.
 * Devolve { result, sessionId, cost, turns, dur, code }.
 */
/**
 * OS MOTORES — cada CLI fala um dialeto; o board normaliza para os mesmos eventos (texto,
 * ferramenta, resultado) e para a mesma sessão retomável. Acrescentar um motor é acrescentar uma
 * entrada aqui: `args` monta a linha de comando, `trata` traduz cada evento do CLI.
 * ⚠️ Custo: o Claude informa dólar por rodada; o Codex informa TOKENS, não dólar. O board mostra
 * o que cada um conta e não inventa a conversão.
 */
export const MOTORES = {
  claude: {
    rotulo: "Claude", bin: "claude", moeda: "usd",
    exemploModelo: "opus, sonnet, haiku",
    args: ({ prompt, regras, tools, modelo, resume, esforco, semCaptura }) => {
      const a = ["-p", prompt, "--append-system-prompt", regras,
        "--output-format", "stream-json", "--verbose", "--allowedTools", tools];
      if (PERMISSION === "bypass") a.push("--dangerously-skip-permissions");
      else a.push("--permission-mode", PERMISSION);
      if (modelo) a.push("--model", modelo);
      if (esforco) a.push("--effort", esforco);
      if (resume) a.push("--resume", resume);
      // Revisor e QA sem os ganchos do usuário (é lá que mora a captura do ai-memory): as sessões deles viravam
      // "memória" — "Revise a tarefa #166" — e o inventário tinha de varrer toda noite. Modelo, permissão e
      // ferramentas continuam vindo por aqui, então nada muda no trabalho deles.
      if (semCaptura) a.push("--setting-sources", "project,local");
      return a;
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.session_id) ctx.sessao(ev.session_id);
      if (ev.type === "assistant") {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_use") {
            if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) out.escreveu = true;
            logEvent(task.id, { t: "ferramenta", nome: c.name, alvo: toolTarget(c.input), quem });
          } else if (c.type === "text" && c.text?.trim()) logEvent(task.id, { t: "texto", texto: c.text, quem });
        }
      } else if (ev.type === "result") {
        out.cost += ev.total_cost_usd || 0;
        out.turns = ev.num_turns || out.turns;
        out.dur = ev.duration_ms || out.dur;
        const texto = ev.result || "";
        // Limite de uso/gasto vem como `result` normal, com texto de aviso — NÃO é resultado da
        // tarefa. Sem isto a tarefa virava "executada" com "You've hit your ... limit" no lugar do
        // resumo (15/09/2026) e o trabalho se perdia sem ninguém notar.
        // ⚠️ Marcador PRÓPRIO do CLI, não palavra solta: a regra antiga (/rate limit/) marcava
        // como "limite" a resposta legítima de um agente que FALOU de rate limit no resumo.
        const cota = /cc_cli_limit_message/.test(texto) || /^you'?ve hit your [\w ]*limit\b/i.test(texto.trim());
        if (ev.is_error || cota) ctx.erro(cut(texto || ev.error || out.ultimoSolto || "o claude devolveu erro", 300), cota);
        else ctx.resultado(texto, { custo: ev.total_cost_usd || 0 });
      }
    },
  },
  codex: {
    rotulo: "Codex", bin: "codex", moeda: "tokens",
    exemploModelo: "gpt-5-codex, o3",
    // Codex não tem system-prompt separado: as regras da casa vão no começo do próprio prompt.
    args: ({ prompt, regras, modelo, resume, imagens, dir }) => {
      // ⚠️ `exec resume` NÃO aceita --sandbox (só o `exec` normal): passar isso dava
      // "unexpected argument '--sandbox'" e código 2 em TODA retomada (#127, 22/09/2026).
      const flags = ["--json", "--skip-git-repo-check"];
      // ⚠️ O sandbox workspace-write bloqueia escrita em `.git`: sem liberar, o agente não troca
      // de branch nem commita ("Operation not permitted" em .git/index.lock, #127). O `-c` vale
      // TAMBÉM na retomada — `exec resume` aceita -c, só não aceita --sandbox.
      if (PERMISSION !== "bypass") {
        if (dir) flags.push("-c", `sandbox_workspace_write.writable_roots=["${join(dir, ".git")}"]`);
        // Sem rede o agente não faz pull, push nem `gh pr` — "Could not resolve host: github.com".
        flags.push("-c", "sandbox_workspace_write.network_access=true");
      }
      if (!resume) flags.push(...(PERMISSION === "bypass" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]));
      if (modelo) flags.push("--model", modelo);
      // `-i` é só imagem: PDF anexado chega pelo caminho no prompt (o agente abre ele mesmo).
      for (const i of imagens || []) if (!i.endsWith(".pdf")) flags.push("-i", i);
      const texto = regras ? regras + "\n\n---\n\n" + prompt : prompt;
      return resume ? ["exec", "resume", ...flags, resume, texto] : ["exec", ...flags, texto];
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.type === "thread.started" && ev.thread_id) ctx.sessao(ev.thread_id);
      else if (ev.type === "item.completed") {
        const it = ev.item || {};
        if (it.type === "agent_message" && it.text?.trim()) { out.result = it.text; logEvent(task.id, { t: "texto", texto: it.text, quem }); }
        else if (it.type === "command_execution") logEvent(task.id, { t: "ferramenta", nome: "Bash", alvo: cut(it.command || "", 100), quem });
        else if (it.type === "file_change") { out.escreveu = true; logEvent(task.id, { t: "ferramenta", nome: "Edit", alvo: cut((it.changes || []).map((c) => c.path).join(", ") || it.path || "", 100), quem }); }
        else if (it.type === "mcp_tool_call") logEvent(task.id, { t: "ferramenta", nome: it.server ? `${it.server}.${it.tool}` : "MCP", alvo: cut(JSON.stringify(it.arguments || {}), 100), quem });
        else if (it.type === "web_search") logEvent(task.id, { t: "ferramenta", nome: "WebSearch", alvo: cut(it.query || "", 100), quem });
        else if (it.type === "error") ctx.erro(cut(it.message || "erro do codex", 300), /usage limit|rate limit/i.test(it.message || ""));
      } else if (ev.type === "turn.completed") {
        const u = ev.usage || {};
        out.turns += 1;
        out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        ctx.resultado(out.result, { tokens: (u.input_tokens || 0) + (u.output_tokens || 0) });
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        const m = ev.error?.message || ev.message || "o codex devolveu erro";
        ctx.erro(cut(m, 300), /usage limit|rate limit|quota/i.test(m));
      }
    },
  },
  gemini: {
    rotulo: "Gemini", bin: "agy", moeda: "tokens",
    exemploModelo: "gemini-3.8-flash-high",
    // ⚠️ `--add-dir`: sem isso o agy NÃO trabalha na pasta de onde foi chamado — ele cai no
    // workspace próprio dele (~/.gemini/antigravity-cli/scratch) e a tarefa acontece no lugar
    // errado, em silêncio (visto em 22/09). O `dir` vem do projeto da tarefa.
    args: ({ prompt, regras, modelo, resume, dir }) => {
      const a = ["-p", regras ? regras + "\n\n---\n\n" + prompt : prompt,
        "--output-format", "stream-json", "--add-dir", dir];
      // ⚠️ `--mode accept-edits` deixa o agy ESCREVER mas NEGA comando em modo headless
      // ("a tool required the command permission ... auto-denied") e a tarefa sai vazia (#127).
      // Sem ninguém para aprovar, a única opção que funciona sem travar é pular a permissão.
      a.push("--dangerously-skip-permissions");
      if (modelo) a.push("--model", modelo);
      if (resume) a.push("--conversation", resume);
      return a.filter(Boolean);
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.event === "init" && ev.init && ev.conversation_id) ctx.sessao(ev.conversation_id);
      else if (ev.event === "step_update") {
        const s = ev.step_update || {};
        if (s.conversation_id && !out.sessionId) ctx.sessao(s.conversation_id);
        // O texto vem em pedaços (text_delta) por passo: junta e solta quando o passo termina.
        if (s.step_type === "agent_response") {
          out.parcial = (out.parcial || "") + (s.text_delta || "");
          if (s.state === "DONE") {
            const txt = (out.parcial || "").trim(); out.parcial = "";
            if (txt) { out.result = txt; logEvent(task.id, { t: "texto", texto: txt, quem }); }
          }
        } else if (s.step_type === "tool" && s.state === "DONE") {
          const ti = s.tool_info || {};
          const nome = ti.name || s.tool_name || "ferramenta";
          if (/write|edit|replace|create/i.test(nome)) out.escreveu = true;
          const par = ti.parameters || {};
          logEvent(task.id, { t: "ferramenta", nome, alvo: cut(par.CommandLine || par.TargetFile || par.Query || JSON.stringify(par), 100), quem });
        }
      } else if (ev.event === "result") {
        const r = ev.result || {};
        const u = r.usage || {};
        out.turns += r.num_turns || 1;
        out.tokens += (u.input_tokens || 0) + (u.output_tokens || 0);
        if (r.status && r.status !== "SUCCESS") ctx.erro(cut(r.response || r.error || `o agy terminou com status ${r.status}`, 300), /limit|quota/i.test(JSON.stringify(r).slice(0, 500)));
        else ctx.resultado(r.response || out.result, { tokens: (u.input_tokens || 0) + (u.output_tokens || 0) });
      }
    },
  },
  opencode: {
    rotulo: "opencode", bin: "opencode", moeda: "ambos",
    exemploModelo: "google/gemini-3-pro, openai/gpt-5.4",
    // Ponte para qualquer provedor que o opencode tenha autenticado (é o caminho do Gemini aqui).
    // Sem system-prompt separado: as regras da casa vão no começo do prompt, como no Codex.
    args: ({ prompt, regras, modelo, resume, imagens }) => {
      // `--auto`: sem isto o opencode recusa sozinho até mexer na pasta do próprio projeto
      // ("permission requested: external_directory ... auto-rejecting", visto em 22/09). O board
      // já roda cada tarefa na pasta certa e com o portão depois; quem escolhe o risco é o dono.
      const a = ["run", "--format", "json", "--auto"];
      if (modelo) a.push("-m", modelo);
      if (resume) a.push("-s", resume);
      for (const i of imagens || []) a.push("-f", i);
      a.push(regras ? regras + "\n\n---\n\n" + prompt : prompt);
      return a;
    },
    trata: (ev, ctx) => {
      const { out, quem, task } = ctx;
      if (ev.sessionID && !out.sessionId) ctx.sessao(ev.sessionID);
      const p = ev.part || {};
      if (ev.type === "text" && p.text?.trim()) { out.result = p.text; logEvent(task.id, { t: "texto", texto: p.text, quem }); }
      else if (ev.type === "tool_use" && p.state?.status === "completed") {
        if (/^(write|edit|patch|multiedit|apply)/i.test(p.tool || "")) out.escreveu = true;
        logEvent(task.id, { t: "ferramenta", nome: p.tool || "ferramenta", alvo: cut(p.state.title || JSON.stringify(p.state.input || {}), 100), quem });
      } else if (ev.type === "step_finish") {
        out.tokens += p.tokens?.total || 0;
        out.cost += p.cost || 0;
        out.turns += 1;
      } else if (ev.type === "error" || p.type === "error") {
        // O `run --format json` manda {type:"error", error:{name, data:{message}}}: a mensagem mora em error.data.message.
        // Antes ia o JSON cru, cortado em 200 caracteres — a tela mostrava o envelope e a cota podia ficar fora do corte.
        const m = ev.error?.data?.message || ev.error?.message || ev.error?.name || ev.message || p.message || JSON.stringify(ev).slice(0, 200);
        ctx.erro(cut(m, 300), /usage limit|rate limit|quota|credit/i.test(m));
      }
    },
    // O opencode não tem evento de "turno acabou": a conta fecha quando o processo sai.
    fim: ({ out, resultado }) => { if (out.result || out.tokens) resultado(out.result, { custo: out.cost, tokens: out.tokens }); },
  },
};

export const temBin = (() => {
  const cache = {};
  return (bin) => {
    if (cache[bin] === undefined) {
      try { execFileSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` } }); cache[bin] = true; }
      catch { cache[bin] = false; }
    }
    return cache[bin];
  };
})();
export const motoresDisponiveis = () => Object.entries(MOTORES).filter(([, m]) => temBin(m.bin))
  .map(([id, m]) => ({ id, rotulo: m.rotulo, moeda: m.moeda, exemploModelo: m.exemploModelo }));
export const motorDe = (id) => MOTORES[id] || MOTORES.claude;

/**
 * O AGENTE, com cura de sessão perdida. O board grava o sessionId no primeiro evento (pra retomar
 * se cair); se a tarefa for parada nos primeiros segundos, o Claude ainda não gravou a conversa e
 * todo `--resume` falha na hora com "No conversation found" — a retentativa virava laço de falha
 * instantânea (já aconteceu). Aqui: sessão perdida → esquece o id e recomeça com o prompt fresco.
 */
export async function runAgent(task, prompt, opts = {}) {
  const { fresco, ...rest } = opts;
  const r = await runMotor(task, prompt, rest);
  if (!(r.sessaoPerdida && rest.resume)) return r;
  logEvent(task.id, { t: "solto", texto: "⚠ a sessão salva desta tarefa não existe mais (foi interrompida antes de o Claude gravar) — recomeçando do zero" });
  task.sessionId = null; save();
  return runMotor(task, fresco || task.text, { ...rest, resume: undefined });
}

export function runMotor(task, prompt, { resume, quem = "agente", regras, modelo, tools, limite = TIMEOUT_MS, motor } = {}) {
  return new Promise((done) => {
    const project = projectOf(task);
    const id = motor || escolherMotor(quem, task);
    const M = motorDe(id);
    // Mensagem começando com "/" viraria slash-command no CLI. É texto do dono, não comando.
    const safe = /^\s*\//.test(prompt) ? "(texto literal do dono, não é comando)\n" + prompt : prompt;
    const modeloEfetivo = modelo && modeloServe(id, modelo) ? modelo
      : quem === "agente" ? modeloPara(id, task) : modeloDePapel(quem, id);
    const esforco = quem === "agente" && id === "claude" && !task.modelo ? ESFORCO_CLAUDE[task.porte] || "" : "";
    if (quem === "agente" && state.tasks.includes(task)) { task.modeloUsado = modeloEfetivo || MODELO_PADRAO[id] || ""; task.esforcoUsado = esforco; task.motorUsado = id; }
    const args = M.args({
      prompt: safe, regras: regras || houseRules(task, project), tools: tools || TOOLS,
      modelo: modeloEfetivo,
      resume, dir: project.dir,
      esforco, semCaptura: quem !== "agente",
      imagens: quem === "agente" ? (task.anexos || []).map((a) => a.caminho || join(ANEXOS, a.id)) : [],
    });

    const env = { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` };
    let cp;
    try { cp = spawn(M.bin, args, { cwd: project.dir, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return done({ result: "", error: `não consegui iniciar o ${M.bin}: ` + e.message }); }
    running.set(task.id, cp);

    const out = { result: "", sessionId: resume || null, cost: 0, tokens: 0, turns: 0, dur: 0, code: null, error: null, escreveu: false, motor: id };
    const comecou = Date.now(); // motor que não informa duração (codex) ganha a do relógio
    let buf = "";
    const timer = setTimeout(() => { out.error = `tempo esgotado (${limite / 60000} min)`; cp.kill("SIGTERM"); }, limite);

    const handleLine = (line) => {
      const s = stripAnsi(line).trim();
      if (!s) return;
      if (RAW_LIGADO) appendFileSync(rawPath(task.id), s + "\n");
      if (!s.startsWith("{")) {
        if (/^Reading additional input from stdin/i.test(s)) return; // ruído do codex, não é evento
        // Erro do CLI sai em texto solto, não em JSON: é ele que explica o "devolveu erro".
        out.ultimoSolto = cut(s, 300);
        if (/No conversation found with session ID/i.test(s)) out.sessaoPerdida = true;
        logEvent(task.id, { t: "solto", texto: cut(s, 400) }); return;
      }
      let ev; try { ev = JSON.parse(s); } catch { return; }
      const ctx = {
        out, quem, task,
        sessao: (sid) => {
          out.sessionId = sid;
          // Só a sessão do AGENTE é a sessão da tarefa; a do revisor é descartável.
          if (quem === "agente" && !task.sessionId) { task.sessionId = sid; save(); }
        },
        erro: (texto, cota) => {
          out.error = texto;
          if (cota) out.cota = true; // quem sabe que foi cota é o motor, não uma palavra no texto
          logEvent(task.id, { t: "solto", texto: (cota ? "⛔ limite de uso: " : "⛔ erro: ") + cut(texto, 300) });
        },
        resultado: (texto, { custo = 0, tokens = 0 } = {}) => {
          out.result = texto || out.result;
          if (!out.dur) out.dur = Date.now() - comecou;
          logEvent(task.id, { t: "resultado", texto: out.result, custo, tokens, turnos: out.turns, dur: out.dur, quem, motor: id });
        },
      };
      M.trata(ev, ctx);
    };
    const onData = (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      lines.forEach(handleLine);
    };
    cp.stdout.on("data", onData);
    cp.stderr.on("data", onData);
    cp.on("error", (e) => { out.error = `não consegui falar com o ${M.bin} (está no PATH?): ` + e.message; });
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      running.delete(task.id);
      out.code = code;
      // Motor que só fecha a conta no fim do processo (opencode) registra o resultado aqui.
      if (M.fim) M.fim({ out, quem, task, resultado: (texto, extra) => {
        out.result = texto || out.result;
        if (!out.dur) out.dur = Date.now() - comecou;
        logEvent(task.id, { t: "resultado", texto: out.result, turnos: out.turns, dur: out.dur, quem, motor: id, ...extra });
      } });
      if (code !== 0 && !out.result && !out.error) out.error = `o ${M.bin} saiu com código ${code}`;
      done(out);
    });
  });
}
