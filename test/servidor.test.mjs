// Integration tests, part 2: the parts of the server the first suite left out — ⚡ copies and the merge back into the
// owner's folder, the per-project conversation, task chat, "turn into PR", merge-and-publish locks, automatic retry,
// queue order, restart, and the Controle/Status readings. Same sandbox and fake CLIs as board.test.mjs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("⚡ com conflito (e sem tentativas do agente): nada entra na pasta, a cópia fica guardada e a ficha avisa", async () => {
  // Desde a #208 o conflito volta primeiro para o agente (test/juntar.test.mjs); aqui, o caminho de quando elas acabam.
  const { caixa, b, demo } = await preparar({ env: { BOARD_JUNTAR_TENTATIVAS: "0" }, cenario: { agente: [{ texto: "fiz", dorme: 1500, escreve: { arquivo: "CLAUDE.md", conteudo: "# versão do agente\n" } }] } });
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

test("conversa: escrever com a resposta no meio não trava — as mensagens esperam a vez e vão juntas, na ordem", async () => {
  const { caixa, b } = await preparar({ cenario: { conversa: [{ texto: "primeira resposta", dorme: 2000 }, "respondi as duas"] } });
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "oi" })).status, 202);
  await ate(async () => chamadas(caixa).some((c) => c.papel === "conversa"));
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "esqueci de dizer A" })).status, 202, "com a resposta no meio, aceita");
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "e B" })).status, 202);
  const meio = (await b.api("GET", "/api/state")).json.conversas.demo;
  assert.equal(meio.busy, true);
  assert.equal(meio.naVez, 2, "a tela sabe quantas esperam");
  const naTela = (await b.api("GET", "/api/conversa/demo")).json.events.filter((e) => e.t === "dono");
  assert.deepEqual(naTela.map((e) => [e.texto, !!e.naVez]), [["oi", false], ["esqueci de dizer A", true], ["e B", true]], "aparecem na hora, marcadas");
  const c = await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.filter((e) => e.t === "resultado").length === 2 && !x.busy && x; });
  const conv = chamadas(caixa).filter((x) => x.papel === "conversa");
  assert.equal(conv.length, 2, "as duas que esperaram viraram UM turno");
  assert.match(conv[1].msg, /1\. esqueci de dizer A[\s\S]*2\. e B/, "na ordem em que o dono escreveu");
  assert.doesNotMatch(conv[1].msg, /\[Contexto\]/, "não repete as mesmas mensagens como contexto");
  assert.equal(readFileSync(join(caixa.home, "processos-conversa"), "utf8"), "1", "mesmo processo vivo");
  assert.deepEqual(c.events.filter((e) => e.t === "dono").map((e) => e.texto), ["oi", "esqueci de dizer A", "e B"], "não grava de novo ao entregar");
  assert.equal(c.naVez, 0);
});

test("conversa: cada resposta ganha número do board (R1, R2…) e responder a uma leva a citação ao agente", async () => {
  const { caixa, b } = await preparar({ cenario: { conversa: ["primeira resposta, sobre o rate limit", "segunda", "respondi sobre R1"] } });
  for (const texto of ["oi", "e agora?"]) {
    const antes = (await b.api("GET", "/api/conversa/demo")).json.events.filter((e) => e.t === "resultado").length;
    assert.equal((await b.api("POST", "/api/conversa/demo", { texto })).status, 202);
    await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.filter((e) => e.t === "resultado").length > antes && !x.busy; });
  }
  assert.deepEqual((await b.api("GET", "/api/conversa/demo")).json.events.filter((e) => e.t === "resultado").map((e) => e.n), [1, 2], "o número é do board, na ordem");
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "x", cita: 9 })).status, 400, "número que não existe no fio é recusado");
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "x", cita: "abc" })).status, 400);
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "pode detalhar?", cita: 1 })).status, 202);
  const c = await ate(async () => { const x = (await b.api("GET", "/api/conversa/demo")).json; return x.events.filter((e) => e.t === "resultado").length === 3 && !x.busy && x; });
  const msg = chamadas(caixa).filter((x) => x.papel === "conversa").at(-1).msg;
  assert.match(msg, /Sobre R1 \(sua resposta que começava assim: "primeira resposta, sobre o rate limit"\):\npode detalhar\?/, "o agente recebe a citação com o trecho");
  const dono = c.events.filter((e) => e.t === "dono").at(-1);
  assert.equal(dono.texto, "pode detalhar?", "no log fica o texto como o dono escreveu");
  assert.deepEqual(dono.cita, { n: 1, trecho: "primeira resposta, sobre o rate limit" }, "e a citação ao lado, para a tela");
  assert.equal(c.events.filter((e) => e.t === "resultado").at(-1).n, 3);
  await b.api("POST", "/api/conversa/demo/limpar");
  assert.equal((await b.api("POST", "/api/conversa/demo", { texto: "x", cita: 1 })).status, 400, "novo fio recomeça a contagem");
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

