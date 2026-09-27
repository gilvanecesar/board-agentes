// Fixed demo data (fictional projects, tasks and memories) for the screen tests and the reference snapshot.
// Everything is relative to AGORA, so two runs produce byte-identical screens when the clock is frozen at AGORA.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const AGORA = Date.parse("2026-09-20T15:00:00.000Z");

export function montarDemo(dev, memoria, data) {
  const dia = (n) => new Date(AGORA - n * 86400000).toISOString();
  const PROJ = { "loja-online": "Loja virtual (Next.js + Postgres)", "api-pagamentos": "API de pagamentos: Pix, cartão, assinatura", "app-entregas": "App do entregador (React Native)", "site-institucional": "Site da empresa" };
  for (const [p, d] of Object.entries(PROJ)) {
    mkdirSync(join(dev, p), { recursive: true });
    writeFileSync(join(dev, p, "CLAUDE.md"), `# ${p}\n\n${d}\n`);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(dev, p) });
  }
  writeFileSync(join(dev, "loja-online", "package.json"), JSON.stringify({ name: "loja-online", private: true, scripts: { check: "true", test: "true" } }));
  const MEM = memoria;
  const M = [
    // [projeto, id, mente, título, descrição, dias atrás, ligações]
    ["_global", "respostas-curtas", "dono", "Respostas curtas, em tópicos", "O dono lê no celular: resposta curta, tabela quando há número", 3, ["veredito-primeiro"]],
    ["_global", "veredito-primeiro", "dono", "Veredito primeiro, fraqueza antes do elogio", "Começar pela conclusão e dizer o ponto fraco sem rodeio", 12, ["respostas-curtas"]],
    ["_global", "nunca-inventar-numero", "dono", "Nunca escrever número que o sistema não conta", "Número inventado num produto que mede coisas é o caminho mais curto para perder a confiança", 20, ["conciliacao-diaria"]],
    ["_global", "documentar-tudo", "dono", "Toda mudança vai para o CLAUDE.md do projeto", "Registrar a decisão e o porquê, sem esperar pedido", 30, []],
    ["_global", "producao-so-por-pr", "dono", "Produção só por PR que o dono revisa", "Nunca deploy nem mudança em banco por agente", 8, ["deploy-com-rollback"]],
    ["_global", "perguntar-decisao-de-produto", "dono", "Decisão de produto: perguntar antes de codar", "O que conta como cliente, o que uma meta significa: é do dono", 45, []],
    ["_global", "mobile-primeiro", "design", "Mobile primeiro", "A maior parte dos usuários está no celular: toda tela nasce no celular", 60, ["safe-area-iphone"]],
    ["_global", "segredos-fora-do-repo", "seguranca", "Segredo nunca no repositório", "Chave e token vivem em arquivo com permissão 600, fora do git", 25, []],
    ["_global", "rate-limit-ip-real", "seguranca", "Rate limit pelo IP real, não o do proxy", "Atrás do proxy todo mundo tinha o mesmo IP: um balde só para a plataforma inteira", 40, ["segredos-fora-do-repo"]],
    ["_global", "teste-instavel-anotar", "engenharia", "Teste instável fora do escopo: anotar e seguir", "Não parar a tarefa para investigar teste que ela não tocou", 18, []],
    ["_global", "deploy-com-rollback", "engenharia", "Deploy sempre com o rollback pronto", "A versão anterior fica marcada e o comando de volta testado", 33, ["producao-so-por-pr"]],
    ["_global", "decisions/um-pr-por-tarefa", "engenharia", "Uma tarefa abre UM pull request", "O conserto continua na mesma branch; nunca abrir outro PR", 10, ["producao-so-por-pr"]],
    ["loja-online", "carrinho-expira", "produto", "Carrinho expira em 30 minutos", "O estoque reservado volta sozinho; o aviso aparece aos 25 min", 15, ["frete-gratis-199"]],
    ["loja-online", "cupom-nao-acumula", "produto", "Cupom não acumula com promoção", "Vale o maior desconto; a tela diz qual foi aplicado", 22, ["carrinho-expira"]],
    ["loja-online", "checkout-uma-tela", "design", "Checkout em uma tela só", "Endereço, frete e pagamento na mesma tela: cada passo a mais perdia cliente", 5, ["cupom-nao-acumula", "pix-webhook-idempotente"]],
    ["loja-online", "frete-gratis-199", "produto", "Frete grátis acima de R$ 199", "Regra única, calculada no servidor, nunca na tela", 50, []],
    ["loja-online", "drawer-lateral", "design", "Detalhe abre em drawer lateral", "Edição e detalhe de um item abrem à direita, não em página nova", 35, ["checkout-uma-tela"]],
    ["loja-online", "placeholder-sem-zero", "design", "Placeholder nunca é zero", "Usar exemplo descritivo: '0' parece valor preenchido", 70, []],
    ["loja-online", "carrinho-abandonado", "comercial", "Campanha de carrinho abandonado", "E-mail em 1 h e 24 h; o segundo com cupom de 5%", 28, ["cupom-nao-acumula"]],
    ["loja-online", "busca-keep-previous", "engenharia", "Busca com debounce perdia o foco", "keepPreviousData no query resolve: a lista não pisca e o campo não perde o foco", 2, []],
    ["loja-online", "imagens-webp", "engenharia", "Imagens em WebP, com tamanho fixo", "Sem tamanho a página pulava ao carregar", 80, []],
    ["api-pagamentos", "pix-webhook-idempotente", "financeiro", "Webhook do Pix tem que ser idempotente", "O banco reenvia o mesmo aviso; processar duas vezes dava baixa em dobro", 6, ["chave-idempotencia", "dinheiro-em-centavos"]],
    ["api-pagamentos", "chave-idempotencia", "financeiro", "Chave de idempotência por pedido", "Toda cobrança leva a chave do pedido; o segundo aviso é ignorado e registrado", 6, ["pix-webhook-idempotente"]],
    ["api-pagamentos", "dinheiro-em-centavos", "financeiro", "Dinheiro sempre em centavos inteiros", "Nunca float: R$ 10,10 virava 10,099999", 90, []],
    ["api-pagamentos", "estorno-mesmo-meio", "financeiro", "Estorno só pelo mesmo meio de pagamento", "Pix volta por Pix, cartão por cartão", 42, ["dinheiro-em-centavos"]],
    ["api-pagamentos", "conciliacao-diaria", "financeiro", "Conciliação diária com o extrato", "Todo dia às 6h: o que o banco diz × o que o sistema registrou", 14, ["dinheiro-em-centavos"]],
    ["api-pagamentos", "assinatura-renova", "produto", "Assinatura renova no dia do vencimento", "Sem cobrança antecipada; falhou, tenta de novo em 1 e 3 dias", 55, []],
    ["api-pagamentos", "idor-pedidos", "seguranca", "GET /pedidos/:id sempre filtra pelo dono", "Sem o filtro, qualquer usuário via pedido alheio trocando o número", 9, ["rate-limit-ip-real"]],
    ["api-pagamentos", "nota-apos-pagamento", "financeiro", "Nota fiscal só depois do pagamento confirmado", "Emitir antes gerava nota de venda cancelada", 65, ["pix-webhook-idempotente"]],
    ["app-entregas", "rota-recalcula", "produto", "Rota recalcula a cada 5 minutos", "Em trânsito pesado, a rota nova vem sozinha", 12, []],
    ["app-entregas", "comprovante-foto-gps", "produto", "Comprovante de entrega com foto e GPS", "Sem os dois, a entrega não fecha", 20, ["offline-fila-local"]],
    ["app-entregas", "offline-fila-local", "engenharia", "Sem internet: fila local", "O app guarda as entregas e envia quando voltar o sinal", 38, ["comprovante-foto-gps"]],
    ["app-entregas", "safe-area-iphone", "design", "Respeitar a safe area do iPhone", "O botão de concluir ficava embaixo da barra do sistema", 48, ["mobile-primeiro"]],
    ["app-entregas", "push-token-renova", "engenharia", "Token de push renova sozinho", "Guardar o token novo a cada abertura do app", 75, []],
    ["site-institucional", "landing-uma-pagina", "comercial", "Landing em uma página só", "Uma chamada, um botão: menos opções, mais contato", 26, []],
    ["site-institucional", "seo-titulo", "comercial", "Título de SEO até 60 caracteres", "Passou disso, o Google corta", 85, ["landing-uma-pagina"]],
    ["_global", "onde-paramos-agosto", "triagem", "Onde paramos: fim de agosto", "Nota de status com data", 31, []],
  ];
  
  const mapa = {};
  for (const [p, id, mente, tit, desc, d, lig] of M) {
    const f = join(MEM, p, id + ".md"); mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, `---\ntier: semantic\ntype: Note\n---\n---\nname: ${id.split("/").pop()}\ndescription: ${desc}\nmetadata:\n  type: ${mente === "dono" ? "feedback" : "project"}\n  modified: ${dia(d)}\n---\n\n# ${tit}\n\n${desc}.\n\n${lig.map((l) => `Ver [[${l}]].`).join(" ")}\n`);
    mapa[`${p}/${id.split("/").pop()}`] = { mente, tambem: [], confianca: "alta", motivo: "demonstração" };
  }
  mapa["api-pagamentos/estorno-mesmo-meio"].confianca = "media"; // one to review in the Galpão list
  for (const p of ["_global", ...Object.keys(PROJ)]) writeFileSync(join(MEM, p, "_meta.md"), `---\nproject: ${p}\n---\n`);
  for (const d of ["logs", "raw", "anexos"]) mkdirSync(join(data, d), { recursive: true });
  writeFileSync(join(data, "mentes.json"), JSON.stringify({
    status: "aprovada", geradoEm: dia(1), aprovadaEm: dia(1), mapa, nucleoDono: ["_global/respostas-curtas", "_global/producao-so-por-pr"],
    mentePorProjeto: { "loja-online": "produto", "api-pagamentos": "financeiro", "app-entregas": "produto", "site-institucional": "comercial" },
    temas: { Loja: "loja|carrinho|cupom|checkout|frete", Pagamentos: "pix|pagamento|estorno|concilia|assinatura|webhook", Entregas: "entrega|rota|motorista|comprovante" },
  }, null, 1));
  const T = [
    [12, "api-pagamentos", "executada", "Pix pago não libera o pedido quando o webhook do banco chega duas vezes: o segundo aviso dá erro 500 e o pedido fica 'aguardando'. Tornar o webhook idempotente pela chave do pedido e cobrir com teste.", 2.84, 58, 412, "eng01", "pr"],
    [11, "loja-online", "executada", "Campo de busca da loja perde o foco a cada letra digitada (a lista recarrega). Manter o foco e não piscar a lista.", 0.61, 14, 95, "eng01", "direto"],
    [10, "app-entregas", "executada", "Botão 'Concluir entrega' fica escondido atrás da barra do iPhone em telas sem botão home.", 0.48, 11, 73, "eng02", "direto"],
    [9, "loja-online", "concluida", "Cupom e promoção estão somando o desconto; deve valer só o maior, e a tela precisa dizer qual foi aplicado.", 1.37, 31, 240, "eng01", "pr"],
    [8, "api-pagamentos", "concluida", "Relatório de conciliação diária: o que o extrato do banco diz × o que o sistema registrou, com as diferenças no topo.", 3.12, 66, 530, "eng01", "pr"],
    [7, "site-institucional", "concluida", "Landing nova em uma página só: chamada, três benefícios, prova social e um botão de contato.", 1.05, 22, 180, "eng01", "direto"],
    [6, "app-entregas", "concluida", "Entregas feitas sem internet somem ao fechar o app. Guardar numa fila local e enviar quando voltar o sinal.", 2.21, 47, 366, "eng01", "pr"],
    [5, "loja-online", "concluida", "Detalhe do pedido no admin abre em página nova; abrir em drawer lateral, como o resto das telas.", 0.72, 16, 110, "eng02", "direto"],
    [4, "api-pagamentos", "concluida", "GET /pedidos/:id devolve pedido de outro usuário quando se troca o número. Filtrar pelo dono e testar o caso.", 0.94, 19, 150, "eng01", "pr"],
    [3, "loja-online", "pendente", "Campanha de carrinho abandonado: e-mail em 1 h e em 24 h, o segundo com cupom de 5%.", 0, 0, 0, null, "direto"],
    [2, "app-entregas", "pendente", "Comprovante de entrega com foto e localização obrigatórias.", 0, 0, 0, null, "direto"],
    [1, "site-institucional", "pendente", "Revisar os títulos de SEO de todas as páginas (até 60 caracteres).", 0, 0, 0, null, "direto"],
  ];
  
  const tasks = T.map(([id, project, status, text, cost, turns, seg, agente, entrega], i) => {
    const criada = dia(10 - i * 0.7), ok = status !== "pendente";
    return { id, text, title: text.length > 110 ? text.slice(0, 108) + "…" : text, project, status, entrega, motor: "claude", order: i,
      createdAt: criada, updatedAt: criada, startedAt: ok ? criada : null, finishedAt: ok ? dia(9.9 - i * 0.7) : null,
      cost, turns, durationMs: seg * 1000, agente: agente || undefined, modeloUsado: ok ? "claude-opus-5-5" : undefined, esforcoUsado: ok ? (turns < 20 ? "low" : undefined) : undefined,
      porte: ok ? (turns < 20 ? "leve" : "normal") : null, porteAuto: ok,
      gate: ok ? { comando: "npm run check && npm test", ok: true, code: 0, em: criada } : null,
      revisor: ok ? { veredito: "APROVADO", rodadas: 0, em: criada } : null, qa: ok ? { veredito: "APROVADO", rodadas: 0, em: criada } : null,
      prUrl: ok && entrega === "pr" ? `https://github.com/exemplo/${project}/pull/${40 + id}` : null, anexos: [], tokens: 0 };
  });
  // one task in each remaining state the screens know: queued, error with retry, running is not seeded (the runner would take it)
  tasks.push({ ...tasks[9], id: 13, text: "Página de rastreio do pedido com o mapa da entrega.", title: "Página de rastreio do pedido com o mapa da entrega.", status: "fila", order: 12 });
  tasks.push({ ...tasks[9], id: 14, text: "Exportar pedidos do mês em CSV.", title: "Exportar pedidos do mês em CSV.", status: "erro", order: 13, error: "o portão reprovou (npm run check && npm test)", tentativas: 2, retentativa: null, startedAt: dia(1), finishedAt: dia(1) });
  writeFileSync(join(data, "board.json"), JSON.stringify({ seq: 14, tasks, conversas: { "loja-online": { sessionId: "sessao-demo", motor: "claude", custo: 0.12, updatedAt: dia(0.1) } }, pausaAte: null }, null, 1));
  const t0 = Date.parse(tasks[0].createdAt); const at = (s) => new Date(t0 + s * 1000).toISOString();
  const ev = [
    { at: at(0), t: "inicio", titulo: tasks[0].title, projeto: "api-pagamentos", dir: "api-pagamentos" },
    { at: at(1), t: "romaneio", mentes: ["financeiro"], tokens: 1640, itens: [
      { chave: "api-pagamentos/pix-webhook-idempotente", titulo: "Webhook do Pix tem que ser idempotente", mente: "financeiro", nota: 24.1 },
      { chave: "api-pagamentos/chave-idempotencia", titulo: "Chave de idempotência por pedido", mente: "financeiro", nota: 19.6 },
      { chave: "api-pagamentos/dinheiro-em-centavos", titulo: "Dinheiro sempre em centavos inteiros", mente: "financeiro", nota: 7.2 },
      { chave: "api-pagamentos/nota-apos-pagamento", titulo: "Nota fiscal só depois do pagamento confirmado", mente: "financeiro", nota: 6.4 },
      { chave: "_global/respostas-curtas", titulo: "Respostas curtas, em tópicos", mente: "dono", nota: 0 },
      { chave: "_global/producao-so-por-pr", titulo: "Produção só por PR que o dono revisa", mente: "dono", nota: 0 },
      { chave: "_global/nunca-inventar-numero", titulo: "Nunca escrever número que o sistema não conta", mente: "dono", nota: 0 }] },
    { at: at(6), t: "ferramenta", nome: "Read", alvo: "src/webhooks/pix.ts", quem: "agente" },
    { at: at(9), t: "ferramenta", nome: "Grep", alvo: "idempotencyKey|chaveIdempotencia", quem: "agente" },
    { at: at(14), t: "texto", texto: "O romaneio já traz a regra: a chave de idempotência é a do pedido. O handler grava o pagamento antes de conferir se ele já existe, e o segundo aviso estoura a unique e vira 500.", quem: "agente" },
    { at: at(40), t: "ferramenta", nome: "Edit", alvo: "src/webhooks/pix.ts", quem: "agente" },
    { at: at(70), t: "ferramenta", nome: "Write", alvo: "src/webhooks/pix.test.ts", quem: "agente" },
    { at: at(95), t: "ferramenta", nome: "Bash", alvo: "npm test -- pix", quem: "agente" },
    { at: at(300), t: "resultado", texto: "**Webhook do Pix idempotente.**\n\n| | |\n|---|---|\n| Causa | o handler gravava o pagamento antes de conferir a chave do pedido; o 2º aviso estourava a unique (500) |\n| Correção | `INSERT … ON CONFLICT (chave) DO NOTHING` e o aviso repetido responde 200, registrado como duplicado |\n| Teste | `pix.test.ts`: mesmo aviso 3× → 1 pagamento, pedido liberado |\n\n`npm test`: 48 testes, todos verdes. PR aberto.", custo: 2.1, turnos: 44, dur: 300000 },
    { at: at(305), t: "portao", estado: "rodando", comando: "npm run check && npm test" },
    { at: at(330), t: "portao", estado: "passou", comando: "npm run check && npm test", code: 0 },
    { at: at(360), t: "revisor", veredito: "APROVADO", texto: "APROVADO\n- A correção está no ponto certo (antes da escrita), e o teste cobre o aviso repetido.", custo: 0.31 },
    { at: at(410), t: "qa", veredito: "APROVADO", texto: "APROVADO\n- Mandei o mesmo aviso 5 vezes contra uma cópia local: 1 pagamento, pedido liberado, 4 registrados como duplicados.", custo: 0.43 },
    { at: at(412), t: "fim", status: "executada" },
  ];
  
  writeFileSync(join(data, "logs", "12.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(data, "logs", "conversa-loja-online.jsonl"), [
    { at: dia(0.2), t: "dono", texto: "Como está o checkout hoje? Quantas telas?" },
    { at: dia(0.19), t: "resultado", texto: "**Uma tela só** — endereço, frete e pagamento juntos.\n\n| Passo | Onde |\n|---|---|\n| Endereço | topo |\n| Pagamento | fim |", custo: 0.12, quem: "agente" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(data, "logs", "busca.jsonl"), [
    { at: dia(1), t: "busca", consulta: "pix duplicado", modo: "lexico", provedor: "lexico", projeto: "todos", ms: 3, achados: [{ id: 12, title: "Pix pago não libera o pedido", score: 0.81 }] },
    { at: dia(2), t: "busca", consulta: "foco da busca", modo: "lexico", provedor: "lexico", projeto: "loja-online", ms: 2, achados: [{ id: 11, title: "Campo de busca da loja perde o foco", score: 0.77 }] },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { tarefas: tasks.length, memorias: M.length };
}
