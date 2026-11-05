// Monitoramento: ai-memory, Mac, servidor, Google Drive e containers Docker, lidos em segundo plano.
import { execFile, execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { COM_ROTINAS, DATA, MARCA_ESPELHO, PORT, SERVIDOR, SERVIDOR_LOCAL, cut } from "./config.mjs";
import { grafoCache } from "./memoria.mjs";

/*
 * A aba Monitoramento: ai-memory, Mac, Atena e Google Drive. A leitura antiga rodava a cada 3 s
 * com execSync — travava o servidor inteiro por segundos — e testava o Drive com `rclone ls | head`,
 * cujo código de saída é o do head (dizia "online" com o rclone falhando). E o Drive "ficava
 * offline" porque o cliente padrão do rclone é compartilhado pelo mundo todo e estoura a cota
 * por minuto (403 RATE_LIMIT_EXCEEDED): o rclone espera ~50 s e consegue. Aqui: tudo assíncrono,
 * ai-memory e Atena a cada 30 s, Drive a cada 10 min com até 2 min de espera. null = sem leitura.
 */
export const INFRA = {
  timestamp: null,
  aiMemory: { online: null, url: null, host: null, pages: 0, sessoes: 0, observacoes: 0, motores: [] },
  copiaBoard: { quando: null, ok: null, erro: null },
  mac: { online: true },
  atena: { online: null, tunnel: "ai-memory-tunnel" },
  googleDrive: { online: null, lastSync: null, lento: false, aviso: null, backups: {}, backupEmDia: null },
  docker: { mac: { online: null, containers: [] }, atena: { online: null, containers: [] } },
  local: SERVIDOR_LOCAL, // o board roda NO servidor (#239): a tela desenha o Atena com o board e o Mac como reserva
  noSaturno: null, // só com BOARD_SERVIDOR=local: board, Central, robo, CRM, tailscale serve e o Mac pela tailnet (#246)
};
// `docker ps -a` + `docker stats` numa chamada só (a mesma linha roda no Mac e, por ssh, no Atena).
export const DOCKER_LER = "docker ps -a --format '{{json .}}' && echo ---STATS--- && docker stats --no-stream --format '{{json .}}'";
export function lerDocker(r, fora) {
  const tudo = r.out + r.err;
  if (!r.out.includes("---STATS---") && !/^\{/m.test(r.out)) {
    return { online: false, motivo: /Cannot connect|daemon/i.test(tudo) ? "Docker desligado" : fora, containers: [] };
  }
  const [ps, st = ""] = r.out.split("---STATS---");
  const stats = {};
  for (const l of st.split("\n")) { try { const j = JSON.parse(l); stats[j.Name] = { cpu: j.CPUPerc, mem: String(j.MemUsage || "").split(" / ")[0] }; } catch { /* linha vazia */ } }
  const containers = [];
  for (const l of ps.split("\n")) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const projeto = (String(j.Labels || "").match(/com\.docker\.compose\.project=([^,]+)/) || [])[1] || "";
    const status = String(j.Status || "");
    containers.push({
      nome: j.Names, imagem: j.Image, estado: j.State, status, projeto,
      saude: /\(healthy\)/.test(status) ? "saudavel" : /unhealthy/.test(status) ? "doente" : /health: starting/.test(status) ? "subindo" : "",
      codigo: /Exited \((\d+)\)/.test(status) ? Number(status.match(/Exited \((\d+)\)/)[1]) : null,
      ...(stats[j.Names] || {}),
    });
  }
  return { online: true, containers };
}
export const infraLida = { rapido: 0, drive: 0 };
export let infraRodando = false;
export const execP = (cmd, args, timeout, extra = {}) => new Promise((ok) => execFile(cmd, args,
  { timeout, encoding: "utf8", maxBuffer: 4 << 20, env: { ...process.env, ...extra, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}` } }, // ~/.local/bin primeiro, como no resto do board
  (e, out, err) => ok({ ok: !e, out: String(out || ""), err: String(err || "") })));
/** Um comando no servidor: por ssh, ou direto quando o board roda nele (BOARD_SERVIDOR=local). */
export const noServidor = (comando, timeout, conecta = 4) => SERVIDOR_LOCAL ? execP("sh", ["-c", comando], timeout)
  : execP("ssh", ["-o", `ConnectTimeout=${conecta}`, "-o", "BatchMode=yes", SERVIDOR, comando], timeout);
// O endereço e o token da memória compartilhada (servidor no Atena; na reserva, o do Mac).
export function envMemoria() {
  try {
    const o = {};
    for (const m of readFileSync(join(process.env.HOME, ".ai-memory-env.sh"), "utf8").matchAll(/export (AI_MEMORY_[A-Z_]+)="([^"]*)"/g)) o[m[1]] = m[2];
    return o;
  } catch { return {}; }
}
// Cada motor está ligado à memória (MCP) e capturando (ganchos) no MESMO servidor? Lê a configuração
// de cada CLI — é isso que decide se a troca de modelo leva a memória junto.
// `instalado` (#246): no Atena só o Claude existe — motor sem binário é "não instalado nesta máquina", não "desligado".
export function motoresDaMemoria(url) {
  const ler = (p) => { try { return readFileSync(join(process.env.HOME, p), "utf8"); } catch { return ""; } };
  const tem = (p) => !!url && ler(p).includes(url.replace(/^https?:\/\//, ""));
  return [
    { nome: "Claude Code", bin: "claude", memoria: tem(".claude.json"), captura: tem(".claude/settings.json") },
    { nome: "Codex", bin: "codex", memoria: tem(".codex/config.toml"), captura: tem(".codex/hooks.json") },
    { nome: "Gemini (agy)", bin: "agy", memoria: tem(".gemini/config/mcp_config.json"), captura: tem(".gemini/config/hooks.json") },
    { nome: "opencode", bin: "opencode", memoria: tem(".config/opencode/opencode.json"), captura: tem(".config/opencode/plugins/ai-memory.ts") },
  ].map(({ bin, ...m }) => ({ ...m, instalado: temBinario(bin) }));
}
// O mesmo PATH do execP (~/.local/bin primeiro). Sem cache: instalar um motor aparece na leitura seguinte.
export function temBinario(bin) {
  const pastas = [`${process.env.HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", ...String(process.env.PATH || "").split(":")];
  return pastas.some((d) => { try { return !!d && statSync(join(d, bin)).isFile(); } catch { return false; } });
}

/*
 * Leituras que no Atena só o root faz (#246). O token de lá é de usuário comum: o `ai-memory status` responde 403
 * "admin operation is root-only", e o rclone.conf do Drive é do root. Com BOARD_SERVIDOR=local o board tenta o
 * `sudo -n` (sem senha; falhou, segue sem) e SÓ com estes comandos FIXOS de leitura — nada vindo de fora entra neles.
 * O status roda como o usuário ai-memory, igual ao backup da madrugada (o /etc/ai-memory/env é do grupo dele).
 */
export const STATUS_MEMORIA_ROOT = `AI_MEMORY_AUTH_TOKEN="$(sed -n 's/^AI_MEMORY_AUTH_TOKEN=//p' /etc/ai-memory/env 2>/dev/null)" HOME=/var/lib/ai-memory-backups exec ai-memory --data-dir /var/lib/ai-memory status`;
const temPaginas = (r) => /pages:\s*\d+/.test(r.out);
/** `ai-memory status`: { ok, out, via: "token"|"sudo"|null, respondeu (o servidor atendeu, mesmo sem dar os números), motivo }. */
export async function lerStatusMemoria(env) {
  const r = await execP("ai-memory", ["status"], 15000, env);
  if (temPaginas(r)) return { ...r, via: "token", respondeu: true, motivo: null };
  const negado = /\b40[13]\b|root-only|Forbidden|Unauthorized/i.test(r.out + r.err);
  if (SERVIDOR_LOCAL && negado) {
    const s = await execP("sudo", ["-n", "-u", "ai-memory", "sh", "-c", STATUS_MEMORIA_ROOT], 15000);
    if (temPaginas(s)) return { ...s, via: "sudo", respondeu: true, motivo: null };
  }
  // 401/403 = o servidor está no ar e recusou o pedido de administrador: no ar, sem os números.
  return { ok: false, out: r.out, err: r.err, via: null, respondeu: negado,
    motivo: negado ? "no ar, mas o status é só do administrador (root) e o sudo não leu" : cut((r.err || r.out).trim().split("\n").pop() || "sem resposta", 160) };
}
/*
 * As duas ESCRITAS do inventário da memória (#259): Descartar (delete-page) e Aplicar do Juntar (write-page). No Atena o
 * token responde 403 "root-only" também aqui; com BOARD_SERVIDOR=local o board tenta de novo pelo `sudo -n`, como o usuário
 * ai-memory, com um comando FIXO por verbo — projeto, caminho e texto entram como argumentos posicionais ("$1"…), nunca no
 * texto do shell. Só estes dois verbos; o board não ganha shell livre no ai-memory.
 */
const RAIZ_MEMORIA = `AI_MEMORY_AUTH_TOKEN="$(sed -n 's/^AI_MEMORY_AUTH_TOKEN=//p' /etc/ai-memory/env 2>/dev/null)" HOME=/var/lib/ai-memory-backups exec ai-memory --data-dir /var/lib/ai-memory`;
export const ESCRITA_MEMORIA_ROOT = {
  "delete-page": `${RAIZ_MEMORIA} delete-page --workspace default --project "$1" --path "$2"`,
  "write-page": `${RAIZ_MEMORIA} write-page --workspace default --project "$1" --path "$2" --tier semantic --kind Note --body "$3"`,
};
// O erro do CLI vem depois de uma linha de log colorida ("INFO ai-memory starting…"): o que interessa é o "Error:" e a causa.
export const erroDoAiMemory = (e) => {
  const linhas = String((e && (e.stderr || e.stdout)) || (e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim())
    .filter((l) => l && !/^\S+Z\s+(INFO|DEBUG|TRACE)\b/.test(l) && l !== "Caused by:");
  return linhas.join(" · ") || "sem resposta";
};
/** delete-page / write-page no ai-memory: pelo token; no servidor, se ele for recusado (root-only), pelo sudo fixo. */
export function escreverNaMemoria(verbo, { projeto, caminho, texto }) {
  if (!ESCRITA_MEMORIA_ROOT[verbo]) throw new Error("ai-memory: verbo não permitido aqui (" + verbo + ")");
  const extra = verbo === "write-page" ? ["--tier", "semantic", "--kind", "Note", "--body", texto] : [];
  const opc = { env: { ...process.env, ...envMemoria(), PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH || ""}` }, timeout: 30000, stdio: "pipe" };
  try { execFileSync("ai-memory", [verbo, "--workspace", "default", "--project", projeto, "--path", caminho, ...extra], opc); return "token"; }
  catch (e) {
    const msg = erroDoAiMemory(e);
    if (!(SERVIDOR_LOCAL && /\b40[13]\b|root-only|Forbidden|Unauthorized/i.test(msg))) throw new Error(msg);
    const pos = verbo === "write-page" ? [projeto, caminho, texto] : [projeto, caminho];
    try { execFileSync("sudo", ["-n", "-u", "ai-memory", "sh", "-c", ESCRITA_MEMORIA_ROOT[verbo], "sh", ...pos], { ...opc, env: process.env }); return "sudo"; }
    catch (e2) { throw new Error(msg.replace(/^Error:\s*/, "") + " — e pelo sudo também não: " + erroDoAiMemory(e2).replace(/^Error:\s*/, "")); }
  }
}
/** rclone só de LEITURA (lsd, size, lsjson). No servidor, o rclone.conf é do root: `sudo -n`. */
export const RCLONE_LEITURAS = new Set(["lsd", "size", "lsjson"]);
export function rcloneLer(args, timeout) {
  if (!RCLONE_LEITURAS.has(args[0])) throw new Error("rclone: só leitura aqui (" + args[0] + ")");
  return SERVIDOR_LOCAL ? execP("sudo", ["-n", "rclone", ...args], timeout) : execP("rclone", args, timeout);
}
// Os dados do board vivem no Mac: o PRÓPRIO board os espelha no Atena a cada 30 min (ele tem acesso
// à ~/Documents; o cron do macOS não tem), e o backup da madrugada do Atena leva ao Drive.
export function copiarBoardProSaturno() {
  // Board rodando no próprio servidor: não há para onde copiar (e o rsync local apagaria o espelho que o Mac mantém).
  if (SERVIDOR_LOCAL) { INFRA.copiaBoard = { quando: new Date().toISOString(), ok: null, erro: "o board roda no próprio servidor: sem cópia" }; return; }
  // As capturas do navegador dos agentes (#217) mostram páginas logadas do dono: não saem da máquina.
  execFile("rsync", ["-a", "--delete", "--exclude", "navegador/", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=8", DATA + "/", SERVIDOR + ":backups/board-data/"],
    { timeout: 15 * 60000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}` } },
    (e, _o, err) => { INFRA.copiaBoard = { quando: new Date().toISOString(), ok: !e, erro: e ? cut(String(err || e.message), 200) : null }; });
}
// O cofre do Obsidian "Memória" (~/Documents/Memoria): espelho só-leitura do ai-memory do Atena + memórias
// do Mac, para o dono VER o grafo. Mesmo motivo da cópia acima: quem tem acesso à ~/Documents é o board.
export function atualizarCofreObsidian() {
  if (SERVIDOR_LOCAL) return lerEspelhoDoServidor();
  execFile(join(process.env.HOME, ".local/bin/memoria-obsidian"), [], { timeout: 5 * 60000 },
    (e) => { INFRA.espelho = { quando: new Date().toISOString(), ok: !e }; grafoCache.em = 0; });
}
// No servidor (#255) quem espelha é o timer do usuário memoria-espelho (o board não roda nada): a idade do espelho é
// a hora da marca que ele toca quando dá certo. Sem marca = o espelho nunca rodou aqui. Mudou a marca → grafo de novo.
export function lerEspelhoDoServidor() {
  let quando = null; try { quando = statSync(MARCA_ESPELHO).mtime.toISOString(); } catch { /* nunca rodou */ }
  if (quando !== (INFRA.espelho && INFRA.espelho.quando)) grafoCache.em = 0;
  INFRA.espelho = quando ? { quando, ok: true, via: "memoria-espelho" } : null;
  return INFRA.espelho;
} // BOARD_SEM_ROTINAS=1: sem cópia para o servidor, sem espelho, sem leituras de fundo (demo)
if (COM_ROTINAS) {
  setTimeout(atualizarCofreObsidian, 120000);
  setInterval(atualizarCofreObsidian, 10 * 60000);
  setTimeout(copiarBoardProSaturno, 90000);
  setInterval(copiarBoardProSaturno, 30 * 60000);
}

export async function lerInfra() {
  if (infraRodando) return;
  infraRodando = true;
  try {
    const agora = Date.now();
    if (agora - infraLida.rapido > 30000) {
      infraLida.rapido = agora;
      const env = envMemoria();
      const [mem, sat, dMac, dSat, marcas] = await Promise.all([
        lerStatusMemoria(env),
        noServidor("exit", 8000),
        SERVIDOR_LOCAL ? null : execP("sh", ["-c", DOCKER_LER], 15000),
        noServidor(DOCKER_LER, 20000),
        noServidor("cd /var/lib/backup-memoria 2>/dev/null && for f in ULTIMO_*; do printf '%s=%s\\n' \"$f\" \"$(tr -d '\\n' < $f)\"; done", 10000),
      ]);
      INFRA.docker.mac = dMac ? lerDocker(dMac, "sem leitura") : { online: false, motivo: "o board roda no servidor: o Mac não é lido daqui", containers: [] };
      INFRA.docker.atena = lerDocker(dSat, "Atena fora do ar");
      const num = (k) => Number((mem.out.match(new RegExp(k + ":\\s*(\\d+)")) || [])[1] || 0);
      const m = mem.out.match(/pages:\s*(\d+)/);
      const url = env.AI_MEMORY_SERVER_URL || null;
      INFRA.aiMemory.online = !!m || mem.respondeu ? true : false; // 403 do status = servidor no ar, sem os números
      INFRA.aiMemory.numeros = !!m; INFRA.aiMemory.via = mem.via; INFRA.aiMemory.motivo = m ? null : mem.motivo;
      INFRA.aiMemory.pages = m ? Number(m[1]) : 0;
      INFRA.aiMemory.sessoes = num("sessions"); INFRA.aiMemory.observacoes = num("observations");
      INFRA.aiMemory.url = url;
      // No servidor (BOARD_SERVIDOR=local) o 127.0.0.1 é o próprio Atena, não a reserva do Mac.
      INFRA.aiMemory.host = !url ? null : /127\.0\.0\.1|localhost/.test(url) && !SERVIDOR_LOCAL ? "Mac (reserva)" : "Atena";
      INFRA.aiMemory.motores = motoresDaMemoria(url);
      // Backups: as marcas que o /usr/local/sbin/backup-memoria.sh grava no Atena.
      const mk = Object.fromEntries(marcas.out.split("\n").filter(Boolean).map((l) => l.split("=")).map(([k, ...v]) => [k, v.join("=")]));
      // Os backups dos bancos (e todos os outros) aparecem no Controle, que lê a lista de data/backups.json.
      INFRA.googleDrive.backups = { memoria: mk.ULTIMO_OK || null, board: mk.ULTIMO_BOARD_OK || null, arquivo: mk.ULTIMO_ARQUIVO || null };
      const datas = [INFRA.googleDrive.backups.memoria, INFRA.googleDrive.backups.board];
      INFRA.googleDrive.lastSync = datas.every(Boolean) ? datas.sort()[0] : null; // o mais velho dos dois
      INFRA.googleDrive.backupEmDia = marcas.ok ? datas.every((d) => d && Date.now() - Date.parse(d) < 26 * 3600000) : null;
      INFRA.atena.online = sat.ok;
      if (SERVIDOR_LOCAL) {
        INFRA.noSaturno = await lerNoSaturno(url);
        // O Mac virou reserva/cliente: "no ar" = alcançável pela tailnet (sem tailscale, sem leitura).
        const mac = INFRA.noSaturno.mac;
        INFRA.mac = { online: mac ? mac.online : INFRA.noSaturno.tailscale ? false : null, reserva: true, board: mac ? mac.board : null, endereco: mac ? mac.endereco : null };
      }
    }
    if (agora - infraLida.drive > 10 * 60000) {
      infraLida.drive = agora;
      const t0 = Date.now();
      const d = await rcloneLer(["lsd", "gdrive_backup:", "--max-depth", "1", "-v"], 120000);
      const segundos = Math.round((Date.now() - t0) / 1000);
      const cota = /RATE_LIMIT_EXCEEDED|Quota exceeded/i.test(d.err);
      INFRA.googleDrive.online = d.ok;
      INFRA.googleDrive.lento = d.ok && (cota || segundos > 20);
      INFRA.googleDrive.aviso = !d.ok ? "o rclone não conseguiu falar com o Drive" + (SERVIDOR_LOCAL && /password is required|sudo:/.test(d.err) ? " (o sudo -n pediu senha: o rclone.conf é do root)" : "")
        : cota ? `respondeu em ${segundos} s: o cliente padrão do rclone estourou a cota por minuto do Google` : null;
    }
    INFRA.timestamp = new Date().toISOString();
  } finally { infraRodando = false; }
}

/*
 * O que roda no Atena quando o board roda nele (#246): o próprio board, a Central, a robo do atendimento, o CRM, as
 * portas do `tailscale serve` e o Mac (reserva) pela tailnet. Tudo lido daqui, sem tocar em produção: da robo, só o
 * que ela grava na pasta dela (o `last` do vigia e o `envios.log`) e o registro das sessões do Claude.
 */
export const ROBO_PASTA = process.env.BOARD_ROBO_PASTA || join(process.env.HOME || "", "DEV", "atendimento");
export const lerJson = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
export function lerServe(j) {
  const portas = [];
  for (const [hostPorta, w] of Object.entries(j?.Web || {})) {
    const porta = Number(hostPorta.split(":").pop()) || 443;
    const destinos = Object.entries(w.Handlers || {}).map(([caminho, h]) => ({ caminho, proxy: h.Proxy || h.Path || h.Text || "" }));
    portas.push({ porta, host: hostPorta.replace(/:\d+$/, ""), destinos, funnel: !!(j.AllowFunnel || {})[hostPorta] });
  }
  return portas.sort((a, b) => a.porta - b.porta);
}
const portaDe = (u) => Number((String(u || "").match(/:(\d+)(?:\/|$)/) || [])[1]) || null;
// O que cada porta do serve leva: o board, a memória, ou (o resto) o app público do Funnel — o CRM, no dono.
export function papelDaPorta(p, urlMemoria) {
  const alvo = portaDe(p.destinos.find((d) => d.caminho === "/")?.proxy || p.destinos[0]?.proxy);
  if (alvo === PORT) return "board";
  if (alvo && alvo === portaDe(urlMemoria)) return "ai-memory";
  return p.funnel ? "CRM (Funnel, público)" : "outro app";
}
/** Último `./qf-enviar <conversa>` da robo que deu certo, pelo transcrito local da sessão (só a hora; o texto não sai daqui). */
export function ultimoEnvioDaRobo(pasta = ROBO_PASTA, dirProjetos = join(process.env.HOME || "", ".claude", "projects")) {
  const dir = join(dirProjetos, pasta.replace(/[^A-Za-z0-9]/g, "-"));
  let arqs = [];
  try { arqs = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 4); } catch { return null; }
  for (const { f } of arqs) {
    let texto = ""; try { const b = readFileSync(f); texto = b.subarray(Math.max(0, b.length - (8 << 20))).toString("utf8"); } catch { continue; }
    const pedidos = new Map(); let ultimo = null;
    for (const l of texto.split("\n")) {
      if (!l.includes("qf-enviar") && !l.includes("tool_result")) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      for (const c of (Array.isArray(j.message?.content) ? j.message.content : [])) {
        if (c.type === "tool_use" && c.name === "Bash" && /(^|[\s;&|/(])qf-enviar(-arquivo)?\s+\d+/.test(c.input?.command || "")) pedidos.set(c.id, j.timestamp);
        else if (c.type === "tool_result" && pedidos.has(c.tool_use_id) && !c.is_error) ultimo = pedidos.get(c.tool_use_id);
      }
    }
    if (ultimo) return ultimo;
  }
  return null;
}
export async function lerRobo() {
  if (!existsSync(ROBO_PASTA)) return null;
  const conta = (r) => r.ok ? r.out.trim().split("\n").filter(Boolean).length : 0;
  const [tmux, servico, vigia, claude] = await Promise.all([
    execP("tmux", ["has-session", "-t", "robo"], 5000),
    execP("systemctl", ["--user", "is-active", "robo-tmux"], 5000),
    // Ancorado no começo: o prompt da própria robo cita "vigia.sh" e não pode contar como vigia.
    execP("pgrep", ["-f", String.raw`^(/usr)?(/bin/)?bash +(\S*/)?vigia\.sh( |$)`], 5000),
    execP("pgrep", ["-f", String.raw`^(\S*/)?claude --name robo( |$)`], 5000),
  ]);
  let last = null, lastEm = null, envioArquivo = null;
  try { last = readFileSync(join(ROBO_PASTA, "last"), "utf8").trim() || null; lastEm = statSync(join(ROBO_PASTA, "last")).mtime.toISOString(); } catch { /* sem vigia ainda */ }
  try { const ls = readFileSync(join(ROBO_PASTA, "envios.log"), "utf8").trim().split("\n"); const u = ls[ls.length - 1].split("\t"); if (ls.length > 1) envioArquivo = { quando: new Date(u[0].replace(/([+-]\d\d)(\d\d)$/, "$1:$2")).toISOString(), resultado: u[6] || null }; } catch { /* nenhum arquivo enviado */ }
  return { pasta: ROBO_PASTA, tmux: tmux.ok, servico: servico.out.trim() || "sem leitura", vigia: conta(vigia), claude: conta(claude),
    last, lastEm, ultimoEnvio: ultimoEnvioDaRobo(), envioArquivo };
}
export async function lerNoSaturno(urlMemoria) {
  const [serveR, statusR, robo, conversa] = await Promise.all([
    execP("tailscale", ["serve", "status", "--json"], 8000),
    execP("tailscale", ["status", "--json"], 8000),
    lerRobo(),
    import("./conversa.mjs"),
  ]);
  const serve = lerServe(lerJson(serveR)).map((p) => ({ ...p, papel: papelDaPorta(p, urlMemoria) }));
  const crmP = serve.find((p) => /CRM/.test(p.papel));
  const crmAlvo = crmP && (crmP.destinos.find((d) => d.caminho === "/") || crmP.destinos[0])?.proxy;
  const crm = !crmAlvo ? null : { porta: crmP.porta, alvo: crmAlvo, online: /^http/.test(crmAlvo)
    ? /^[1-4]\d\d$/.test((await execP("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "6", crmAlvo], 9000)).out.trim()) : null };
  // O Mac (reserva): o par macOS da tailnet. O Atena não usa o DNS da tailnet: o curl vai pelo IP (--resolve).
  const st = lerJson(statusR);
  const par = Object.values(st?.Peer || {}).find((p) => p.OS === "macOS" && (!process.env.BOARD_MAC_HOST || p.HostName === process.env.BOARD_MAC_HOST));
  let mac = null;
  if (par) {
    const dns = String(par.DNSName || "").replace(/\.$/, ""), ip = (par.TailscaleIPs || [])[0];
    let board = null;
    if (par.Online && dns && ip) {
      const r = await execP("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8", "--resolve", `${dns}:443:${ip}`, `https://${dns}/api/usage`], 11000);
      board = /^2\d\d$/.test(r.out.trim());
    }
    mac = { nome: par.HostName, dns, online: !!par.Online, board, endereco: dns ? "https://" + dns : null };
  }
  const central = conversa.vivos.has("central");
  return { lidoEm: new Date().toISOString(), board: { online: true, porta: PORT, tailnet: serve.find((p) => p.papel === "board")?.porta || null },
    central: { viva: central }, robo, crm, serve, tailscale: serveR.ok || statusR.ok, mac };
}