test("conversa trabalha como o terminal (modo auto, MCPs liberados); a tarefa continua com a lista fechada", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: ["ok"], conversa: ["ok"] } });
  const [t] = await criar(b, "tarefa");
  await esperarStatus(b, t.id, "executada");
  await b.api("POST", "/api/conversa/demo", { texto: "oi" });
  const c = await ate(async () => chamadas(caixa).find((x) => x.papel === "conversa"));
  assert.equal(arg(c, "--permission-mode"), "auto", "com acceptEdits + lista, todo MCP fora dela era negado em silêncio");
  assert.match(arg(c, "--append-system-prompt"), /MESMAS ferramentas do terminal/);
  const a = chamadas(caixa).find((x) => x.papel === "agente");
  assert.equal(arg(a, "--permission-mode"), "acceptEdits", "a tarefa (sem o dono olhando) NÃO ganha o modo auto");
  assert.ok(c.args.includes("--chrome"), "sem --chrome o claude -p não enxerga a extensão do Chrome");
  assert.match(arg(c, "--append-system-prompt"), /Chrome DELE/);
  assert.ok(!a.args.includes("--chrome"), "tarefa NÃO usa o Chrome do dono");
});

test("conversa: BOARD_CONVERSA_PERMISSAO e BOARD_CONVERSA_CHROME trocam sem mexer em código", async () => {
  const { caixa, b } = await preparar({ cenario: { conversa: ["ok"] }, env: { BOARD_CONVERSA_PERMISSAO: "acceptEdits", BOARD_CONVERSA_CHROME: "0" } });
  await b.api("POST", "/api/conversa/demo", { texto: "oi" });
  const c = await ate(async () => chamadas(caixa).find((x) => x.papel === "conversa"));
  assert.equal(arg(c, "--permission-mode"), "acceptEdits");
  assert.ok(!c.args.includes("--chrome"));
  assert.doesNotMatch(arg(c, "--append-system-prompt"), /Chrome DELE/);
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
  assert.notEqual(mon2.atena.online, true, "servidor fora do ar não aparece como online");
});

test("board NO servidor (BOARD_SERVIDOR=local, #239): lê o servidor sem ssh, não lê o Mac e a memória local não vira 'reserva'", async () => {
  // O ssh da caixa recusa tudo: só lendo localmente o servidor aparece no ar.
  const { b } = await preparar({ env: { BOARD_SERVIDOR: "local" }, antes: (c) => writeFileSync(join(c.home, ".ai-memory-env.sh"),
    'export AI_MEMORY_SERVER_URL="http://127.0.0.1:1"\n') });
  const mon = await ate(async () => { const x = (await b.api("GET", "/api/monitoring")).json; return x.timestamp && x; });
  assert.ok(mon, "a leitura de fundo terminou");
  assert.equal(mon.atena.online, true, "o próprio servidor está no ar sem ssh para si mesmo");
  assert.match(mon.docker.mac.motivo, /roda no servidor/, "o Mac não é lido daqui");
  assert.equal(mon.aiMemory.host, "Atena", "127.0.0.1 no servidor é o próprio servidor, não a reserva do Mac");
  assert.equal((await b.api("GET", "/api/controle")).status, 200);
});

test("sobe com as rotinas de fundo ligadas (como no dia a dia) sem erro de carregamento", async () => {
  const { b } = await preparar({ env: { BOARD_SEM_ROTINAS: "0" } });
  await esperar(4000); // leituras de fundo (infra, controle, uso) já dispararam
  assert.equal((await b.api("GET", "/api/state")).status, 200);
  assert.equal((await b.api("GET", "/api/controle")).status, 200);
  assert.doesNotMatch(b.saida(), /ReferenceError|TypeError|SyntaxError|Cannot access .* before initialization/);
});

