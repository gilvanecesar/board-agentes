// Controle tests: the night backups as the screen shows them, read from logs in the REAL format of the server's scripts
// (old lines in UTC, new ones with "-0300", a manual run outside the cron window, the memory size on a separate line), the
// Drive listing and the alerts — with the clock frozen, so "last backup more than 26 h ago" doesn't depend on the day.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { criarCaixa, subirBoard, limparCaixa, esperar } from "./ajuda.mjs";

const RELOGIO = join(dirname(fileURLToPath(import.meta.url)), "relogio.mjs");
let atual = [];
afterEach(async () => { for (const f of atual) await f(); atual = []; });

const BACKUPS = [
  { id: "memoria", nome: "Memória", origem: "servidor", log: "/var/log/backup-memoria.log", script: "backup-memoria.sh", ok: "^== (\\S+ \\S+) ok: (\\S+)", falha: "^!! (\\S+ \\S+) FALHOU: (.+)", drive: "backups/memoria", guarda: "30 dias", recuperar: "ai-memory restore <arquivo>" },
  { id: "board", nome: "Dados do board", origem: "servidor", log: "/var/log/backup-memoria.log", script: "backup-memoria.sh", ok: "^== (\\S+ \\S+) board: ok", falha: "^!! (\\S+ \\S+) board: (FALHOU)", drive: "backups/board", guarda: "espelho", recuperar: "rsync" },
  { id: "banco-a", nome: "Banco A", origem: "vps-a", log: "/var/log/backup-banco-a.log", script: "backup-banco-a.sh", ok: "^== (\\S+ \\S+) ok: (\\S+) \\(([^)]+)\\)", falha: "^!! (\\S+ \\S+) (.+)", drive: "backups/banco-a", guarda: "30 dias", recuperar: "pg_restore" },
  { id: "banco-b", nome: "Banco B", origem: "vps-b", log: "/var/log/backup-banco-b.log", script: "backup-banco-b.sh", ok: "^== (\\S+ \\S+) ok: (\\S+) \\(([\\d.,]+\\s?[KMGT]i?B?)", falha: "^!! (\\S+ \\S+) (.+)", drive: "backups/banco-b", guarda: "30 dias", recuperar: "gunzip | psql" },
];
// Real line shapes (memoria: UTC era, then -0300; banco-a: a manual run at 14:03 and the nightly one; banco-b: fails last night).
const SSH = `@@LOG /var/log/backup-memoria.log
== 2026-09-26 03:30:01 início
✓ wrote backup to /var/lib/ai-memory-backups/diarios/memoria-20260926-0330.tar.gz (6.89 MiB)
== 2026-09-26 03:30:06 ok: /var/lib/ai-memory-backups/diarios/memoria-20260926-0330.tar.gz
== 2026-09-26 03:30:08 board: ok
== 2026-09-27 00:30:01-0300 início
✓ wrote backup to /var/lib/ai-memory-backups/diarios/memoria-20260927-0030.tar.gz (9.90 MiB)
== 2026-09-27 00:30:08-0300 ok: /var/lib/ai-memory-backups/diarios/memoria-20260927-0030.tar.gz
== 2026-09-27 00:30:17-0300 board: ok
@@LOG /var/log/backup-banco-a.log
== 2026-09-26 14:03:05-0300 início
Pseudo-terminal will not be allocated because stdin is not a terminal.
== 2026-09-26 14:03:14-0300 ok: banco-a-20260926-1403.dump (4,0M)
== 2026-09-27 01:00:01-0300 início
== 2026-09-27 01:00:09-0300 ok: banco-a-20260927-0100.dump (4,1M)
@@LOG /var/log/backup-banco-b.log
== 2026-09-26 01:30:01-0300 início
== 2026-09-26 01:32:32-0300 ok: banco-b_20260926_030000.sql.gz (1,5G, feito na VPS há 1 h)
== 2026-09-27 01:30:01-0300 início
!! 2026-09-27 01:31:10-0300 o arquivo baixado não passou no gzip -t
@@FUSO
-0300
@@CRON
30 0 * * * root /usr/local/sbin/backup-memoria.sh
0 1 * * * root /usr/local/sbin/backup-banco-a.sh
30 1 * * * root /usr/local/sbin/backup-banco-b.sh
@@DISCO
50000000000 100000000000
`;
const DRIVE = {
  "backups/memoria": [{ Name: "memoria-20260927-0030.tar.gz", Size: 10382352, ModTime: "2026-09-27T03:31:00Z" }],
  "backups/board": [{ Name: "board.json", Size: 700000, ModTime: "2026-09-27T03:31:00Z" }],
  "backups/banco-a": [{ Name: "banco-a-20260926-1403.dump", Size: 4200000, ModTime: "2026-09-26T17:04:00Z" }], // falta o da noite
  "backups/banco-b": [{ Name: "banco-b_20260926_030000.sql.gz", Size: 1600000000, ModTime: "2026-09-26T04:33:00Z" }],
};
const STATUS = "ai-memory status\n  pages: 378\n  sessions: 120\n  observations: 4200\n  last write: 5m ago\n  pending: 3\n";

