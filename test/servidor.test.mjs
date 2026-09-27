// Integration tests, part 2: the parts of the server the first suite left out — ⚡ copies and the merge back into the
// owner's folder, the per-project conversation, task chat, "turn into PR", merge-and-publish locks, automatic retry,
// queue order, restart, and the Controle/Status readings. Same sandbox and fake CLIs as board.test.mjs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, chamadas, limparCaixa, esperar } from "./ajuda.mjs";

let atual = [];
afterEach(async () => { for (const [b, c] of atual) { await b.fim(); limparCaixa(c); } atual = []; });

async function preparar({ cenario = {}, env = {}, projetos = ["demo"], antes } = {}) {
  const caixa = criarCaixa();
  for (const p of projetos) criarProjeto(caixa, p);
  caixa.cenario(cenario);
  if (antes) antes(caixa);
  const b = await subirBoard(caixa, env);
  atual.push([b, caixa]);
  return { caixa, b, demo: join(caixa.dev, "demo") };
}
const criar = async (b, text, extra = {}) => (await b.api("POST", "/api/tasks", { text, project: "demo", queue: true, ...extra })).json.tasks;
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
const arg = (c, f) => { const i = c.args.indexOf(f); return i >= 0 ? c.args[i + 1] : undefined; };
async function ate(fn, limite = 15000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(200); } return v; }

test("⚡ em paralelo: trabalha numa cópia e, aprovado, junta na pasta — sem apagar o que o dono tinha sem commit", async () => {
  const { caixa, b, demo } = await preparar({ cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "novo.txt", conteudo: "do agente\n" } }] } });
  writeFileSync(join(demo, "rascunho-do-dono.txt"), "não mexa\n");
  const [t] = await criar(b, "crie novo.txt", { paralelo: true });
  await esperarStatus(b, t.id, "executada");
  const ag = chamadas(caixa).find((c) => c.papel === "agente");
  assert.match(ag.cwd, /\/\.board-agentes\/demo-/, "o agente trabalhou na cópia");
  const fim = await ate(async () => { const x = await tarefa(b, t.id); return x.worktree?.juntar === "ok" && x; });
  assert.ok(fim, "a junção aconteceu");
  assert.equal(readFileSync(join(demo, "novo.txt"), "utf8"), "do agente\n");
  assert.equal(readFileSync(join(demo, "rascunho-do-dono.txt"), "utf8"), "não mexa\n");
  assert.equal(execFileSync("git", ["-C", demo, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n").length, 1, "junção não commita");
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "concluida" });
  assert.ok(!existsSync(fim.worktree.dir), "concluir remove a cópia");
});

test("⚡ com conflito: nada entra na pasta, a cópia fica guardada e a ficha avisa", async () => {
  const { caixa, b, demo } = await preparar({ cenario: { agente: [{ texto: "fiz", dorme: 1500, escreve: { arquivo: "CLAUDE.md", conteudo: "# versão do agente\n" } }] } });
  const [t] = await criar(b, "mude o CLAUDE.md", { paralelo: true });
  await ate(async () => chamadas(caixa).length > 0);
  writeFileSync(join(demo, "CLAUDE.md"), "# versão do dono, escrita enquanto o agente trabalhava\n");
  await esperarStatus(b, t.id, "executada");
  const fim = await ate(async () => { const x = await tarefa(b, t.id); return x.worktree?.juntar === "conflito" && x; });
  assert.ok(fim, "a junção detectou o conflito");
  assert.equal(readFileSync(join(demo, "CLAUDE.md"), "utf8"), "# versão do dono, escrita enquanto o agente trabalhava\n");
  assert.ok(existsSync(join(fim.worktree.dir, "CLAUDE.md")), "o trabalho continua na cópia");
  assert.ok((await log(b, t.id)).some((e) => /não deu para juntar/.test(e.texto || "")));
  await b.api("PATCH", `/api/tasks/${t.id}`, { status: "concluida" });
  assert.ok(existsSync(fim.worktree.dir), "com conflito, concluir NÃO apaga a cópia (o trabalho só existe lá)");
});