test("barrado por permissão e nada mudou: para na hora, sem conferência e SEM retentativa — e diz o que foi barrado", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_RETENTATIVAS: "2", BOARD_RETENTATIVA_MIN: "0.02" },
    cenario: { agente: [{ texto: "não consegui editar: o arquivo é protegido", negado: "src/carrinho.js" }] } });
  const [t] = await criar(b, "mude o carrinho");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "erro");
  assert.match(fim.error, /bloqueado por permissão \(Edit .*src\/carrinho\.js\) — precisa de você/);
  await esperar(2500); // tempo de sobra para uma retentativa (1,2 s) acontecer, se fosse acontecer
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente"], "nem revisor, nem QA, nem outra rodada");
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "retentativa" && e.estado === "manual" && /barrado por permissão/.test(e.texto)));
  assert.equal((await tarefa(b, t.id)).status, "erro");
});

test("barrado numa ferramenta mas o agente contornou e entregou: segue a esteira, com o aviso na linha do tempo", async () => {
  const { caixa, b } = await preparar({ cenario: { agente: [{ texto: "fiz por outro caminho", negado: "src/x.js", escreve: { arquivo: "ok.txt" } }], revisor: ["APROVADO"], qa: ["APROVADO"] } });
  const [t] = await criar(b, "faça");
  const fim = await esperarStatus(b, t.id, ["executada", "erro"]);
  assert.equal(fim.status, "executada", fim.error);
  assert.deepEqual(chamadas(caixa).map((c) => c.papel), ["agente", "revisor", "qa"]);
  assert.ok((await log(b, t.id)).some((e) => /a permissão barrou: Edit/.test(e.texto || "")));
});


test("conserto feito, portão cortado por tempo, e na volta nada a mudar: a conferência roda de novo (não é 'defeito de pé') — a #188", async () => {
  const cont = join(tmpdir(), "portao-188-" + process.pid);
  const { caixa, b } = await preparar({ env: { BOARD_PORTAO_TIMEOUT_MIN: "0.03", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" },
    cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, { texto: "consertei", escreve: { arquivo: "b.txt" } }, "nada a mudar: o conserto já está feito"],
      qa: ["REPROVADO\na trava deixa passar preço escrito por extenso", "APROVADO"] },
    antes: (c) => writeFileSync(join(c.dev, "demo", "package.json"), JSON.stringify({ name: "demo", scripts: {
      check: `bash -c 'n=$(cat ${cont} 2>/dev/null || echo 0); echo $((n+1)) > ${cont}; if [ "$n" = 1 ]; then sleep 30; fi; true'` } })) });
  const [t] = await criar(b, "faça");
  const fim = await esperarStatus(b, t.id, ["executada"], 30000);
  assert.equal(fim.status, "executada", fim.error);
  const ev = await log(b, t.id);
  assert.ok(ev.some((e) => e.t === "fim" && /passou de 0.03 min e foi interrompido.*não é teste falhando/.test(e.texto || e.motivo || JSON.stringify(e))), "o corte por tempo é dito como corte, não como teste falhando");
  assert.ok(ev.some((e) => /o conserto já foi feito antes — a conferência roda de novo/.test(e.texto || "")));
  assert.deepEqual(chamadas(caixa).filter((c) => c.papel === "qa").length, 2, "o QA confere de novo e aprova");
  assert.equal(chamadas(caixa).filter((c) => c.papel === "agente").length, 2 + 1, "não houve rodada de 'conserte o portão' por causa do corte");
});

test("reprovado e nada mudou desde a reprovação: continua erro (o defeito está de pé)", async () => {
  const { caixa, b } = await preparar({ env: { BOARD_REVISOES: "0", BOARD_RETENTATIVAS: "1", BOARD_RETENTATIVA_MIN: "0.02" },
    cenario: { agente: [{ texto: "fiz", escreve: { arquivo: "a.txt" } }, "acho que está certo"], qa: ["REPROVADO\ndefeito"] } });
  const [t] = await criar(b, "faça");
  for (let i = 0; i < 100 && chamadas(caixa).filter((c) => c.papel === "agente").length < 2; i++) await esperar(150);
  const fim = await esperarStatus(b, t.id, ["erro"], 20000);
  await esperar(500);
  const f2 = await tarefa(b, t.id);
  assert.match(f2.error, /não mexeu em nada — o defeito continua de pé/);
  assert.equal(chamadas(caixa).filter((c) => c.papel === "qa").length, 1, "sem mudança, não confere de novo");
});
