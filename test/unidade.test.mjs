// Unit tests: the functions that decide things on their own (verdict, error kind, quota, delivery, attachments,
// memory picking). They import board.mjs from an isolated copy — without server, queue or background routines.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { criarCaixa, envDaCaixa, criarProjeto, limparCaixa, esperar } from "./ajuda.mjs";

const caixa = criarCaixa();
let B;

// A small fake memory: rules of the owner, project facts, a rule of ONE project, an unchecked proposal,
// two near-duplicate pages, an old session and a page nobody addressed yet.
function pagina(projeto, id, { titulo, descricao = "", corpo = "", modificada = "2026-09-20T10:00:00Z", pasta = "" }) {
  const dir = join(caixa.raiz, "memoria", projeto, pasta);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + ".md"), `---\nname: ${id}\ndescription: ${descricao}\nmetadata:\n  modified: '${modificada}'\n---\n\n# ${titulo}\n\n${corpo}\n`);
}
function montarMemoria() {
  pagina("_global", "respostas-curtas", { titulo: "Respostas curtas", descricao: "o dono quer respostas curtas e diretas", corpo: "Veredito primeiro." });
  pagina("_global", "drawer-lateral", { titulo: "Detalhe abre em drawer lateral", descricao: "detalhe de item abre em drawer lateral, nunca em página nova", corpo: "Padrão de tela do dono." });
  pagina("demo", "fix-rejeicao-686", { titulo: "Rejeição 686 do MDF-e", descricao: "a rejeição 686 vinha do encerramento duplicado", corpo: "Corrigido conferindo o encerramento antes de reenviar o MDF-e." });
  pagina("demo", "duvidosa-686", { titulo: "Outra nota sobre rejeição 686", descricao: "rejeição 686 talvez seja outra coisa", corpo: "Palpite não conferido." });
  pagina("outro", "commit-push-main", { titulo: "Commit e push direto na main", descricao: "neste projeto o commit vai direto na main com push", corpo: "Só vale aqui." });
  pagina("demo", "css-redefinida", { titulo: "Classe de CSS redefinida quebra telas", descricao: "redefinir classe global quebra outras telas", corpo: "Use classe nova." });
  const fillers = ["backup do banco roda de madrugada", "o servidor usa nginx na frente", "o cliente paga por boleto ou pix",
    "a landing page tem formulario de contato", "o app android publica pela loja", "a fila de mensagens usa redis"];
  fillers.forEach((f, i) => pagina("demo", "nota-" + i, { titulo: "Nota " + i + " " + f.split(" ")[1], descricao: f, corpo: f + ". Nada mais a dizer sobre isso." }));
  const repetido = "O token do servidor de memoria fica no arquivo de ambiente do usuario e nunca entra no git nem no log do board.";
  pagina("demo", "token-memoria-a", { titulo: "Token da memória", descricao: "onde fica o token", corpo: repetido });
  pagina("demo", "token-memoria-b", { titulo: "Token do servidor de memória", descricao: "onde fica o token", corpo: repetido });
  pagina("demo", "sessao-velha", { titulo: "Sessão de trabalho", pasta: "sessions", modificada: "2026-08-01T10:00:00Z", corpo: "resumo da sessão" });
  pagina("demo", "sem-endereco", { titulo: "Página nova sem mente", descricao: "chegou depois do endereçamento", corpo: "nova" });
  const end = (mente, extra = {}) => ({ mente, confianca: "alta", ...extra });
  const mapa = {
    "_global/respostas-curtas": end("dono"), "_global/drawer-lateral": end("dono"),
    "demo/fix-rejeicao-686": end("engenharia"), "demo/duvidosa-686": end("engenharia", { confianca: "media" }),
    "outro/commit-push-main": end("engenharia", { soNoProjeto: true }), "demo/css-redefinida": end("design"),
    "demo/token-memoria-a": end("engenharia"), "demo/token-memoria-b": end("engenharia"), "demo/sessao-velha": end("engenharia"),
  };
  fillers.forEach((_, i) => (mapa["demo/nota-" + i] = end("engenharia")));
  writeFileSync(join(caixa.board, "data", "mentes.json"), JSON.stringify({ status: "aprovada", mapa, nucleoDono: ["_global/respostas-curtas"], mentePorProjeto: { demo: "engenharia" } }));
}

