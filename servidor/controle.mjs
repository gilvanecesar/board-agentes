// O menu Controle: backups da madrugada, memória e Drive, com os alertas decididos aqui (não na tela).
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { COM_ROTINAS, DATA, ESPELHO_MEMORIA, SERVIDOR, cut } from "./config.mjs";
import { broadcast } from "./estado.mjs";
import { INFRA, envMemoria, execP, motoresDaMemoria } from "./infra.mjs";
import { inventarioDaMadrugada, lerInventario, montarGrafo } from "./memoria.mjs";

// ── Controle (menu "Controle"): backups, memória e cópias fora das máquinas, num lugar só ─────────────
// O dono pediu (25/09) um lugar para ver se nada se perde. Tudo é LIDO de quem faz o trabalho — os logs e o
// cron do Saturno, o `ai-memory status`, a listagem do Drive, o espelho da memória — e os ALERTAS saem daqui,
// não da tela: a tela não decide o que é problema. Nada aqui escreve em lugar nenhum.
// A lista dos backups que o servidor roda vem de data/backups.json (fora do git: tem endereços e nomes do dono).
// Cada item: {id, nome, origem, log, script, ok, falha, drive, guarda, recuperar} — ok/falha são regex (texto).
export function lerBackups() {
  try { return JSON.parse(readFileSync(join(DATA, "backups.json"), "utf8")).map((b) => ({ ...b, ok: new RegExp(b.ok), falha: new RegExp(b.falha) })); }
  catch { return []; }
}
export const CONTROLE = { lidoEm: null, backups: [], drive: null, driveLidoEm: null, memoria: null, saturno: null, alertas: [] };
export const controleLido = { rapido: 0, drive: 0 };
export let controleRodando = false;
// Hora dos logs do Saturno: as linhas novas trazem o fuso ("2026-09-26 00:30:01-0300"); as antigas, de quando
// o Saturno rodava em UTC (até 26/09/2026), não trazem nada — e aí são UTC.
export const utc = (x) => { const m = x.match(/^(\S+) (\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)?$/);
  return new Date(m ? `${m[1]}T${m[2]}${m[3]}:${m[4] || "00"}` : x.replace(" ", "T") + "Z").toISOString(); };

export function lerRodadas(texto, b, cron) {
  const rodadas = []; let inicio = null, escrito = null;
  for (const l of texto.split("\n")) {
    const i = l.match(/^== (\S+ \S+) início/); if (i) { inicio = utc(i[1]); escrito = null; continue; }
    const w = l.match(/wrote backup to \S+ \(([^)]+)\)/); if (w) { escrito = w[1]; continue; } // tamanho do instantâneo da memória
    let m = l.match(b.ok);
    if (m) { rodadas.push({ ok: true, fim: utc(m[1]), inicio, arquivo: m[2] && m[2] !== "ok" ? m[2].split("/").pop() : null, tamanho: m[3] || (b.id === "memoria" ? escrito : null) }); continue; }
    m = l.match(b.falha);
    if (m && !(b.id === "memoria" && /board:/.test(l))) rodadas.push({ ok: false, fim: utc(m[1]), inicio, motivo: cut(m[2], 160) });
  }
  // Automática = começou no minuto do cron (±10 min). A primeira automática é a prova de que o agendamento vale.
  for (const r of rodadas) {
    const t = new Date(r.inicio || r.fim);
    r.automatica = !!cron && Math.abs((t.getUTCHours() * 60 + t.getUTCMinutes()) - (cron.h * 60 + cron.m)) <= 10;
  }
  return rodadas.slice(-120);
}

