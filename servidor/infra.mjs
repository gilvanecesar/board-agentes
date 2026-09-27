// Monitoramento: ai-memory, Mac, servidor, Google Drive e containers Docker, lidos em segundo plano.
import { execFile } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { COM_ROTINAS, DATA, SERVIDOR, cut } from "./config.mjs";
import { grafoCache } from "./memoria.mjs";

/*
 * A aba Monitoramento: ai-memory, Mac, Saturno e Google Drive. A leitura antiga rodava a cada 3 s
 * com execSync — travava o servidor inteiro por segundos — e testava o Drive com `rclone ls | head`,
 * cujo código de saída é o do head (dizia "online" com o rclone falhando). E o Drive "ficava
 * offline" porque o cliente padrão do rclone é compartilhado pelo mundo todo e estoura a cota
 * por minuto (403 RATE_LIMIT_EXCEEDED): o rclone espera ~50 s e consegue. Aqui: tudo assíncrono,
 * ai-memory e Saturno a cada 30 s, Drive a cada 10 min com até 2 min de espera. null = sem leitura.
 */
export const INFRA = {
  timestamp: null,
  aiMemory: { online: null, url: null, host: null, pages: 0, sessoes: 0, observacoes: 0, motores: [] },
  copiaBoard: { quando: null, ok: null, erro: null },
  mac: { online: true },
  saturno: { online: null, tunnel: "ai-memory-tunnel" },
  googleDrive: { online: null, lastSync: null, lento: false, aviso: null, backups: {}, backupEmDia: null },
  docker: { mac: { online: null, containers: [] }, saturno: { online: null, containers: [] } },
};
// `docker ps -a` + `docker stats` numa chamada só (a mesma linha roda no Mac e, por ssh, no Saturno).
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
  { timeout, encoding: "utf8", maxBuffer: 4 << 20, env: { ...process.env, ...extra, PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH || ""}` } },
  (e, out, err) => ok({ ok: !e, out: String(out || ""), err: String(err || "") })));
// O endereço e o token da memória compartilhada (servidor no Saturno; na reserva, o do Mac).
export function envMemoria() {
  try {
    const o = {};
    for (const m of readFileSync(join(process.env.HOME, ".ai-memory-env.sh"), "utf8").matchAll(/export (AI_MEMORY_[A-Z_]+)="([^"]*)"/g)) o[m[1]] = m[2];
    return o;
  } catch { return {}; }
}
// Cada motor está ligado à memória (MCP) e capturando (ganchos) no MESMO servidor? Lê a configuração
// de cada CLI — é isso que decide se a troca de modelo leva a memória junto.
export function motoresDaMemoria(url) {
  const ler = (p) => { try { return readFileSync(join(process.env.HOME, p), "utf8"); } catch { return ""; } };
  const tem = (p) => !!url && ler(p).includes(url.replace(/^https?:\/\//, ""));
  return [
    { nome: "Claude Code", memoria: tem(".claude.json"), captura: tem(".claude/settings.json") },
    { nome: "Codex", memoria: tem(".codex/config.toml"), captura: tem(".codex/hooks.json") },
    { nome: "Gemini (agy)", memoria: tem(".gemini/config/mcp_config.json"), captura: tem(".gemini/config/hooks.json") },
    { nome: "opencode", memoria: tem(".config/opencode/opencode.json"), captura: tem(".config/opencode/plugins/ai-memory.ts") },
  ];
}
// Os dados do board vivem no Mac: o PRÓPRIO board os espelha no Saturno a cada 30 min (ele tem acesso
// à ~/Documents; o cron do macOS não tem), e o backup da madrugada do Saturno leva ao Drive.
export function copiarBoardProSaturno() {
  execFile("rsync", ["-a", "--delete", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=8", DATA + "/", SERVIDOR + ":backups/board-data/"],
    { timeout: 15 * 60000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ""}` } },
    (e, _o, err) => { INFRA.copiaBoard = { quando: new Date().toISOString(), ok: !e, erro: e ? cut(String(err || e.message), 200) : null }; });
}
// O cofre do Obsidian "Memória" (~/Documents/Memoria): espelho só-leitura do ai-memory do Saturno + memórias
// do Mac, para o dono VER o grafo. Mesmo motivo da cópia acima: quem tem acesso à ~/Documents é o board.
export function atualizarCofreObsidian() {
  execFile(join(process.env.HOME, ".local/bin/memoria-obsidian"), [], { timeout: 5 * 60000 },
    (e) => { INFRA.espelho = { quando: new Date().toISOString(), ok: !e }; grafoCache.em = 0; });
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
        execP("ai-memory", ["status"], 15000, env),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR, "exit"], 8000),
        execP("sh", ["-c", DOCKER_LER], 15000),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR, DOCKER_LER], 20000),
        execP("ssh", ["-o", "ConnectTimeout=4", "-o", "BatchMode=yes", SERVIDOR,
          "cd /var/lib/backup-memoria 2>/dev/null && for f in ULTIMO_*; do printf '%s=%s\\n' \"$f\" \"$(tr -d '\\n' < $f)\"; done"], 10000),
      ]);
      INFRA.docker.mac = lerDocker(dMac, "sem leitura");
      INFRA.docker.saturno = lerDocker(dSat, "Saturno fora do ar");
      const num = (k) => Number((mem.out.match(new RegExp(k + ":\\s*(\\d+)")) || [])[1] || 0);
      const m = mem.out.match(/pages:\s*(\d+)/);
      const url = env.AI_MEMORY_SERVER_URL || null;
      INFRA.aiMemory.online = mem.ok && !!m;
      INFRA.aiMemory.pages = m ? Number(m[1]) : 0;
      INFRA.aiMemory.sessoes = num("sessions"); INFRA.aiMemory.observacoes = num("observations");
      INFRA.aiMemory.url = url;
      INFRA.aiMemory.host = !url ? null : /127\.0\.0\.1|localhost/.test(url) ? "Mac (reserva)" : "Saturno";
      INFRA.aiMemory.motores = motoresDaMemoria(url);
      // Backups: as marcas que o /usr/local/sbin/backup-memoria.sh grava no Saturno.
      const mk = Object.fromEntries(marcas.out.split("\n").filter(Boolean).map((l) => l.split("=")).map(([k, ...v]) => [k, v.join("=")]));
      // Os backups dos bancos (e todos os outros) aparecem no Controle, que lê a lista de data/backups.json.
      INFRA.googleDrive.backups = { memoria: mk.ULTIMO_OK || null, board: mk.ULTIMO_BOARD_OK || null, arquivo: mk.ULTIMO_ARQUIVO || null };
      const datas = [INFRA.googleDrive.backups.memoria, INFRA.googleDrive.backups.board];
      INFRA.googleDrive.lastSync = datas.every(Boolean) ? datas.sort()[0] : null; // o mais velho dos dois
      INFRA.googleDrive.backupEmDia = marcas.ok ? datas.every((d) => d && Date.now() - Date.parse(d) < 26 * 3600000) : null;
      INFRA.saturno.online = sat.ok;
    }
    if (agora - infraLida.drive > 10 * 60000) {
      infraLida.drive = agora;
      const t0 = Date.now();
      const d = await execP("rclone", ["lsd", "gdrive_backup:", "--max-depth", "1", "-v"], 120000);
      const segundos = Math.round((Date.now() - t0) / 1000);
      const cota = /RATE_LIMIT_EXCEEDED|Quota exceeded/i.test(d.err);
      INFRA.googleDrive.online = d.ok;
      INFRA.googleDrive.lento = d.ok && (cota || segundos > 20);
      INFRA.googleDrive.aviso = !d.ok ? "o rclone não conseguiu falar com o Drive"
        : cota ? `respondeu em ${segundos} s: o cliente padrão do rclone estourou a cota por minuto do Google` : null;
    }
    INFRA.timestamp = new Date().toISOString();
  } finally { infraRodando = false; }
}