before(async () => {
  criarProjeto(caixa, "demo");
  montarMemoria();
  // O portão do board roda estes testes DENTRO do board real: nada do board.env dele pode vazar para cá.
  for (const k of Object.keys(process.env)) if (k.startsWith("BOARD_")) delete process.env[k];
  Object.assign(process.env, envDaCaixa(caixa, { BOARD_PRODUCAO: "prod" }));
  B = await import(pathToFileURL(join(caixa.board, "board.mjs")).href);
});
after(() => limparCaixa(caixa));

describe("veredito do revisor e do QA (fail-closed)", () => {
  test("a linha que é só a palavra vale", () => {
    assert.equal(B.lerVeredito("APROVADO\ntudo certo"), "APROVADO");
    assert.equal(B.lerVeredito("**REPROVADO**\n- falta teste"), "REPROVADO");
    assert.equal(B.lerVeredito("> aprovado."), "APROVADO");
  });
  test("frase antes da linha do veredito não engana", () => {
    assert.equal(B.lerVeredito("o revisor anterior tinha APROVADO, mas\nREPROVADO\nquebra X"), "REPROVADO");
  });
  test("sem veredito legível é null (a esteira trata como reprova)", () => {
    for (const t of ["", "parece ok", "aprovadíssimo", null, undefined]) assert.equal(B.lerVeredito(t), null);
  });
});

describe("motivo do erro decide a retentativa", () => {
  const casos = [
    ["You've hit your limit · resets 3pm", "cota"], ["cc_cli_limit_message", "cota"], ["usage limit reached", "cota"],
    ["falhou ao mesclar o PR", "manual"], ["deploy caiu no meio", "manual"], ["não achei a URL do PR para mesclar", "manual"],
    ["tempo esgotado (90 min)", "tempo"], ["o portão reprovou (npm run check)", "portao"],
    ["o revisor reprovou (sem veredito)", "revisor"], ["o QA reprovou (REPROVADO)", "qa"], ["o claude saiu com código 1", "falha"],
  ];
  for (const [msg, tipo] of casos) test(`"${msg}" → ${tipo}`, () => assert.equal(B.classifyError(msg), tipo));
  test("a marca de cota que vem do motor ganha do texto", () => assert.equal(B.classifyError("qualquer coisa", { erroCota: true }), "cota"));
  test("agente que FALA de rate limit no resumo não é cota pela marca do CLI", () => assert.equal(B.classifyError("corrigi o balde por IP"), "falha"));
});

describe("hora em que a cota volta", () => {
  const ref = new Date(2026, 8, 26, 14, 0, 0);
  test("mais tarde hoje", () => { const d = B.parseReset("resets 3pm", ref); assert.equal(d.getHours(), 15); assert.equal(d.getDate(), 26); });
  test("com minutos", () => { const d = B.parseReset("resets at 11:40pm", ref); assert.equal(d.getHours(), 23); assert.equal(d.getMinutes(), 40); });
  test("horário que já passou é amanhã", () => { const d = B.parseReset("resets 9am", ref); assert.equal(d.getDate(), 27); assert.equal(d.getHours(), 9); });
  test("sem horário → null", () => assert.equal(B.parseReset("acabou a cota"), null));
});

describe("modelo só na família do motor", () => {
  test("claude aceita os dele", () => { for (const m of ["claude-opus-5-5", "opus", "sonnet", "haiku"]) assert.ok(B.modeloServe("claude", m), m); });
  test("claude recusa de outra família", () => { for (const m of ["gpt-5-codex", "gemini-3-pro", "google/gemini-3"]) assert.ok(!B.modeloServe("claude", m), m); });
  test("codex recusa claude (o 400 da #127)", () => assert.ok(!B.modeloServe("codex", "claude-opus-5")));
  test("opencode exige provedor/modelo", () => { assert.ok(B.modeloServe("opencode", "google/gemini-3")); assert.ok(!B.modeloServe("opencode", "gemini-3")); });
  test("vazio não serve", () => assert.ok(!B.modeloServe("claude", "")));
});

