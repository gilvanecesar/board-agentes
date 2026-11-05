// ⚡ junção de volta na pasta principal (26/10, a #203): quando o `git apply` recusa, a mescla de três vias arquivo por
// arquivo com o portão rodando no RESULTADO antes de tocar na pasta; e, se mesmo assim não der, a tarefa vira
// "não juntada — conflito" na tela toda (caso real: a #200 ficou na cópia marcada como executada e ninguém viu).
// 27/10 (a #208, vendo a #205 "não juntada"): arquivo IGUAL na pasta não é conflito; conflito volta para o PRÓPRIO
// agente resolver na cópia (até BOARD_JUNTAR_TENTATIVAS); e trabalho aplicado à mão na pasta encerra o conflito sozinho.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { criarCaixa, criarProjeto, subirBoard, esperarStatus, chamadas, limparCaixa, esperar } from "./ajuda.mjs";
import { abrirNavegador, CHROME } from "./navegador.mjs";

let atual = [];
afterEach(async () => { for (const [b, c, nav] of atual) { if (nav) await nav.fechar(); await b.fim(); limparCaixa(c); } atual = []; });

const LINHAS = Array.from({ length: 10 }, (_, i) => `linha ${i + 1}`);
const texto = (troca = {}) => LINHAS.map((l, i) => troca[i + 1] ?? l).join("\n") + "\n";

/** Projeto "demo" com lista.txt de 10 linhas no commit; `check` = o portão do projeto. */
async function preparar({ check, agente, env = { BOARD_JUNTAR_TENTATIVAS: "0" }, cenario }) {
  const caixa = criarCaixa();
  const demo = criarProjeto(caixa, "demo", check ? { check } : {});
  writeFileSync(join(demo, "lista.txt"), texto());
  execFileSync("git", ["-C", demo, "add", "-A"]);
  execFileSync("git", ["-C", demo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "lista"]);
  caixa.cenario(cenario || { agente: [{ texto: "fiz", dorme: 1500, escreve: { arquivo: "lista.txt", conteudo: agente } }] });
  const b = await subirBoard(caixa, env);
  const item = [b, caixa, null]; atual.push(item);
  return { caixa, b, demo, item };
}
const tarefa = async (b, id) => (await b.api("GET", `/api/tasks/${id}`)).json.task;
const log = async (b, id) => (await b.api("GET", `/api/tasks/${id}/log`)).json.events;
async function ate(fn, limite = 20000) { const t0 = Date.now(); let v; while (Date.now() - t0 < limite) { v = await fn(); if (v) return v; await esperar(200); } return v; }

/** Roda uma tarefa ⚡ e, enquanto o agente trabalha na cópia, o dono muda a linha 5 na pasta principal. */
async function rodarComDonoMexendo({ b, caixa, demo }, mexe = () => writeFileSync(join(demo, "lista.txt"), texto({ 5: "linha 5 do DONO" }))) {
  const [t] = (await b.api("POST", "/api/tasks", { text: "mude a linha 7", project: "demo", queue: true, paralelo: true })).json.tasks;
  await ate(async () => chamadas(caixa).length > 0);
  mexe();
  await esperarStatus(b, t.id, "executada");
  return t;
}