export async function lerControle() {
  if (controleRodando) return;
  controleRodando = true;
  try {
    const agora = Date.now();
    if (agora - controleLido.rapido > 60000) {
      controleLido.rapido = agora;
      const env = envMemoria();
      const BACKUPS = lerBackups();
      const logs = [...new Set(BACKUPS.map((b) => b.log))];
      const [sat, mem] = await Promise.all([
        execP("ssh", ["-o", "ConnectTimeout=5", "-o", "BatchMode=yes", SERVIDOR,
          logs.map((f) => `echo "@@LOG ${f}"; tail -n 600 ${f} 2>/dev/null`).join("; ") + '; echo "@@FUSO"; date +%z; echo "@@CRON"; cat /etc/cron.d/backup-* 2>/dev/null; echo "@@DISCO"; df -B1 --output=avail,size /var/lib | tail -1'], 20000),
        execP("ai-memory", ["status"], 15000, env),
      ]);
      if (sat.ok) {
        const partes = {}; let atual = null;
        for (const l of sat.out.split("\n")) { const h = l.match(/^@@(LOG (\S+)|FUSO|CRON|DISCO)/); if (h) { atual = h[2] || h[1]; partes[atual] = ""; continue; } if (atual) partes[atual] += l + "\n"; }
        const cron = {};
        // O cron está no fuso do Saturno; a tela e a conta de "automática" trabalham em UTC.
        const fz = (partes.FUSO || "").trim().match(/^([+-])(\d\d)(\d\d)$/);
        const fusoMin = fz ? (fz[1] === "-" ? -1 : 1) * (+fz[2] * 60 + +fz[3]) : 0;
        for (const l of (partes.CRON || "").split("\n")) {
          const m = l.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*\s+\S+\s+\S*?([\w-]+\.sh)/); if (!m) continue;
          const t = ((+m[2] * 60 + +m[1] - fusoMin) % 1440 + 1440) % 1440;
          cron[m[3]] = { h: Math.floor(t / 60), m: t % 60 };
        }
        CONTROLE.backups = BACKUPS.map((b) => ({
          id: b.id, nome: b.nome, origem: b.origem, drive: b.drive, guarda: b.guarda, recuperar: b.recuperar,
          cronUTC: cron[b.script] || null, rodadas: lerRodadas(partes[b.log] || "", b, cron[b.script]),
        }));
        const [livre, total] = (partes.DISCO || "").trim().split(/\s+/).map(Number);
        CONTROLE.saturno = { online: true, discoLivre: livre || null, discoTotal: total || null };
      } else CONTROLE.saturno = { online: false, erro: cut(sat.err || "sem resposta", 160) };
      const n = (k) => Number((mem.out.match(new RegExp("\\n\\s*" + k + ":\\s*(\\d+)")) || [])[1] || 0);
      const dur = (mem.out.match(/last write:\s*([^\n]+)/) || [])[1] || "";
      const seg = [...dur.matchAll(/(\d+)\s*(d|h|m|s)\b/g)].reduce((a, [, v, u]) => a + v * { d: 86400, h: 3600, m: 60, s: 1 }[u], 0);
      const g = montarGrafo();
      const porProjeto = {};
      const mes = new Date().toISOString().slice(0, 7), hoje = new Date().toLocaleDateString("sv-SE");
      try {
        for (const e of readdirSync(ESPELHO_MEMORIA, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          let t = ""; try { t = readFileSync(join(ESPELHO_MEMORIA, e.name, `log-${mes}.md`), "utf8"); } catch { continue; }
          const ev = [...t.matchAll(/^## \[([^\]]+)\] ([\w-]+)/gm)].map((m) => ({ at: m[1], tipo: m[2] }));
          if (!ev.length) continue;
          const doDia = ev.filter((x) => new Date(x.at).toLocaleDateString("sv-SE") === hoje);
          porProjeto[e.name] = { ultimo: ev[ev.length - 1].at, eventosHoje: doDia.length, pedidosHoje: doDia.filter((x) => x.tipo === "user-prompt").length };
        }
      } catch { /* sem espelho ainda */ }
      CONTROLE.memoria = {
        online: mem.ok && /pages:\s*\d+/.test(mem.out), url: env.AI_MEMORY_SERVER_URL || null,
        reserva: /127\.0\.0\.1|localhost/.test(env.AI_MEMORY_SERVER_URL || ""),
        paginas: n("pages"), sessoes: n("sessions"), observacoes: n("observations"),
        ultimaGravacao: dur && seg >= 0 ? new Date(agora - seg * 1000).toISOString() : null,
        filaPendente: Number((mem.out.match(/pending:\s*(\d+)/) || [])[1] || 0),
        motores: motoresDaMemoria(env.AI_MEMORY_SERVER_URL || null),
        espelho: INFRA.espelho || null,
        // O que foi SALVO: páginas de verdade — o log de captura do mês e o índice mudam a cada evento e taparam o resto.
        recentes: (g.nos || []).filter((x) => x.atualizada && !/^(log-\d{4}-\d{2}|index)$/.test(x.id)).sort((a, b) => b.atualizada.localeCompare(a.atualizada)).slice(0, 25)
          .map((x) => ({ chave: x.chave, titulo: x.titulo, projeto: x.projeto, atualizada: x.atualizada, sessao: x.sessao })),
        captura: Object.entries(porProjeto).map(([projeto, v]) => ({ projeto, ...v })).sort((a, b) => b.ultimo.localeCompare(a.ultimo)),
      };
      CONTROLE.copiaBoard = INFRA.copiaBoard || null;
    }
    if (agora - controleLido.drive > 10 * 60000) {
      controleLido.drive = agora;
      const pastas = await Promise.all(lerBackups().map(async (b) => {
        if (b.id === "board") {
          const r = await execP("rclone", ["size", "--json", "gdrive_backup:" + b.drive], 120000);
          try { const j = JSON.parse(r.out); return { pasta: b.drive, ok: r.ok, arquivos: j.count, bytes: j.bytes, lista: [] }; } catch { return { pasta: b.drive, ok: false, erro: cut(r.err, 160) }; }
        }
        const r = await execP("rclone", ["lsjson", "gdrive_backup:" + b.drive], 120000);
        try {
          const l = JSON.parse(r.out).filter((x) => !x.IsDir).map((x) => ({ nome: x.Name, bytes: x.Size, quando: x.ModTime })).sort((a, b2) => b2.nome.localeCompare(a.nome));
          return { pasta: b.drive, ok: true, arquivos: l.length, bytes: l.reduce((a, x) => a + x.bytes, 0), lista: l.slice(0, 20) };
        } catch { return { pasta: b.drive, ok: false, erro: cut(r.err || "sem resposta", 160) }; }
      }));
      CONTROLE.drive = pastas; CONTROLE.driveLidoEm = new Date().toISOString();
    }
    CONTROLE.alertas = alertasDoControle();
    CONTROLE.lidoEm = new Date().toISOString();
    broadcast("controle", { lidoEm: CONTROLE.lidoEm });
  } finally { controleRodando = false; }
}

export function alertasDoControle() {
  const a = []; const h = (iso) => iso ? (Date.now() - Date.parse(iso)) / 3600000 : Infinity;
  const semAutomatica = [];
  if (CONTROLE.saturno && !CONTROLE.saturno.online) a.push({ nivel: "erro", texto: "Saturno não responde: não dá para ler os backups." });
  for (const b of CONTROLE.backups) {
    const oks = b.rodadas.filter((r) => r.ok), ultOk = oks[oks.length - 1], ult = b.rodadas[b.rodadas.length - 1];
    if (!ultOk) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: nenhum backup concluído ainda.` });
    else if (ult && !ult.ok) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: a última rodada falhou — ${ult.motivo}.` });
    else if (h(ultOk.fim) > 26) a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: último backup há ${Math.round(h(ultOk.fim))} h (o normal é todo dia).` });
    if (ultOk && b.cronUTC && !b.rodadas.some((r) => r.ok && r.automatica)) semAutomatica.push(b.nome);
    const pasta = (CONTROLE.drive || []).find((p) => p.pasta === b.drive);
    if (ultOk && ultOk.arquivo && pasta && pasta.ok && pasta.lista.length && !pasta.lista.some((x) => x.nome === ultOk.arquivo))
      a.push({ nivel: "erro", backup: b.id, texto: `${b.nome}: o arquivo ${ultOk.arquivo} não está no Drive.` });
    if (pasta && !pasta.ok) a.push({ nivel: "aviso", backup: b.id, texto: `Drive: não consegui listar ${b.drive}.` });
  }
  // Um aviso só: a prova de que o AGENDAMENTO vale é a primeira rodada sozinha, na madrugada.
  if (semAutomatica.length) a.push({ nivel: "aviso", texto: `Ainda sem rodada automática (só as manuais de teste): ${semAutomatica.join(", ")}. A primeira é na próxima madrugada.` });
  const m = CONTROLE.memoria;
  if (m) {
    if (!m.online) a.push({ nivel: "erro", texto: "A memória compartilhada não responde." });
    if (m.reserva) a.push({ nivel: "aviso", texto: "Reserva ligada: os motores estão usando a memória do Mac, não a do Saturno." });
    const fora = (m.motores || []).filter((x) => !(x.memoria && x.captura));
    if (fora.length) a.push({ nivel: "erro", texto: "Motor sem memória ou sem captura: " + fora.map((x) => x.nome).join(", ") + "." });
    if (m.filaPendente > 200) a.push({ nivel: "aviso", texto: `${m.filaPendente} capturas esperando para subir à memória.` });
    if (m.espelho ? h(m.espelho.quando) > 0.5 : process.uptime() > 900) a.push({ nivel: "aviso", texto: "O espelho da memória (Obsidian e o grafo) está desatualizado." });
  }
  const inv = lerInventario();
  if (inv && inv.em) {
    const n = (inv.novas || []).length + (inv.repetidas || []).length + (inv.vencidas || []).length;
    if (n) a.push({ nivel: "aviso", texto: `Inventário da memória: ${n} para conferir (${(inv.novas || []).length} novas, ${(inv.repetidas || []).length} suspeitas de repetição, ${(inv.vencidas || []).length} vencidas) — menu Memória → Galpão.` });
  }
  const c = CONTROLE.copiaBoard;
  if (c && (c.ok === false || (c.quando ? h(c.quando) > 2 : process.uptime() > 2400))) a.push({ nivel: "aviso", texto: "A cópia do board para o Saturno " + (c.ok === false ? "falhou." : "está atrasada.") });
  const s = CONTROLE.saturno;
  if (s && s.discoTotal && s.discoLivre / s.discoTotal < 0.1) a.push({ nivel: "erro", texto: "Disco do Saturno com menos de 10% livre." });
  return a;
}
if (COM_ROTINAS) {
  setInterval(inventarioDaMadrugada, 10 * 60000);
  setTimeout(lerControle, 20000);
  setInterval(lerControle, 60000);
}