async function preparar({ agora = "2026-09-27T12:00:00Z", ssh = SSH, drive = DRIVE } = {}) {
  const caixa = criarCaixa();
  writeFileSync(join(caixa.board, "data", "backups.json"), JSON.stringify(BACKUPS));
  if (ssh) writeFileSync(join(caixa.home, "ssh-saida.txt"), ssh);
  if (drive) writeFileSync(join(caixa.home, "rclone.json"), JSON.stringify(drive));
  writeFileSync(join(caixa.home, "ai-memory-status.txt"), STATUS);
  const b = await subirBoard(caixa, { BOARD_RELOGIO: String(Date.parse(agora)), TZ: "America/Sao_Paulo" }, { nodeArgs: ["--import", RELOGIO] });
  atual.push(async () => { await b.fim(); limparCaixa(caixa); });
  let c;
  for (let i = 0; i < 60; i++) { c = (await b.api("GET", "/api/controle")).json; if (c && c.lidoEm && c.driveLidoEm) break; await esperar(250); }
  return { caixa, b, c };
}
const bk = (c, id) => c.backups.find((x) => x.id === id);

test("backups lidos do log real: fuso antigo e novo, tamanho, arquivo e o que foi AUTOMÁTICO", async () => {
  const { c } = await preparar();
  const mem = bk(c, "memoria");
  assert.deepEqual(mem.cronUTC, { h: 3, m: 30 }, "00:30 de Brasília = 03:30 UTC");
  const [velha, nova] = mem.rodadas;
  assert.equal(velha.fim, "2026-09-26T03:30:06.000Z", "linha sem fuso é da época em UTC");
  assert.equal(nova.fim, "2026-09-27T03:30:08.000Z", "linha com -0300 é convertida");
  assert.equal(nova.tamanho, "9.90 MiB", "o tamanho da memória vem da linha 'wrote backup'");
  assert.equal(nova.arquivo, "memoria-20260927-0030.tar.gz");
  assert.ok(velha.automatica && nova.automatica);
  assert.equal(bk(c, "board").rodadas.length, 2);
  const a = bk(c, "banco-a");
  assert.equal(a.rodadas[0].automatica, false, "a das 14:03 foi manual");
  assert.equal(a.rodadas[1].automatica, true, "a das 01:00 foi a do cron");
  assert.equal(a.rodadas[1].tamanho, "4,1M");
  const b2 = bk(c, "banco-b");
  assert.equal(b2.rodadas.at(-1).ok, false);
  assert.match(b2.rodadas.at(-1).motivo, /gzip -t/);
  assert.equal(c.saturno.online, true); assert.equal(c.saturno.discoLivre, 50000000000);
  assert.equal(c.memoria.paginas, 378); assert.equal(c.memoria.filaPendente, 3);
});