describe("chat que vira várias tarefas", () => {
  test("todas as linhas com marcador → uma tarefa por linha", () => assert.deepEqual(B.splitTasks("- a\n- b\n1. c"), ["a", "b", "c"]));
  test("texto corrido → uma tarefa", () => assert.deepEqual(B.splitTasks("faça isso:\n- a\n- b"), ["faça isso:\n- a\n- b"]));
  test("uma linha só com marcador → uma tarefa (inteira)", () => assert.deepEqual(B.splitTasks("- sozinha"), ["- sozinha"]));
});

describe("uma tarefa = um PR", () => {
  test("o primeiro PR fica; o segundo vira extra, não troca", () => {
    const t = { id: 999, prUrl: null };
    B.catchPrUrl(t, "abri https://github.com/o/r/pull/7");
    assert.equal(t.prUrl, "https://github.com/o/r/pull/7");
    B.catchPrUrl(t, "e também https://github.com/o/r/pull/8");
    assert.equal(t.prUrl, "https://github.com/o/r/pull/7");
    assert.deepEqual(t.prExtras, ["https://github.com/o/r/pull/8"]);
    B.catchPrUrl(t, "de novo https://github.com/o/r/pull/7");
    assert.deepEqual(t.prExtras, ["https://github.com/o/r/pull/8"]);
  });
});

describe("regras de entrega", () => {
  const proj = () => ({ slug: "demo", dir: join(caixa.dev, "demo") });
  test("direto: sem push e sem PR", () => {
    const r = B.deliveryRules({ id: 1, entrega: "direto" }, proj()).join("\n");
    assert.match(r, /SEM Pull Request/); assert.doesNotMatch(r, /gh pr create/);
  });
  test("PR na pasta principal: atualiza a main antes", () => {
    const r = B.deliveryRules({ id: 1, entrega: "pr" }, proj()).join("\n");
    assert.match(r, /git checkout main && git pull --ff-only/); assert.match(r, /NUNCA MESCLA/);
  });
  test("PR numa CÓPIA: nunca checkout main (a branch pertence à pasta do dono)", () => {
    const r = B.deliveryRules({ id: 1, entrega: "pr" }, { ...proj(), principal: "/outra/pasta" }).join("\n");
    assert.doesNotMatch(r, /git checkout main &&/); assert.match(r, /git checkout -b board\/1-/); assert.match(r, /NÃO volte para main/);
  });
  test("PR já aberto: continua nele e proíbe PR novo", () => {
    const r = B.deliveryRules({ id: 1, entrega: "pr", prUrl: "https://github.com/o/r/pull/7" }, proj()).join("\n");
    assert.match(r, /gh pr checkout https:\/\/github.com\/o\/r\/pull\/7/); assert.match(r, /NUNCA `gh pr create` de novo/);
  });
  test("regras da casa citam os projetos de produção", () => assert.match(B.houseRules({ id: 1, entrega: "direto" }, proj()), /PRODUÇÃO \(prod\)/));
});

describe("portão: o comando de verificação do projeto", () => {
  test("sem configuração, sai do package.json", () => assert.equal(B.gateCommand({ slug: "demo", dir: join(caixa.dev, "demo") }), "npm run check"));
  test("data/portao.json manda; vazio desliga", () => {
    writeFileSync(join(caixa.board, "data", "portao.json"), JSON.stringify({ demo: "make teste", outro: "" }));
    try {
      assert.equal(B.gateCommand({ slug: "demo", dir: join(caixa.dev, "demo") }), "make teste");
      assert.equal(B.gateCommand({ slug: "outro", dir: join(caixa.dev, "demo") }), "");
    } finally { writeFileSync(join(caixa.board, "data", "portao.json"), "{}"); }
  });
  test("pasta sem package.json → sem portão", () => assert.equal(B.gateCommand({ slug: "x", dir: caixa.raiz }), ""));
});