test("⚡ junção simples recusou (linhas vizinhas): a de três vias mescla, roda o portão no resultado e junta", async () => {
  const ctx = await preparar({ agente: texto({ 7: "linha 7 do AGENTE" }) });
  const t = await rodarComDonoMexendo(ctx);
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return ["ok", "conflito"].includes(x.worktree?.juntar) && x; });
  assert.equal(fim.worktree.juntar, "ok", "três vias juntou: " + JSON.stringify(fim.worktree.conflito));
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 5: "linha 5 do DONO", 7: "linha 7 do AGENTE" }), "as duas mudanças na pasta");
  const evs = (await log(ctx.b, t.id)).map((e) => e.texto || "");
  assert.ok(evs.some((x) => /junção simples recusou/.test(x)), "conta que a simples recusou");
  assert.ok(evs.some((x) => /juntou por três vias.*portão verde no resultado/.test(x)), "e que o portão rodou no resultado");
  assert.ok(!existsSync(join(ctx.caixa.dev, ".board-agentes", `demo-${t.id}-juntando`)), "a cópia temporária do portão some");
  assert.equal(execFileSync("git", ["-C", ctx.demo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length, 2, "só a pasta e a cópia da tarefa");
  assert.equal(execFileSync("git", ["-C", ctx.demo, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n").length, 2, "junção não commita");
});

test("⚡ mescla limpa mas portão VERMELHO no resultado (sem tentativas do agente): nada entra na pasta, vira 'não juntada — conflito' e tentar de novo volta a conferir", async () => {
  // O portão só quebra com as DUAS mudanças juntas: na cópia (só a do agente) ele passa; no resultado, não.
  const check = `node -e "const s=require('fs').readFileSync('lista.txt','utf8');process.exit(s.includes('DONO')&&s.includes('AGENTE')?1:0)"`;
  const ctx = await preparar({ check, agente: texto({ 7: "linha 7 do AGENTE" }) });
  const t = await rodarComDonoMexendo(ctx);
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return x.worktree?.juntar === "conflito" && x; });
  assert.ok(fim, "virou conflito");
  assert.match(fim.worktree.conflito.motivo, /portão ficou vermelho/);
  assert.deepEqual(fim.worktree.conflito.arquivos, ["lista.txt"]);
  assert.ok(fim.worktree.conflito.portao.comando, "guarda o comando do portão");
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 5: "linha 5 do DONO" }), "a pasta do dono ficou como estava");
  assert.ok(existsSync(fim.worktree.dir), "o trabalho continua na cópia");
  assert.ok((await log(ctx.b, t.id)).some((e) => /não deu para juntar.*portão ficou vermelho/.test(e.texto || "")), "aviso na linha do tempo");
  // Tentar de novo: só com conflito; volta a conferir (e, com o portão ainda vermelho, cai em conflito outra vez).
  assert.equal((await ctx.b.api("POST", `/api/tasks/${t.id}/juntar`)).status, 202);
  assert.equal((await ctx.b.api("POST", `/api/tasks/${t.id}/juntar`)).status, 409, "pedir de novo com a junção já na fila é recusado");
  const de2 = await ate(async () => { const evs = await log(ctx.b, t.id); return evs.filter((e) => /não deu para juntar/.test(e.texto || "")).length >= 2 && evs; });
  assert.ok(de2, "conferiu de novo");
  // O dono resolve: tira a mudança dele da pasta → a junção simples entra.
  writeFileSync(join(ctx.demo, "lista.txt"), texto());
  await ate(async () => (await tarefa(ctx.b, t.id)).worktree?.juntar === "conflito");
  assert.equal((await ctx.b.api("POST", `/api/tasks/${t.id}/juntar`)).status, 202);
  assert.ok(await ate(async () => (await tarefa(ctx.b, t.id)).worktree?.juntar === "ok"), "juntou depois de resolvido");
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 7: "linha 7 do AGENTE" }));
});

test("⚡ mesma linha dos dois lados, sem tentativas (BOARD_JUNTAR_TENTATIVAS=0): três vias recusa, lista o arquivo e não escreve marcador na pasta", async () => {
  const ctx = await preparar({ agente: texto({ 5: "linha 5 do AGENTE" }) });
  const t = await rodarComDonoMexendo(ctx);
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return x.worktree?.juntar === "conflito" && x; });
  assert.ok(fim);
  assert.match(fim.worktree.conflito.motivo, /mesmos trechos/);
  assert.deepEqual(fim.worktree.conflito.arquivos, ["lista.txt"]);
  assert.ok(!/<<<<<<<|>>>>>>>/.test(readFileSync(join(ctx.demo, "lista.txt"), "utf8")), "sem marcador de conflito na pasta");
  assert.equal((await ctx.b.api("GET", "/api/tasks/999/juntar")).status, 404);
});

