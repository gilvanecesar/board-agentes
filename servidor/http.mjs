// O servidor HTTP: as rotas da tela e da CLI, o SSE e a busca de tarefas.
import { createServer } from "http";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { buscar, indexar, estadoBusca } from "../busca.mjs";
import { ANEXOS, C, MODEL, MOTOR_PADRAO, MOTOR_QA, MOTOR_REVISOR, PARALLEL, PAUSE_FLAG, PERMISSION, PER_PROJECT, QA_LIGADO, QA_MODEL, RETRY_MAX, REVIEW_MODEL, REVIEW_ROUNDS, REVISOR_LIGADO, ROOT, STARTED_AT, WEB, cut, filaPausada, now } from "./config.mjs";
import { broadcast, clients, logEvent, logPath, readLog, running, save, state, taskById, titleOf } from "./estado.mjs";
import { criarProjetoNovo, listProjects, projectOf, projetosVisiveis, rotuloDoProjeto, rotularTexto, rotulosDosProjetos } from "./projetos.mjs";
import { tentarJuntarDeNovo } from "./juntar.mjs";
import { listarPrs, mesclarPr } from "./prs.mjs";
import { listarPublicar, logIdPublicar, projetosPublicaveis, publicar, statusPublicar } from "./publicar.mjs";
import { INFRA, atualizarCofreObsidian, escreverNaMemoria, execP, lerInfra } from "./infra.mjs";
import { apagarDaMemoria, caminhoNoProjeto, gravarInventario, gravarMentes, inventariar, lerInventario, lerMentes, mentePorProjeto, mentesDef, giroDaMemoria, montarGrafo, montarRomaneio, pistasDaMente, resumoMentes, semAcentoServidor, sentidoDoPedido, tiraCabecalhos } from "./memoria.mjs";
import { CONTROLE, lerControle } from "./controle.mjs";
import { MOTORES, catalogoModelos, motoresDisponiveis, temBin } from "./motores.mjs";
import { chatTask, deployCommand, gateCommand } from "./esteira.mjs";
import { conversaDe, conversaId, falarNaConversa, matarVivo, naVez, respostaNumero } from "./conversa.mjs";
import { CENTRAL, listarSessoes, NOME_CENTRAL, TETO_ESPONTANEOS } from "./central.mjs";
import { conferirAprovacao, refereDe, registrarAprovacao } from "./aprovacoes.mjs";
import { TRANSCRICOES } from "./ditado.mjs";
import { pedirReinicio, restartPending, stopTask } from "./fila.mjs";
import { createTasks, removeTask, reorder, resolverProjeto, updateTask } from "./tarefas.mjs";
import { lerUsos, passarBastao, usage } from "./uso.mjs";
import { ID_ANEXO, TIPOS_ANEXO, anexosValidos, lerBinario, salvarAnexo } from "./anexos.mjs";
import { transcrever } from "./ditado.mjs";
import { rotaNavegador } from "./navegador.mjs";
import { listarSessoesTerminal, rotaSessoes } from "./sessoes.mjs";
import { rotaAgentesTmux } from "./agentes-tmux.mjs";
import { rotaGhostty } from "./ghostty.mjs";
import { rotaVoz } from "./voz.mjs";
import { ligarTela, rotaTela } from "./tela.mjs";
import { daTela } from "./origem.mjs";
import { abandonarPedido, historico, lerRegras, listarPendentes, pedirPermissao, responderPermissao, tirarRegra } from "./permissoes.mjs";

// ── busca semântica (a aba 🔎 Buscar) ─────────────────────────────────────────
/**
 * O quadro é de TODOS os projetos e já passou de uma centena de tarefas: achar "aquela do rate
 * limit" pelo título exato não funciona. A busca compara o SENTIDO da pergunta com o de cada
 * tarefa (título + descrição) — ver `busca.mjs`, que também escolhe o provedor e, quando ele
 * não responde, cai sozinho na procura por palavra.
 *
 * O histórico mora onde mora tudo aqui: `data/logs/busca.jsonl`, escrito por `logEvent` — assim
 * a tela lê com o mesmo `/api/busca/historico` e o terminal imprime a consulta junto do resto.
 */
export const BUSCA_LOG = "busca";
export const BUSCA_ESTADO_TTL = 60000;
export let buscaEstadoCache = null;

export async function estadoDaBusca({ fresco = false } = {}) {
  if (!fresco && buscaEstadoCache && Date.now() - buscaEstadoCache.t < BUSCA_ESTADO_TTL) return buscaEstadoCache.v;
  const v = await estadoBusca(state.tasks);
  buscaEstadoCache = { t: Date.now(), v };
  return v;
}

export async function buscarTarefas(consulta, { projeto = null, limite = 20 } = {}) {
  const r = await buscar(consulta, state.tasks, { projeto, limite });
  if (r.modo !== "vazio") {
    logEvent(BUSCA_LOG, { t: "busca", consulta: r.consulta, modo: r.modo, provedor: r.provedor, projeto: projeto || "todos",
      ms: r.ms, aviso: r.aviso, achados: r.resultados.slice(0, 5).map((x) => ({ id: x.id, title: x.title, score: x.score })) });
    buscaEstadoCache = null; // a busca acabou de pôr o índice em dia: a próxima leitura conta certo
  }
  return r;
}