describe("anexos: só o que o board gerou", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  test("PNG e PDF pela assinatura; texto com extensão de imagem não", () => {
    assert.match(B.salvarAnexo(png, "a.png").id, /^[0-9a-f]{16}\.png$/);
    assert.match(B.salvarAnexo(Buffer.from("%PDF-1.7\n..."), "a.pdf").id, /\.pdf$/);
    assert.throws(() => B.salvarAnexo(Buffer.from("não sou imagem"), "falso.png"), /só aceito/);
  });
  test("id inventado, caminho de fora e inexistente são descartados", () => {
    const bom = B.salvarAnexo(png, "ok.png");
    const v = B.anexosValidos([bom, { id: "../../board.json" }, { id: "/etc/passwd" }, { id: "0123456789abcdef.png" }, "nada"]);
    assert.deepEqual(v.map((a) => a.id), [bom.id]);
    assert.ok(v[0].caminho.startsWith(join(caixa.board, "data", "anexos")));
  });
  test("o agente recebe o CAMINHO e a ordem de abrir com Read", () => {
    const bom = B.salvarAnexo(png, "print.png");
    const t = B.comAnexos("olhe o print", [bom]);
    assert.match(t, /ABRA cada um com a ferramenta Read/); assert.ok(t.includes(bom.caminho));
  });
});

describe("a rodada mexeu em arquivo? (pergunta ao disco)", () => {
  test("arquivo novo depois da marca → sim; nada novo → não", async () => {
    const dir = join(caixa.raiz, "mexeu"); mkdirSync(dir, { recursive: true });
    const marca = B.marcarInstante(); await esperar(30);
    assert.equal(B.mexeuEmArquivo(dir, marca), false);
    writeFileSync(join(dir, "novo.txt"), "x");
    assert.equal(B.mexeuEmArquivo(dir, marca), true);
  });
  test("mudança em node_modules e .git não conta", async () => {
    const dir = join(caixa.raiz, "mexeu2"); mkdirSync(join(dir, "node_modules"), { recursive: true }); mkdirSync(join(dir, ".git"), { recursive: true });
    const marca = B.marcarInstante(); await esperar(30);
    writeFileSync(join(dir, "node_modules", "a.js"), "x"); writeFileSync(join(dir, ".git", "index"), "x");
    assert.equal(B.mexeuEmArquivo(dir, marca), false);
  });
});

describe("cota do plano", () => {
  const uso = (l) => ({ ok: true, limites: l });
  test("a janela mais apertada que não é a semanal", () => assert.equal(B.pctDeLimites(uso([{ nome: "sessão", pct: 40 }, { nome: "semana", pct: 90 }])), 40));
  test("só semanal → vale a semanal", () => assert.equal(B.pctDeLimites(uso([{ nome: "semana", pct: 70 }])), 70));
  test("sem cota a partir do teto, ou qualquer janela em 100%", () => {
    assert.ok(B.semCotaDoUso(uso([{ nome: "sessão", pct: 99 }])));
    assert.ok(B.semCotaDoUso(uso([{ nome: "sessão", pct: 10 }, { nome: "semana", pct: 100 }])));
    assert.ok(!B.semCotaDoUso(uso([{ nome: "sessão", pct: 50 }])));
  });
  test("sem leitura não descarta o motor", () => assert.ok(!B.semCotaDoUso(null)));
});