test("tela: 'não juntada — conflito' em Ativas (não em Executadas), faixa no Meu quadro, na Central e na ficha com 'tentar de novo'",
  { skip: !CHROME && "sem Chrome nesta máquina" }, async () => {
    const ctx = await preparar({ agente: texto({ 5: "linha 5 do AGENTE" }) });
    const t = await rodarComDonoMexendo(ctx);
    assert.ok(await ate(async () => (await tarefa(ctx.b, t.id)).worktree?.juntar === "conflito"));
    const nav = await abrirNavegador(); ctx.item[2] = nav;
    const ver = async (expr, limite = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < limite) { if (await nav.avaliar(expr)) return true; await esperar(150); } throw new Error("não chegou: " + expr); };
    await nav.carregar(ctx.b.url + "/");
    await nav.avaliar(`localStorage.setItem("board.tab", '"ativas"'); localStorage.setItem("board.visao", '"lista"')`); // "em Ativas": a aba da ☰ Lista
    await nav.carregar(ctx.b.url + "/?r=" + Math.random());
    await ver(`!!document.querySelector('.faixa-naojuntada a[href="#/t/${t.id}"]')`);
    await ver(`(() => { const r = document.querySelector('.task[data-id="${t.id}"]'); return !!r && /Não juntada — conflito/.test(r.querySelector('.pill').textContent) && r.classList.contains('naojuntada'); })()`);
    await nav.avaliar(`document.querySelector('.tab[data-tab="executadas"]').click()`);
    await ver(`!document.querySelector('.task[data-id="${t.id}"]')`);
    await nav.avaliar(`location.hash = "#/central"`);
    await ver(`!!document.querySelector('.cl-naojuntada a[href="#/t/${t.id}"]')`);
    await nav.avaliar(`location.hash = "#/t/${t.id}"`);
    await ver(`!!document.querySelector('.aviso-naojuntada') && /lista\\.txt/.test(document.querySelector('.aviso-naojuntada').textContent)`);
    await nav.avaliar(`[...document.querySelectorAll('.aviso-naojuntada button')].find((b) => /juntar de novo/.test(b.textContent)).click()`);
    assert.ok(await ate(async () => (await log(ctx.b, t.id)).some((e) => /pediu para tentar juntar de novo/.test(e.texto || ""))), "o botão pediu a junção");
    assert.deepEqual(nav.erros, [], "sem erro de JS");
  });

const NOVO = "arquivo novo da outra tarefa\n";

test("⚡ arquivo novo que a pasta já tem IGUAL (caso da #205) não é conflito: aceita, mescla o resto e junta", async () => {
  const ctx = await preparar({ cenario: { agente: [{ texto: "fiz", dorme: 1500, escreve: [
    { arquivo: "lista.txt", conteudo: texto({ 7: "linha 7 do AGENTE" }) }, { arquivo: "novo.mjs", conteudo: NOVO }] }] } });
  // Outra tarefa (ou o dono) deixou o MESMO arquivo novo na pasta, sem commit: o `git apply` recusa ("already exists").
  const t = await rodarComDonoMexendo(ctx, () => writeFileSync(join(ctx.demo, "novo.mjs"), NOVO));
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return ["ok", "conflito"].includes(x.worktree?.juntar) && x; });
  assert.equal(fim.worktree.juntar, "ok", "juntou: " + JSON.stringify(fim.worktree.conflito));
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 7: "linha 7 do AGENTE" }));
  assert.equal(readFileSync(join(ctx.demo, "novo.mjs"), "utf8"), NOVO);
  assert.ok((await log(ctx.b, t.id)).some((e) => /1 arquivo\(s\) já estavam IGUAIS na pasta \(aceitos: novo\.mjs\)/.test(e.texto || "")), "conta que aceitou o igual");
});

test("⚡ tudo o que a cópia mudou já está IGUAL na pasta: juntada sem rodar portão (a #205 caía no portão vermelho da pasta)", async () => {
  // O portão fica vermelho com a marca do dono (arquivo novo sem commit, criado depois que a cópia partiu): na cópia ele
  // passa; se a junção rodasse o portão no resultado — que leva os arquivos novos da pasta —, viraria conflito.
  const ctx = await preparar({ check: `node -e "process.exit(require('fs').existsSync('marca-do-dono.txt')?1:0)"`,
    cenario: { agente: [{ texto: "fiz", dorme: 1500, escreve: { arquivo: "novo.mjs", conteudo: NOVO } }] } });
  const t = await rodarComDonoMexendo(ctx, () => { writeFileSync(join(ctx.demo, "novo.mjs"), NOVO); writeFileSync(join(ctx.demo, "marca-do-dono.txt"), "x\n"); });
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return ["ok", "conflito"].includes(x.worktree?.juntar) && x; });
  assert.equal(fim.worktree.juntar, "ok", JSON.stringify(fim.worktree.conflito));
  const evs = (await log(ctx.b, t.id)).map((e) => e.texto || "");
  assert.ok(evs.some((x) => /já estava na pasta principal/.test(x)), "diz que já estava lá");
  assert.ok(!evs.some((x) => /rodando o portão no resultado/.test(x)), "sem portão: nada a aplicar");
});