// #249: erro vira toast na tela — o nome do projeto sai pelo rótulo, nunca pelo slug da pasta ("acme" → "CRM").
export const json = (res, code, body) => { if (code >= 400 && body && typeof body.error === "string") body = { ...body, error: rotularTexto(body.error) }; res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
export const readBody = (req) => new Promise((ok, bad) => {
  let b = ""; req.on("data", (d) => { b += d; if (b.length > 1e6) bad(new Error("corpo grande demais")); });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error("JSON inválido")); } });
});

/**
 * O estado que a TELA precisa — sem o texto e o resumo inteiros de cada tarefa. A lista mostra
 * título, status e selos; quem quer o texto todo é a tela da tarefa, que já busca `/tasks/:id/log`.
 * Medido em 18/09: 289 KB por atualização com 84 tarefas, 214 KB só de texto+resumo, e a tela
 * redesenhava tudo a cada evento. (`?tudo=1` devolve o completo, para quem precisar.)
 */
export const magro = (t) => {
  const { text, result, ...resto } = t;
  return { ...resto, anexos: (t.anexos || []).map((a) => ({ id: a.id, nome: a.nome })) };
};
export const publicState = (completo = false) => ({
  tasks: state.tasks.map((t) => (completo ? { ...t } : magro(t))),
  projects: projetosVisiveis().map(({ slug, label }) => ({ slug, label })), // a SELEÇÃO da tela (data/projetos.json)
  rotulos: rotulosDosProjetos(), // #249: o nome de TODO projeto na tela (o slug da pasta nunca aparece)
  config: { parallel: PARALLEL, perProject: PER_PROJECT, model: MODEL || "(padrão do CLI)", permission: PERMISSION,
    motor: MOTOR_PADRAO, motorRevisor: MOTOR_REVISOR, motorQa: MOTOR_QA,
    revisor: REVIEW_MODEL, revisorLigado: REVISOR_LIGADO, qa: QA_MODEL, qaLigado: QA_LIGADO, rodadas: REVIEW_ROUNDS, reinicioPendente: restartPending, iniciadoEm: STARTED_AT, filaPausada: filaPausada(),
    retentativas: RETRY_MAX, pausaAte: state.pausaAte && state.pausaAte > Date.now() ? new Date(state.pausaAte).toISOString() : null },
  motores: motoresDisponiveis(),
  // Só o cabeçalho de cada fio (o histórico vem por /api/conversa/<slug>), pra não engordar o SSE.
  conversas: Object.fromEntries(Object.entries(state.conversas || {}).map(([slug, c]) => [slug,
    { busy: !!c.busy, ouvindo: !!c.ouvindo, naVez: c.busy ? c.naVez || 0 : 0, motor: c.motor || null, modelo: c.modelo || null, temSessao: !!c.sessionId, custo: c.custo || 0, updatedAt: c.updatedAt }])),
  portoes: Object.fromEntries(listProjects().map((p) => [p.slug, gateCommand(p)])),
  deploys: Object.fromEntries(listProjects().map((p) => [p.slug, deployCommand(p)])),
  publicaveis: projetosPublicaveis(), // 🚀 Publicar (data/publicar.json): só com o clique do dono
});

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  try {
    if (req.method === "GET" && (path === "/" || path.startsWith("/#"))) {
      // no-cache + ETag: the browser always revalidates, so an edit to index.html shows up on a
      // plain F5 (without it, an open tab kept the old renderer — 24/09); unchanged → 304, no body.
      const html = readFileSync(WEB);
      const etag = `"${createHash("sha1").update(html).digest("hex")}"`;
      const headers = { "cache-control": "no-cache", etag };
      const inm = req.headers["if-none-match"];
      if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      return res.end(html);
    }
    // O estilo e os scripts da tela (web/estilo.css, web/js/*.js): mesma regra do index — sempre revalida, 304 se não mudou.
    // Só nome simples com .css/.js dentro de web/: nada de caminho vindo do cliente.
    const estatico = req.method === "GET" && path.match(/^\/((?:js\/)?[a-z0-9-]+\.(css|js))$/);
    if (estatico) {
      const arq = join(ROOT, "web", estatico[1]);
      if (!existsSync(arq)) return json(res, 404, { error: "rota não existe" });
      const corpo = readFileSync(arq);
      const etag = `"${createHash("sha1").update(corpo).digest("hex")}"`;
      const headers = { "cache-control": "no-cache", etag };
      const inm = req.headers["if-none-match"];
      if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, { "content-type": (estatico[2] === "css" ? "text/css" : "text/javascript") + "; charset=utf-8", ...headers });
      return res.end(corpo);
    }
    if (req.method === "GET" && path === "/api/state") return json(res, 200, publicState(url.searchParams.has("tudo")));
    // O navegador dos agentes (#217): abrir, ler, clicar, preencher, subir arquivo… com aprovação por ação de risco.
    if (path === "/api/navegador" || path.startsWith("/api/navegador/")) return rotaNavegador(req, res, url, { json, readBody });
    // 🖥 Sessões (#233): o terminal de cada sessão do Claude que roda no tmux — ver ao vivo e mandar teclas, só localhost.
    if (path === "/api/sessoes" || path.startsWith("/api/sessoes/")) return rotaSessoes(req, res, url, { json, readBody });
    if ((path === "/api/tela" || path.startsWith("/api/tela/")) && await rotaTela(req, res, url, { json, readBody })) return; // `board tela` (#293)
    // O 🖥 "ver no tmux": Terminal no Mac, a sessão board-agentes na tela numa máquina sem tela (#248).
    if (path === "/api/agentes/tmux" || path.startsWith("/api/agentes/tmux/")) return rotaAgentesTmux(req, res, url, { json });
    // 🖥 ver no tmux → Ghostty (#352): a sessão do tmux numa janela do Ghostty do Mac, pelo clique do dono.
    if (path === "/api/ghostty" || path.startsWith("/api/ghostty/")) return rotaGhostty(req, res, url, { json, readBody });
    if (path.startsWith("/api/voz/")) return await rotaVoz(req, res, url, { json, readBody }); // 🎙 modo voz da Central (#286)
    // Pedidos de permissão das sessões (#232): a ferramenta do CLI pede e ESPERA; só a tela responde.
    if (req.method === "POST" && path === "/api/permissoes/pedido") {
      const b = await readBody(req);
      const p = pedirPermissao(b);
      // A ferramenta caiu (o agente parou, o processo morreu): o cartão não pode ficar esperando um clique que não leva a nada.
      if (p.id) res.on("close", () => { if (!res.writableEnded) abandonarPedido(p.id, "a sessão que pediu não está mais esperando (parou ou caiu)"); });
      return json(res, 200, await p);
    }
    if (req.method === "GET" && path === "/api/permissoes") return json(res, 200, { pendentes: listarPendentes(), regras: lerRegras().regras, historico: historico(Number(url.searchParams.get("n")) || 50) });
    const perm = path.match(/^\/api\/permissoes\/([0-9a-f]{12}|regras)$/);
    if (perm && req.method === "POST") {
      // Mesma barreira do 🚀: só o navegador na própria tela manda o Origin do board. Agente com curl não se autoaprova.
      if (!daTela(req)) return json(res, 403, { error: "permissão só se responde pelo clique do dono na tela do board" });
      const b = await readBody(req);
      if (perm[1] === "regras") { tirarRegra(String(b.slug || ""), String(b.regra || "")); broadcast("permissao", {}); return json(res, 200, { regras: lerRegras().regras }); }
      const quem = process.env.BOARD_DONO ? `${process.env.BOARD_DONO} (clique na tela)` : "o dono (clique na tela)";
      try { return json(res, 200, { cartao: responderPermissao(perm[1], String(b.acao || ""), quem) }); }
      catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
    }
    if (req.method === "GET" && path === "/api/usage") return json(res, 200, usage());
    // Pull Requests (menu 🔀): os abertos de cada projeto da seleção e o "Mesclar" que o dono clica.
    if (req.method === "GET" && path === "/api/prs") return json(res, 200, await listarPrs({ fresco: url.searchParams.has("fresco") }));
    if (req.method === "POST" && path === "/api/prs/mesclar") {
      const b = await readBody(req);
      try { return json(res, 200, await mesclarPr({ url: String(b.url || ""), forcar: b.forcar === true })); }
      catch (e) { if (e.status) return json(res, e.status, { error: e.message, precisaConfirmar: !!e.precisaConfirmar }); throw e; }
    }
    // 🚀 Publicar por projeto (data/publicar.json): versão no ar × main e o botão que SÓ o dono clica.
    if (req.method === "GET" && path === "/api/publicar") return json(res, 200, await listarPublicar({ fresco: url.searchParams.has("fresco") }));
    const pub = path.match(/^\/api\/publicar\/([\w.-]+)(?:\/(log))?$/);
    if (pub) {
      const [, slug, sub] = pub;
      if (req.method === "GET" && sub === "log") return json(res, 200, { events: readLog(logIdPublicar(slug)) });
      if (req.method === "GET" && !sub) { const st = await statusPublicar(slug, { fresco: url.searchParams.has("fresco") }); return st ? json(res, 200, st) : json(res, 404, { error: "projeto não existe" }); }
      if (req.method === "POST" && !sub) {
        // Barreira contra chamada sem querer (CLI, agente com curl): só o navegador na própria tela manda o Origin do board.
        // Não é cofre — quem quiser fingir o cabeçalho consegue —, por isso o comando também tem de vir confirmado.
        if (!daTela(req)) return json(res, 403, { error: "publicar só pelo clique do dono na tela do board" });
        const b = await readBody(req);
        try { return json(res, 202, await publicar(slug, { confirmo: b.confirmo, quem: process.env.BOARD_DONO ? `${process.env.BOARD_DONO} (clique na tela)` : "o dono (clique na tela)" })); }
        catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
      }
    }
    // Projeto novo pela tela: cria a pasta em DEV (CLAUDE.md + git) e já entra na seleção.
    if (req.method === "POST" && path === "/api/projetos") {
      const b = await readBody(req);
      try {
        const p = criarProjetoNovo({ nome: b.nome, descricao: b.descricao });
        broadcast("state");
        return json(res, 201, { projeto: { slug: p.slug, label: p.label }, aviso: p.aviso });
      } catch (e) {
        if (e.status) return json(res, e.status, { error: e.message });
        throw e;
      }
    }
    if (req.method === "GET" && path === "/api/modelos") return json(res, 200, catalogoModelos());
    if (req.method === "GET" && path === "/api/claude-uso") return json(res, 200, await lerUsos({ fresco: url.searchParams.has("fresco") }));
    /**
     * TROCAR DE MOTOR de uma vez (o botão "Trocar" do painel de Consumo): quando a cota de um
     * acaba, o dono move o que está esperando nele para outro, com o bastão de sempre.
     * ⚠️ Só o que ESPERA: tarefa rodando não se interrompe no meio, e tarefa `pendente` não entra
     * na fila por causa de uma troca de motor (quem decide enfileirar é o dono).
     */
    if (req.method === "POST" && path === "/api/motores/passar") {
      const b = await readBody(req);
      const de = String(b.de || ""), para = String(b.para || "");
      if (!MOTORES[para] || !temBin(MOTORES[para].bin)) return json(res, 400, { error: "motor de destino inválido ou não instalado" });
      if (!MOTORES[de]) return json(res, 400, { error: "motor de origem inválido" });
      if (de === para) return json(res, 400, { error: "o destino é o mesmo motor" });
      const alvos = state.tasks.filter((t) => (t.motor || MOTOR_PADRAO) === de && !t.busy && ["fila", "erro"].includes(t.status));
      for (const t of alvos) passarBastao(t, para, "troca de motor no painel de Consumo");
      return json(res, 200, { ok: true, trocadas: alvos.map((t) => t.id) });
    }
    // ── grafo da memória (menu "Memória") ──
    if (req.method === "GET" && path === "/api/memoria/grafo") {
      const g = montarGrafo(); const mapa = (lerMentes() || {}).mapa || {};
      const nos = g.nos.map((n) => mapa[n.chave] ? { ...n, mente: mapa[n.chave].mente, mentesTambem: mapa[n.chave].tambem || [], menteConfianca: mapa[n.chave].confianca, menteMotivo: mapa[n.chave].motivo } : n);
      const { desde, giro } = giroDaMemoria();
      for (const n of nos) if (giro[n.chave]) n.giro = giro[n.chave];
      return json(res, 200, { geradoEm: g.geradoEm, erro: g.erro || null, nos, ligacoes: g.ligacoes, mentes: resumoMentes(lerMentes()), giroDesde: desde });
    }
    if (req.method === "GET" && path === "/api/memoria/pagina") {
      // Só por chave que o próprio grafo conhece: nada de caminho vindo da tela.
      const g = montarGrafo(); const p = g._porChave && g._porChave.get(String(url.searchParams.get("chave") || ""));
      if (!p) return json(res, 404, { error: "página não encontrada" });
      const titulo = (k) => (g._porChave.get(k) || {}).titulo || k;
      return json(res, 200, { chave: p.chave, id: p.id, projeto: p.projeto, titulo: p.titulo, descricao: p.descricao,
        texto: tiraCabecalhos(p.bruto).slice(0, 60000),
        liga: g.ligacoes.filter((l) => l.a === p.chave).map((l) => ({ chave: l.b, titulo: titulo(l.b) })),
        citadaPor: g.ligacoes.filter((l) => l.b === p.chave).map((l) => ({ chave: l.a, titulo: titulo(l.a) })) });
    }
    // ── Prévia do romaneio: o que o board separaria para um pedido (não cria tarefa, não roda nada) ──
    if (req.method === "GET" && path === "/api/romaneio/previa") {
      const texto = String(url.searchParams.get("texto") || "").slice(0, 4000);
      if (!texto.trim()) return json(res, 400, { error: "escreva o pedido" });
      const pedido = { title: titleOf(texto), text: texto, project: String(url.searchParams.get("projeto") || "DEV") };
      const sentido = url.searchParams.get("modo") === "palavra" ? null : await sentidoDoPedido(pedido);
      const rom = montarRomaneio(pedido, { todasMentes: url.searchParams.has("todas"), ate: url.searchParams.get("ate") || null, sentido });
      return json(res, 200, rom || { vazio: true, motivo: (lerMentes() || {}).status !== "aprovada" ? "endereçamento não aprovado" : "nada relacionado" });
    }
    // ── Inventário da memória: ver, rodar, endereçar novas, descartar, juntar (só com clique do dono) ──
    if (req.method === "GET" && path === "/api/memoria/inventario") return json(res, 200, lerInventario() || { em: null });
    if (req.method === "POST" && path.startsWith("/api/memoria/inventario/")) {
      const acao = path.split("/").pop(); const b = await readBody(req);
      const refresca = () => { atualizarCofreObsidian(); };
      try {
        if (acao === "rodar") return json(res, 200, inventariar());
        const inv = lerInventario() || inventariar();
        if (acao === "enderecar-novas") {
          // proposta pelas pistas (sem IA); confiança média → aparece na lista de conferência e NÃO vai ao romaneio até o dono conferir
          const m = lerMentes(); if (!m) return json(res, 400, { error: "sem endereçamento" });
          const g = montarGrafo(); let n = 0;
          for (const x of inv.novas) {
            const p = g._porChave.get(x.chave); if (!p || m.mapa[x.chave]) continue;
            const texto = semAcentoServidor(p.titulo + " " + p.descricao + " " + tiraCabecalhos(p.bruto).slice(0, 2000));
            const pista = Object.entries(pistasDaMente()).find(([, rx]) => rx.test(texto));
            const mente = p.sessao ? "triagem" : pista ? pista[0] : (mentePorProjeto()[p.projeto] || "triagem");
            m.mapa[x.chave] = { mente, tambem: [], confianca: p.sessao ? "alta" : "media", motivo: p.sessao ? "resumo de sessão" : pista ? "pista do assunto (inventário)" : "mente do projeto (inventário)" };
            n++;
          }
          gravarMentes(m); inventariar(); return json(res, 200, { ok: true, enderecadas: n });
        }
        if (acao === "descartar") {
          const k = String(b.chave || ""); if (!inv.vencidas.some((x) => x.chave === k)) return json(res, 400, { error: "só descarta o que o inventário apontou" });
          apagarDaMemoria(k); inv.feitos.push({ em: now(), acao: "descartada", chaves: [k] }); inv.vencidas = inv.vencidas.filter((x) => x.chave !== k);
          gravarInventario(inv); refresca(); return json(res, 200, { ok: true });
        }
        if (acao === "ignorar") {
          const k = String(b.chave || (Array.isArray(b.chaves) ? [...b.chaves].sort().join("|") : ""));
          if (!k) return json(res, 400, { error: "o que ignorar?" });
          inv.ignoradas = [...new Set([...(inv.ignoradas || []), k])];
          inv.vencidas = inv.vencidas.filter((x) => x.chave !== k); inv.repetidas = inv.repetidas.filter((r) => [...r.chaves].sort().join("|") !== k);
          gravarInventario(inv); return json(res, 200, { ok: true });
        }
        if (acao === "juntar") {
          const chaves = (Array.isArray(b.chaves) ? b.chaves : []).map(String);
          const grupo = inv.repetidas.find((r) => [...r.chaves].sort().join("|") === [...chaves].sort().join("|"));
          if (!grupo) return json(res, 400, { error: "grupo fora do inventário" });
          const g = montarGrafo(); const ps = chaves.map((k) => g._porChave.get(k)).filter(Boolean);
          const prompt = ["Estas páginas da memória compartilhada dos agentes parecem REPETIDAS.",
            "Se tratam do MESMO assunto, escreva UMA página que junte tudo sem perder nenhum fato, regra, data ou motivo, sem inventar nada e sem repetir.",
            "Formato: a 1ª linha é `# Título`; depois o texto em markdown, curto e direto, em português do Brasil.",
            "Se NÃO forem o mesmo assunto (só parecidos), responda apenas `NAO_JUNTAR:` e o motivo em uma frase.",
            ...ps.map((p, i) => `\n===== PÁGINA ${i + 1}: ${p.chave} =====\n${tiraCabecalhos(p.bruto).slice(0, 12000)}`)].join("\n");
          const r = await execP("claude", ["-p", prompt, "--model", "sonnet", "--output-format", "json", "--no-session-persistence",
            "--strict-mcp-config", "--setting-sources", "", "--tools", ""], 180000);
          let d = null; try { d = JSON.parse(r.out); } catch { return json(res, 502, { error: "a IA não respondeu" }); }
          const texto = String(d.result || "").trim(); const custo = d.total_cost_usd || 0;
          const id = createHash("sha1").update([...chaves].sort().join("|")).digest("hex").slice(0, 10);
          const prop = /^NAO_JUNTAR/i.test(texto) ? { chaves, naoJuntar: texto.replace(/^NAO_JUNTAR:?\s*/i, ""), custo, em: now() }
            : { chaves, titulo: (texto.match(/^#\s+(.+)$/m) || [])[1] || "(sem título)", texto, custo, em: now() };
          inv.juntar[id] = prop; gravarInventario(inv); return json(res, 200, { id, ...prop });
        }
        if (acao === "aplicar") {
          const prop = inv.juntar[String(b.id || "")]; if (!prop || !prop.texto) return json(res, 400, { error: "não há versão única para aplicar" });
          const g = montarGrafo(); const alvo = g._porChave.get(prop.chaves[0]); if (!alvo) return json(res, 404, { error: "a 1ª página sumiu" });
          escreverNaMemoria("write-page", { projeto: alvo.projeto, caminho: caminhoNoProjeto(alvo), texto: prop.texto });
          for (const k of prop.chaves.slice(1)) apagarDaMemoria(k);
          delete inv.juntar[String(b.id)]; inv.feitos.push({ em: now(), acao: "juntadas", chaves: prop.chaves, em1: prop.chaves[0] });
          inv.repetidas = inv.repetidas.filter((r) => !r.chaves.includes(prop.chaves[0]));
          gravarInventario(inv); refresca(); return json(res, 200, { ok: true, ficou: prop.chaves[0] });
        }
        return json(res, 404, { error: "ação desconhecida" });
      } catch (e) { return json(res, 500, { error: cut(String(e.stderr || e.message), 300) }); }
    }
    // ── Mentes: conferir e aprovar o endereçamento (só mexe em data/mentes.json) ──
    if (req.method === "GET" && path === "/api/memoria/mentes") return json(res, 200, resumoMentes(lerMentes()));
    if (req.method === "POST" && (path === "/api/memoria/mentes/mover" || path === "/api/memoria/mentes/conferir" || path === "/api/memoria/mentes/aprovar")) {
      const m = lerMentes(); if (!m) return json(res, 404, { error: "ainda não há endereçamento proposto" });
      const b = await readBody(req);
      if (path.endsWith("/aprovar")) {
        const falta = Object.values(m.mapa).filter((x) => x.confianca === "media" || x.confianca === "baixa").length;
        if (falta) return json(res, 400, { error: `ainda faltam ${falta} memórias para conferir` });
        m.status = "aprovada"; m.aprovadaEm = now(); gravarMentes(m); return json(res, 200, resumoMentes(m));
      }
      const item = m.mapa[String(b.chave || "")]; if (!item) return json(res, 404, { error: "memória fora do endereçamento" });
      if (path.endsWith("/mover")) {
        if (!mentesDef().some((x) => x.id === b.mente)) return json(res, 400, { error: "mente inválida" });
        if (b.mente !== item.mente) { item.antes = item.antes || item.mente; item.mente = b.mente; item.tambem = (item.tambem || []).filter((t) => t !== b.mente); }
      }
      item.confianca = "dono"; item.conferidaEm = now(); if (m.status === "aprovada") m.status = "proposta";
      gravarMentes(m); return json(res, 200, { ok: true, item, resumo: resumoMentes(m) });
    }
    // ── Controle: backups + memória; devolve a última leitura na hora e lê em segundo plano ──
    if (req.method === "GET" && path === "/api/controle") {
      lerControle();
      return json(res, 200, CONTROLE);
    }
    // ── infraestrutura (aba Monitoramento): devolve a última leitura na hora; lê em segundo plano ──
    if (req.method === "GET" && path === "/api/monitoring") {
      lerInfra();
      return json(res, 200, INFRA);
    }
    // ── busca semântica ──
    if (req.method === "GET" && path === "/api/busca") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 400, { error: "escreva o que procurar" });
      if (q.length > 500) return json(res, 400, { error: "consulta grande demais" });
      const limite = Math.min(50, Math.max(1, Number(url.searchParams.get("limite")) || 20));
      return json(res, 200, await buscarTarefas(q, { projeto: url.searchParams.get("projeto"), limite }));
    }
    if (req.method === "GET" && path === "/api/busca/estado")
      return json(res, 200, await estadoDaBusca({ fresco: url.searchParams.has("fresco") }));
    if (req.method === "GET" && path === "/api/busca/historico") {
      const n = Math.min(100, Math.max(1, Number(url.searchParams.get("n")) || 30));
      return json(res, 200, { buscas: readLog(BUSCA_LOG).filter((e) => e.t === "busca").slice(-n).reverse() });
    }
    if (req.method === "POST" && path === "/api/busca/reindexar") {
      const r = await indexar(state.tasks, { forcar: true });
      buscaEstadoCache = null;
      if (r.erro) return json(res, 502, { error: r.erro });
      return json(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("event: hello\ndata: {}\n\n");
      clients.add(res);
      ligarTela(url.searchParams.get("tela"), res, req); // #293: cada aba se identifica; `board tela` fala só com a que está em uso
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* caiu */ } }, 20000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (req.method === "POST" && path === "/api/anexos") {
      const buf = await lerBinario(req);
      if (!buf.length) return json(res, 400, { error: "arquivo vazio" });
      return json(res, 201, { anexo: (({ id, nome, mime, bytes }) => ({ id, nome, mime, bytes }))(salvarAnexo(buf, url.searchParams.get("nome"))) });
    }
    if (req.method === "POST" && path === "/api/transcrever-audio") {
      const buf = await lerBinario(req, 25 * 1024 * 1024);
      if (!buf.length) return json(res, 400, { error: "áudio vazio" });
      try {
        return json(res, 200, { texto: await transcrever(buf) });
      } catch (e) {
        return json(res, 500, { error: "não consegui transcrever: " + cut(String(e.stderr || e.message), 200) });
      }
    }
    const img = path.startsWith("/api/anexos/") && path.slice(12).match(ID_ANEXO);
    if (req.method === "GET" && img) {
      const arq = join(ANEXOS, img[0]);
      if (!existsSync(arq)) return json(res, 404, { error: "anexo não existe" });
      const mime = TIPOS_ANEXO.find((t) => img[0].endsWith("." + t.ext))?.mime || "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "x-content-type-options": "nosniff", "cache-control": "public, max-age=31536000, immutable" });
      return res.end(readFileSync(arq));
    }
    // ── a Central: as sessões do Claude abertas na máquina (a coluna da tela) ──
    if (req.method === "GET" && path === "/api/central/sessoes") {
      // #352: cada sessão no tmux leva o 🖥 tmux (Ghostty) (o painel vem do terminal das Sessões, pelo pid).
      const noTmux = new Map(); try { for (const s of (await listarSessoesTerminal()).sessoes) if (s.ghostty) noTmux.set(s.pid, s.ghostty); } catch { /* sem tmux */ }
      return json(res, 200, { nome: NOME_CENTRAL, teto: TETO_ESPONTANEOS, sessoes: listarSessoes().map((s) => (noTmux.has(s.pid) ? { ...s, ghostty: noTmux.get(s.pid) } : s)) });
    }
    // Conferir uma aprovação da Central (`board aprovacao <id> "<pedido>"`). SÓ leitura: não existe rota que grave.
    const ap = path.match(/^\/api\/aprovacoes\/([^/]+)$/);
    if (ap && req.method === "GET") {
      const r = conferirAprovacao(decodeURIComponent(ap[1]), url.searchParams.get("acao") || "", { projetos: [...listProjects(), ...projetosVisiveis()].filter((p) => p.slug !== "DEV") });
      return json(res, 200, r);
    }
    // ── conversa por projeto ──
    const mc = path.match(/^\/api\/conversa\/([\w.-]+)(?:\/(limpar|parar))?$/);
    if (mc) {
      const slug = mc[1], acao = mc[2], c = conversaDe(slug), id = conversaId(slug);
      if (req.method === "GET" && !acao) {
        return json(res, 200, { slug, busy: !!c.busy, naVez: c.busy ? c.naVez || 0 : 0, motor: c.motor, modelo: c.modelo, custo: c.custo || 0, events: readLog(id) });
      }
      if (req.method === "POST" && acao === "parar") {
        // Com resposta no meio, o fim do turno solta a vez: as mensagens que esperam seguem logo depois.
        const cp = running.get(id);
        if (cp) cp.kill("SIGTERM");
        else { c.busy = false; save(); broadcast("state"); }
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && acao === "limpar") {
        // Fio novo: o histórico na tela some junto, senão a tela mostraria o que o agente não lembra.
        if (c.busy) return json(res, 409, { error: "espere a resposta terminar" });
        matarVivo(slug); // o processo vivo lembraria do fio velho
        naVez.delete(slug); c.naVez = 0;
        c.sessionId = null; c.sessoes = {}; c.custo = 0; c.updatedAt = now();
        try { unlinkSync(logPath(id)); } catch { /* nunca houve conversa */ }
        save(); broadcast("state"); broadcast("conversa-limpa", { slug });
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST") {
        const b = await readBody(req);
        const texto = String(b.texto || "").trim();
        if (!texto) return json(res, 400, { error: "escreva alguma coisa" });
        // Responder a uma resposta: o número tem de existir NESTE fio (🧹 novo fio recomeça a contagem).
        const cita = b.cita == null ? null : respostaNumero(slug, Number(b.cita));
        if (b.cita != null && !cita) return json(res, 400, { error: `não achei a resposta R${String(b.cita).slice(0, 12)} nesta conversa` });
        // Central (#213): o que o dono digita NA TELA (Origin da própria tela, como o 🚀) vira aprovação conferível pelas
        // outras sessões. CLI, curl de agente e turno de outra sessão não passam por aqui com Origin: não ganham id.
        const aprovacao = slug === CENTRAL && daTela(req) ? registrarAprovacao({ texto, refere: refereDe(readLog(id), cita) }).id : null;
        falarNaConversa(slug, texto, { anexos: b.anexos, motor: b.motor, modelo: b.modelo, cita, aprovacao })
          .catch((e) => { logEvent(id, { t: "solto", texto: "⚠ " + e.message }); const cc = conversaDe(slug); cc.busy = false; save(); broadcast("state"); });
        return json(res, 202, { ok: true, ...(aprovacao ? { aprovacao } : {}) }); // a resposta chega pelo SSE, como na tarefa
      }
    }

    if (req.method === "POST" && path === "/api/tasks") {
      const b = await readBody(req);
      if (!String(b.text || "").trim()) return json(res, 400, { error: "escreva a tarefa" });
      return json(res, 201, { tasks: createTasks(b.text, b.project, { queue: !!b.queue, entrega: b.entrega, anexos: b.anexos, motor: b.motor, modelo: b.modelo, porte: b.porte, paralelo: !!b.paralelo }) });
    }
    if (req.method === "POST" && (path === "/api/fila/pausar" || path === "/api/fila/retomar")) {
      const pausar = path.endsWith("pausar");
      if (pausar) writeFileSync(PAUSE_FLAG, now()); else { try { unlinkSync(PAUSE_FLAG); } catch { /* já estava retomada */ } }
      console.log(pausar ? `${C.amber}⏸ fila pausada pelo dono${C.r}` : `${C.green}▶ fila retomada pelo dono${C.r}`);
      broadcast("state");
      return json(res, 200, { ok: true, pausada: pausar });
    }
    if (req.method === "POST" && path === "/api/reiniciar") {
      pedirReinicio(); broadcast("state");
      const ocupado = state.tasks.some((t) => t.status === "rodando" || t.busy) || TRANSCRICOES.size > 0;
      return json(res, 202, { ok: true, agora: !ocupado, aviso: ocupado ? "vai reiniciar assim que nada estiver rodando" : "reiniciando agora" });
    }
    if (req.method === "POST" && path === "/api/tasks/reorder") {
      const b = await readBody(req);
      if (!Array.isArray(b.ids)) return json(res, 400, { error: "ids" });
      reorder(b.ids); return json(res, 200, { ok: true });
    }
    const m = path.match(/^\/api\/tasks\/(\d+)(?:\/(log|chat|stop|pr|publicar|passar|projeto|juntar))?$/);
    if (m) {
      const task = taskById(m[1]);
      if (!task) return json(res, 404, { error: "tarefa não existe" });
      const sub = m[2];
      if (req.method === "GET" && sub === "log") return json(res, 200, { task, events: readLog(task.id) });
      if (req.method === "GET" && !sub) return json(res, 200, { task });
      if (req.method === "PATCH" && !sub) { updateTask(task, await readBody(req)); return json(res, 200, { task }); }
      if (req.method === "DELETE" && !sub) { removeTask(task); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && sub === "stop") { stopTask(task); return json(res, 200, { task }); }
      if (req.method === "POST" && sub === "passar") {
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está rodando — pare antes de passar o bastão" });
        const b = await readBody(req);
        const novo = String(b.motor || "");
        if (!MOTORES[novo] || !temBin(MOTORES[novo].bin)) return json(res, 400, { error: "motor inválido ou não instalado" });
        if (novo === (task.motor || MOTOR_PADRAO)) return json(res, 400, { error: "a tarefa já está nesse motor" });
        passarBastao(task, novo);
        return json(res, 202, { ok: true, motor: novo });
      }
      // O aviso "parece ser de outro projeto": o dono move ou confirma (e só então a tarefa anda na fila).
      if (req.method === "POST" && sub === "projeto") {
        const b = await readBody(req);
        try { resolverProjeto(task, b.acao); return json(res, 200, { task }); }
        catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
      }
      // ⚡ "não juntada — conflito": o dono resolveu na pasta (ou quer tentar outra vez) e manda juntar de novo.
      if (req.method === "POST" && sub === "juntar") {
        try { tentarJuntarDeNovo(task); return json(res, 202, { task }); }
        catch (e) { if (e.status) return json(res, e.status, { error: e.message }); throw e; }
      }
      if (req.method === "POST" && (sub === "pr" || sub === "publicar")) {
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está ocupada — espere terminar" });
        if (!task.sessionId) return json(res, 400, { error: "esta tarefa nunca rodou — não há trabalho para entregar" });
        if (sub === "publicar" && !deployCommand(projectOf(task)))
          return json(res, 400, { error: `o projeto "${rotuloDoProjeto(task.project)}" não tem comando de publicação declarado em data/deploy.json` });
        // ⚠️ Pela FILA, nunca direto: chamar prTask aqui pulava o "um agente por projeto", e 20
        // cliques em Virar PR viraram 20 agentes na mesma pasta, a caminho de criar
        // branch e commitar ao mesmo tempo na mesma árvore (16/09, parado a tempo).
        // E um PR por projeto de cada vez: a pasta é uma só, o primeiro PR leva TODAS as mudanças.
        const outro = state.tasks.find((t) => t.id !== task.id && t.project === task.project && (t.acao || (t.etapa === "entrega")));
        if (outro) return json(res, 409, { error: `já tem um PR sendo montado para ${rotuloDoProjeto(task.project)} (#${outro.id}). A pasta é uma só: esse PR leva todas as mudanças que estão nela. Espere ele terminar.` });
        task.acao = sub === "publicar" ? "deploy" : "pr";
        task.status = "fila"; task.retentativa = null; task.updatedAt = now();
        logEvent(task.id, { t: "retentativa", estado: "na-fila", texto: task.acao === "deploy" ? "na fila para entregar, mesclar e publicar" : "na fila para virar PR" });
        save(); broadcast("state");
        return json(res, 202, { ok: true });
      }
      if (req.method === "POST" && sub === "chat") {
        const b = await readBody(req);
        const text = String(b.text || "").trim();
        if (!text && !anexosValidos(b.anexos).length) return json(res, 400, { error: "escreva a mensagem ou anexe uma imagem" });
        if (text.length > 8000) return json(res, 400, { error: "mensagem grande demais" });
        if (task.busy || task.status === "rodando") return json(res, 409, { error: "a tarefa está rodando — espere terminar" });
        chatTask(task, text, b.anexos); // assíncrono: a resposta chega pelo SSE
        return json(res, 202, { ok: true });
      }
    }
    json(res, 404, { error: "rota não existe" });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});