describe("romaneio (o picking da memória)", () => {
  const tarefa = (text, project = "demo") => ({ title: text, text, project });
  test("núcleo do dono vem primeiro, depois a memória do assunto", () => {
    const r = B.montarRomaneio(tarefa("corrigir a rejeição 686 no MDF-e"));
    assert.equal(r.itens[0].chave, "_global/respostas-curtas");
    const daTarefa = r.itens.filter((i) => i.mente !== "dono");
    assert.equal(daTarefa[0].chave, "demo/fix-rejeicao-686");
    assert.match(r.texto, /## Romaneio/);
  });
  test("proposta não conferida (confiança média) não vai", () => {
    const r = B.montarRomaneio(tarefa("corrigir a rejeição 686 no MDF-e"));
    assert.ok(!r.itens.some((i) => i.chave === "demo/duvidosa-686"));
  });
  test("regra de UM projeto não viaja para outro", () => {
    const fora = B.montarRomaneio(tarefa("commit e push direto na main"));
    assert.ok(!fora.itens.some((i) => i.chave === "outro/commit-push-main"));
    const dentro = B.montarRomaneio(tarefa("commit e push direto na main", "outro"));
    assert.ok(dentro.itens.some((i) => i.chave === "outro/commit-push-main"));
  });
  test("regra do dono ligada ao pedido entra além do núcleo", () => {
    const r = B.montarRomaneio(tarefa("mostrar o detalhe da tarefa num drawer lateral"));
    assert.ok(r.itens.some((i) => i.chave === "_global/drawer-lateral"));
  });
  test("memória do mesmo projeto SEM nenhuma palavra do pedido não entra só pelo bônus do projeto", () => {
    const r = B.montarRomaneio(tarefa("corrigir a rejeição 686 no MDF-e"));
    assert.ok(!r.itens.some((i) => /^demo\/nota-/.test(i.chave)), r.itens.map((i) => i.chave).join(", "));
  });
  test("sem endereçamento aprovado, não há romaneio", () => {
    const arq = join(caixa.board, "data", "mentes.json"); const antes = readFileSync(arq, "utf8");
    writeFileSync(arq, JSON.stringify({ ...JSON.parse(antes), status: "proposta" }));
    try { assert.equal(B.montarRomaneio(tarefa("rejeição 686")), null); } finally { writeFileSync(arq, antes); }
  });
});

describe("inventário da memória", () => {
  test("acha a nova sem mente, as repetidas e a sessão velha — sem mexer em nada", () => {
    const inv = B.inventariar();
    assert.ok(inv.novas.some((n) => n.chave === "demo/sem-endereco"));
    assert.ok(inv.repetidas.some((r) => r.chaves.includes("demo/token-memoria-a") && r.chaves.includes("demo/token-memoria-b")));
    assert.ok(inv.vencidas.some((v) => v.chave === "demo/sessao-velha"));
    assert.ok(!inv.repetidas.some((r) => r.chaves.includes("demo/fix-rejeicao-686") && r.chaves.includes("demo/css-redefinida")));
    assert.ok(existsSync(join(caixa.raiz, "memoria", "demo", "token-memoria-b.md")), "inventário não apaga nada sozinho");
  });
});

describe("idade real da memória", () => {
  test("modified ganha; sem data → null", () => {
    assert.equal(B.dataDaMemoria("---\nmetadata:\n  modified: '2026-09-20T10:00:00Z'\n---"), Date.parse("2026-09-20T10:00:00Z"));
    assert.equal(B.dataDaMemoria("# sem data"), null);
  });
  test("tipo pela pasta e pelo type", () => {
    assert.equal(B.tipoDaMemoria("/m/p/decisions/x.md", ""), "decisao");
    assert.equal(B.tipoDaMemoria("/m/p/sessions/x.md", ""), "sessao");
    assert.equal(B.tipoDaMemoria("/m/p/x.md", "  type: feedback\n"), "regra");
  });
});

describe("curva de giro: como a tarefa foi na conferência", () => {
  const t = (status, revisor, qa) => ({ status, revisor, qa });
  const ap = (rodadas = 0) => ({ veredito: "APROVADO", rodadas });
  test("aprovada por revisor e QA sem conserto = de primeira", () => assert.equal(B.resultadoDaConferencia(t("executada", ap(), ap())), "primeira"));
  test("aprovada depois de conserto", () => assert.equal(B.resultadoDaConferencia(t("concluida", ap(1), ap())), "conserto"));
  test("reprovada ou em erro = falhou", () => {
    assert.equal(B.resultadoDaConferencia(t("executada", { veredito: "REPROVADO", rodadas: 1 }, null)), "falhou");
    assert.equal(B.resultadoDaConferencia(t("erro", ap(), null)), "falhou");
  });
  test("executada sem mexer em arquivo = sem conferência; ainda andando não conta", () => {
    assert.equal(B.resultadoDaConferencia(t("executada", null, null)), "semConferencia");
    assert.equal(B.resultadoDaConferencia(t("rodando", null, null)), null);
  });
});