test("⚡ conflito na junção volta para o PRÓPRIO agente: a cópia recebe a pasta atual com marcadores, ele resolve, a esteira roda de novo e junta", async () => {
  const resolvido = texto({ 5: "linha 5 do DONO e do AGENTE" });
  const ctx = await preparar({ env: {}, cenario: { agente: [
    { quando: "A JUNÇÃO do seu trabalho", texto: "resolvi o conflito", escreve: { arquivo: "lista.txt", conteudo: resolvido } },
    { texto: "fiz", dorme: 1500, escreve: { arquivo: "lista.txt", conteudo: texto({ 5: "linha 5 do AGENTE" }) } }] } });
  const t = await rodarComDonoMexendo(ctx);
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return ["ok", "conflito"].includes(x.worktree?.juntar) && x.status === "executada" && x; }, 40000);
  assert.equal(fim.worktree.juntar, "ok", "juntou depois do conserto: " + JSON.stringify(fim.worktree.conflito));
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), resolvido, "a pasta tem a resolução do agente");
  // O pedido de conserto: rodou NA CÓPIA, na mesma sessão, falando do arquivo com marcadores.
  const agentes = chamadas(ctx.caixa).filter((c) => c.papel === "agente");
  assert.equal(agentes.length, 2, "1 rodada da tarefa + 1 de conserto");
  const pedido = agentes[1].args[agentes[1].args.indexOf("-p") + 1];
  assert.match(pedido, /MARCADORES de conflito .*lista\.txt/);
  assert.match(pedido, /tentativa 1 de 2/);
  assert.ok(agentes[1].args.includes("--resume"), "retoma a sessão do agente");
  assert.equal(agentes[1].cwd, fim.worktree.dir, "trabalha na cópia");
  // A esteira inteira rodou de novo (revisor e QA duas vezes) e o HEAD da cópia é o estado da pasta.
  assert.equal(chamadas(ctx.caixa).filter((c) => c.papel === "revisor").length, 2);
  assert.equal(chamadas(ctx.caixa).filter((c) => c.papel === "qa").length, 2);
  assert.equal(execFileSync("git", ["-C", fim.worktree.dir, "show", "HEAD:lista.txt"], { encoding: "utf8" }), texto({ 5: "linha 5 do DONO" }));
  const evs = (await log(ctx.b, t.id)).map((e) => e.texto || e.titulo || "");
  assert.ok(evs.some((x) => /devolveu a tarefa a #eng\d+ para resolver \(tentativa 1 de 2\)/.test(x)));
  assert.ok(!evs.some((x) => /não deu para juntar/.test(x)), "não parou no dono");
  assert.equal(execFileSync("git", ["-C", ctx.demo, "log", "--oneline"], { encoding: "utf8" }).trim().split("\n").length, 2, "a pasta do dono não ganhou commit");
});

test("⚡ agente que não tira os marcadores: nada com marcador entra na pasta e, esgotadas as tentativas, vira 'não juntada' com aviso", async () => {
  const ctx = await preparar({ env: { BOARD_JUNTAR_TENTATIVAS: "1" }, cenario: { agente: [
    { quando: "A JUNÇÃO do seu trabalho", texto: "olhei e não mexi" },
    { texto: "fiz", dorme: 1500, escreve: { arquivo: "lista.txt", conteudo: texto({ 5: "linha 5 do AGENTE" }) } }] } });
  const t = await rodarComDonoMexendo(ctx);
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return x.worktree?.juntar === "conflito" && x; }, 40000);
  assert.ok(fim, "virou não juntada");
  assert.match(fim.worktree.conflito.motivo, /marcadores de conflito/);
  assert.equal(fim.worktree.conflito.esgotou, 1);
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 5: "linha 5 do DONO" }), "a pasta do dono ficou como estava, sem marcador");
  assert.ok((await log(ctx.b, t.id)).some((e) => /já tentou resolver 1x sozinho — precisa de você/.test(e.texto || "")));
});