test("conversa por projeto: um processo vivo para o fio, custo por mensagem, e 'novo fio' esquece tudo", async () => {
  const { caixa, b } = await preparar({ cenario: { conversa: ["primeira resposta", "segunda resposta"] } });
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "oi" })).status, 202);
  await ate(async () => (await b.api("GET", "/api/conversa/demo")).json.events.some((e) => e.t === "resultado"));
  await ate(async () => !(await b.api("GET", "/api/conversa/demo")).json.busy);
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "e agora?" })).status, 202);
  const c = await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.filter((e) => e.t === "resultado").length === 2 && !x.busy && x; });
  assert.deepEqual(c.events.filter((e) => e.t === "resultado").map((e) => e.texto), ["primeira resposta", "segunda resposta"]);
  assert.deepEqual(c.events.filter((e) => e.t === "dono").map((e) => e.texto), ["oi", "e agora?"]);
  assert.equal(readFileSync(join(caixa.home, "processos-conversa"), "utf8"), "1", "as duas mensagens foram para o MESMO processo");
  assert.equal(c.custo, 0.04, "custo acumulado do processo vira custo por mensagem (0,02 + 0,02)");
  const st = (await b.api("GET", "/api/state")).json;
  assert.equal(st.tasks.length, 0, "conversa não vira tarefa");
  await b.api("POST", "/api/conversa/demo/limpar");
  const limpo = (await b.api("GET", "/api/conversa/demo")).json;
  assert.equal(limpo.events.length, 0);
  assert.equal((await b.api("GET", "/api/state")).json.conversas.demo.temSessao, false);
  assert.equal((await b.api("POST", "/api/conversa/nao-existe", { texto: "oi" })).status, 202);
  assert.ok(await ate(async () => (await b.api("GET", "/api/conversa/nao-existe")).json.events.some((e) => /não conheço o projeto/.test(e.texto || ""))));
});

test("conversa com tarefa rodando na mesma pasta: as regras mandam só ler", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "ok", dorme: 4000 }], conversa: ["li"] } });
  const [t] = await criar(b, "tarefa longa");
  await ate(async () => chamadas(caixa).some((c) => c.papel === "agente"));
  await b.api("POST", "/api/conversa/demo", { texto: "o que está acontecendo?" });
  const c = await ate(async () => chamadas(caixa).find((x) => x.papel === "conversa"));
  assert.match(arg(c, "--append-system-prompt"), /Há uma TAREFA RODANDO nesta mesma pasta/);
  await esperarStatus(b, t.id, "executada");
});