test("alertas: falha da noite, arquivo que não chegou ao Drive — e nada de alarme falso", async () => {
  const { c } = await preparar();
  const t = c.alertas.map((x) => x.texto).join("\n");
  assert.match(t, /Banco B: a última rodada falhou — o arquivo baixado não passou no gzip -t/);
  assert.match(t, /Banco A: o arquivo banco-a-20260927-0100\.dump não está no Drive/);
  assert.doesNotMatch(t, /Memória: /, "a memória está em dia e no Drive");
  assert.doesNotMatch(t, /Ainda sem rodada automática/, "todos já tiveram rodada do cron");
  assert.doesNotMatch(t, /Disco do Saturno/, "50% livre não é alarme");
  assert.ok(c.drive.find((p) => p.pasta === "backups/memoria").lista.some((x) => x.nome === "memoria-20260927-0030.tar.gz"));
});

test("três dias sem backup: o alerta diz há quantas horas", async () => {
  const { c } = await preparar({ agora: "2026-09-30T12:00:00Z" });
  assert.match(c.alertas.map((x) => x.texto).join("\n"), /Memória: último backup há 80 h/);
});

test("servidor fora do ar e Drive sem acesso: o Controle diz isso, não finge que está tudo bem", async () => {
  const { c } = await preparar({ ssh: null, drive: null });
  const t = c.alertas.map((x) => x.texto).join("\n");
  assert.equal(c.saturno.online, false);
  assert.match(t, /Saturno não responde/);
  assert.ok(c.drive.every((p) => p.ok === false));
});

import { abrirNavegador, CHROME } from "./navegador.mjs";
test("tela do Controle: selo de cada backup, a faixa dos 14 dias (automático × manual × falhou) e o detalhe", { skip: !CHROME && "sem Chrome" }, async () => {
  const agora = "2026-09-27T12:00:00Z";
  const { b } = await preparar({ agora });
  const nav = await abrirNavegador({ agora: Date.parse(agora) }); atual.push(() => nav.fechar());
  await nav.carregar(b.url + "/?a");
  await nav.avaliar(`localStorage.setItem("board.tab", JSON.stringify("controle"))`);
  await nav.carregar(b.url + "/?b"); await nav.quieto({ min: 600 });
  const ate_ = async (expr) => { for (let i = 0; i < 80; i++) { if (await nav.avaliar(expr)) return; await esperar(120); } throw new Error("não chegou: " + expr); };
  const linha = (id) => nav.avaliar(`(() => { const l = document.querySelector('[data-abre="${id}"]').closest(".ctl-linha"); return { estado: l.dataset.state, texto: l.innerText, dias: [...l.querySelectorAll(".ctl-dia")].map((d) => d.className.replace("ctl-dia ctl-", "")) }; })()`);
  const mem = await linha("memoria"), a = await linha("banco-a"), b2 = await linha("banco-b");
  assert.match(mem.texto, /Em dia/); assert.match(a.texto, /Atenção/, "o arquivo da noite não chegou ao Drive"); assert.match(b2.texto, /Falhou/);
  assert.equal(a.dias.length, 14);
  assert.deepEqual(a.dias.slice(-2), ["manual", "auto"], "26/09 só manual (14:03), 27/09 a do cron");
  assert.deepEqual(b2.dias.slice(-2), ["auto", "falhou"]);
  assert.deepEqual(mem.dias.slice(-2), ["auto", "auto"]);
  const tudo = await nav.avaliar("document.body.innerText");
  assert.match(tudo, /Banco B: a última rodada falhou/);
  await ate_(`(() => { const b = document.querySelector('[data-abre="banco-a"]'); if (!b) return false; b.click(); return true; })()`);
  for (let i = 0; i < 40 && !(await nav.avaliar(`!!document.querySelector(".ctl-det")`)); i++) await esperar(100);
  const det = await nav.avaliar(`document.querySelector(".ctl-det").innerText`);
  assert.match(det, /pg_restore/, "o detalhe traz o comando de recuperar");
  assert.match(det, /banco-a-20260927-0100\.dump/);
  assert.deepEqual(nav.erros, []);
});