test("⚡ 'não juntada' que o dono aplicou à mão na pasta: o board percebe e limpa o conflito sozinho, sem o botão", async () => {
  const ctx = await preparar({ agente: texto({ 5: "linha 5 do AGENTE" }), env: { BOARD_JUNTAR_TENTATIVAS: "0", BOARD_JUNTAR_CONFERIR_S: "1" } });
  const t = await rodarComDonoMexendo(ctx);
  assert.ok(await ate(async () => (await tarefa(ctx.b, t.id)).worktree?.juntar === "conflito"), "virou conflito");
  await esperar(2500);
  assert.equal((await tarefa(ctx.b, t.id)).worktree.juntar, "conflito", "sem a mudança na pasta, continua em conflito");
  writeFileSync(join(ctx.demo, "lista.txt"), texto({ 5: "linha 5 do AGENTE" })); // o dono resolveu à mão
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return x.worktree?.juntar === "ok" && x; });
  assert.ok(fim, "o conflito saiu sozinho");
  assert.equal(fim.worktree.conflito, null);
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 5: "linha 5 do AGENTE" }), "o board não mexeu na pasta");
  assert.ok((await log(ctx.b, t.id)).some((e) => /aplicado à mão.*se resolveu sozinho/.test(e.texto || "")));
});

test("⚡ portão no resultado leva os arquivos NOVOS sem commit da pasta (a #205: publicar.mjs fora → board não subia → conflito falso)", async () => {
  // O resultado (DONO + AGENTE) só passa no portão com o modulo.txt que o dono criou na pasta, sem commit, durante a tarefa.
  const check = `node -e "const fs=require('fs');process.exit(fs.readFileSync('lista.txt','utf8').includes('DONO')&&!fs.existsSync('modulo.txt')?1:0)"`;
  const ctx = await preparar({ check, agente: texto({ 7: "linha 7 do AGENTE" }) });
  const t = await rodarComDonoMexendo(ctx, () => { writeFileSync(join(ctx.demo, "lista.txt"), texto({ 5: "linha 5 do DONO" })); writeFileSync(join(ctx.demo, "modulo.txt"), "do dono\n"); });
  const fim = await ate(async () => { const x = await tarefa(ctx.b, t.id); return ["ok", "conflito"].includes(x.worktree?.juntar) && x; });
  assert.equal(fim.worktree.juntar, "ok", "portão verde no resultado: " + JSON.stringify(fim.worktree.conflito));
  assert.equal(readFileSync(join(ctx.demo, "lista.txt"), "utf8"), texto({ 5: "linha 5 do DONO", 7: "linha 7 do AGENTE" }));
  assert.ok((await log(ctx.b, t.id)).some((e) => /juntou por três vias.*portão verde no resultado/.test(e.texto || "")));
  assert.equal(execFileSync("git", ["-C", ctx.demo, "status", "--porcelain", "modulo.txt"], { encoding: "utf8" }).trim(), "?? modulo.txt", "o arquivo do dono segue não rastreado, intocado");
});

test("⚡ a cópia nasce com os arquivos NOVOS sem commit da pasta (o código rastreado pode depender deles)", async () => {
  const caixa = criarCaixa();
  const demo = criarProjeto(caixa, "demo", { check: `node -e "process.exit(require('fs').existsSync('solto.txt')?0:1)"` });
  writeFileSync(join(demo, "solto.txt"), "novo, sem commit\n");
  caixa.cenario({ agente: [{ texto: "fiz", escreve: { arquivo: "feito.txt", conteudo: "ok\n" } }] });
  const b = await subirBoard(caixa, { BOARD_JUNTAR_TENTATIVAS: "0" }); atual.push([b, caixa, null]);
  const [t] = (await b.api("POST", "/api/tasks", { text: "faça", project: "demo", queue: true, paralelo: true })).json.tasks;
  const fim = await ate(async () => { const x = await tarefa(b, t.id); return (x.worktree?.juntar === "ok" || x.status === "erro") && x; }, 30000);
  assert.equal(fim.status, "executada", "o portão da cópia achou o solto.txt: " + (fim.error || ""));
  assert.equal(readFileSync(join(fim.worktree.dir, "solto.txt"), "utf8"), "novo, sem commit\n");
  assert.equal(readFileSync(join(demo, "feito.txt"), "utf8"), "ok\n", "juntou só o trabalho do agente");
  assert.equal(execFileSync("git", ["-C", demo, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).sort().join("|"), "?? feito.txt|?? solto.txt", "índice do dono intocado, nada commitado");
});