test("chat da tarefa: continua a MESMA sessão do agente", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: ["primeira", "respondi o chat"] } });
  const [t] = await criar(b, "pergunta");
  const fim = await esperarStatus(b, t.id, "executada");
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/chat`, { text: "e o detalhe?" })).status, 202);
  await ate(async () => chamadas(caixa).filter((c) => c.papel === "agente").length === 2 && !(await tarefa(b, t.id)).busy);
  const segunda = chamadas(caixa).filter((c) => c.papel === "agente")[1];
  assert.equal(arg(segunda, "--resume"), fim.sessionId);
  assert.equal(arg(segunda, "-p"), "e o detalhe?");
  assert.ok((await log(b, t.id)).some((e) => e.t === "dono" && e.texto === "e o detalhe?"));
});

test("virar PR depois: confere (portão/revisor/QA) e entrega na mesma sessão", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, "PR: https://github.com/o/demo/pull/9"], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "faça a.txt");
  const antes = await esperarStatus(b, t.id, "executada");
  assert.equal((await b.api("POST", `/api/tasks/${t.id}/pr`)).status, 202);
  const fim = await ate(async () => { const x = await tarefa(b, t.id); return x.prUrl && x.status === "executada" && !x.busy && x; });
  assert.equal(fim.prUrl, "https://github.com/o/demo/pull/9");
  const ag = chamadas(caixa).filter((c) => c.papel === "agente");
  assert.match(arg(ag[1], "-p"), /Sua única função agora é ENTREGAR por Pull Request/);
  assert.equal(arg(ag[1], "--resume"), antes.sessionId);
});

test("mesclar e publicar: sem comando declarado, não mescla", async () => {
  const { b, caixa } = await preparar({ cenario: { agente: [{ texto: "PR https://github.com/o/demo/pull/3", escreve: { arquivo: "a.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "publique", { entrega: "deploy" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /não tem comando de publicação declarado/);
  assert.ok(!existsSync(join(caixa.home, "gh.log")) || !readFileSync(join(caixa.home, "gh.log"), "utf8").includes("pr merge"));
});

test("mesclar e publicar: com comando declarado, mescla e publica; se o merge falha, NÃO publica", async () => {
  const deploy = (caixa) => writeFileSync(join(caixa.board, "data", "deploy.json"), JSON.stringify({ demo: "touch publicado.txt" }));
  const cen = { agente: [{ texto: "PR https://github.com/o/demo/pull/3", escreve: { arquivo: "a.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] };
  const { b, demo } = await preparar({ cenario: cen, antes: deploy });
  const [t] = await criar(b, "publique", { entrega: "deploy" });
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.ok(fim.merged && fim.deploy?.ok);
  assert.ok(existsSync(join(demo, "publicado.txt")));
  // merge recusado
  const r2 = await preparar({ cenario: cen, antes: (c) => { deploy(c); writeFileSync(join(c.home, "gh-merge-falha"), "1"); } });
  const [t2] = await criar(r2.b, "publique", { entrega: "deploy" });
  const f2 = await esperarStatus(r2.b, t2.id, ["executada", "erro"]);
  assert.equal(f2.status, "erro");
  assert.match(f2.error, /não consegui mesclar/);
  assert.ok(!existsSync(join(r2.demo, "publicado.txt")), "merge falhou → a publicação não roda");
  assert.ok((await log(r2.b, t2.id)).some((e) => e.t === "retentativa" && e.estado === "manual"), "mesclar/publicar nunca repete sozinho");
});

test("retentativa: erro de processo volta pra fila sozinho e continua a MESMA sessão", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" },
    cenario: { agente: [{ texto: "", erro: true, codigo: 1 }, "terminei"] } });
  const [t] = await criar(b, "faça");
  const fim = await esperarStatus(b, t.id, "executada", 20000);
  const ag = chamadas(caixa).filter((c) => c.papel === "agente");
  assert.equal(ag.length, 2);
  assert.equal(arg(ag[1], "--resume"), fim.sessionId);
  assert.match(arg(ag[1], "-p"), /Continue de onde parou/);
  assert.equal(fim.tentativas, 0, "deu certo: a conta zera");
});

test("a ordem do quadro é a ordem da fila", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: ["ok"] } });
  await b.api("POST", "/api/fila/pausar");
  const [a] = await criar(b, "primeira criada");
  const [c] = await criar(b, "segunda criada");
  await b.api("POST", "/api/tasks/reorder", { ids: [c.id, a.id] });
  await b.api("POST", "/api/fila/retomar");
  await esperarStatus(b, a.id, "executada"); await esperarStatus(b, c.id, "executada");
  const prompts = chamadas(caixa).filter((x) => x.papel === "agente").map((x) => arg(x, "-p"));
  assert.deepEqual(prompts, ["segunda criada", "primeira criada"]);
});

test("reiniciar com nada rodando: o servidor sai com código 75 (o board.sh sobe de novo)", async () => {
  const { b } = await preparar();
  const saiu = new Promise((ok) => b.cp.on("exit", ok));
  const r = await b.api("POST", "/api/reiniciar");
  assert.equal(r.json.agora, true);
  assert.equal(await saiu, 75);
});

test("Controle e Status respondem mesmo com servidor, Drive e docker fora do ar — e dizem isso", async () => {
  const { b } = await preparar({ antes: (c) => writeFileSync(join(c.board, "data", "backups.json"), JSON.stringify([
    { id: "banco", nome: "Banco de teste", origem: "vps", log: "/var/log/b.log", script: "/x.sh", ok: "OK", falha: "ERRO", drive: "backups/banco", guarda: 7, recuperar: "gunzip" }])) });
  const ctl = await ate(async () => { const x = (await b.api("GET", "/api/controle")).json; return x && (x.alertas || x.backups) && x; });
  assert.ok(ctl, "o Controle respondeu");
  const mon = (await b.api("GET", "/api/monitoring")).json;
  assert.ok(mon && "aiMemory" in mon && "googleDrive" in mon && "docker" in mon);
  const mon2 = await ate(async () => { const x = (await b.api("GET", "/api/monitoring")).json; return x.timestamp && x; });
  assert.ok(mon2, "a leitura de fundo terminou");
  assert.notEqual(mon2.saturno.online, true, "servidor fora do ar não aparece como online");
});

test("sobe com as rotinas de fundo ligadas (como no dia a dia) sem erro de carregamento", async () => {
  const { b } = await preparar({ env: { BOARD_SEM_ROTINAS: "0" } });
  await esperar(4000); // leituras de fundo (infra, controle, uso) já dispararam
  assert.equal((await b.api("GET", "/api/state")).status, 200);
  assert.equal((await b.api("GET", "/api/controle")).status, 200);
  assert.doesNotMatch(b.saida(), /ReferenceError|TypeError|SyntaxError|Cannot access .* before initialization/);
});
