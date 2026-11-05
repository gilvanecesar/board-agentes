// O que cada papel recebe por escrito: regras da casa, de entrega (direto/PR/cópia), do revisor e do QA.
import { execFileSync } from "child_process";
import { DONO, PRODUCAO } from "./config.mjs";
import { readLog } from "./estado.mjs";
import { gitInfo } from "./projetos.mjs";
   // id → processo do portão

// O QA da #286 (01/11) acabou com um `pkill -f 'whisper-cli.*board-ditado'` na sonda: o `-p` do próprio claude trazia as duas palavras.
const SEM_PKILL = "- Para encerrar um processo seu, use o pid (`$!`, `kill <pid>`), nunca `pkill -f` nem `killall`: a linha de comando dos agentes traz o pedido inteiro, e o padrão casa com você mesmo ou com outro agente.";

// #306: o QA da #305 deixou as rodadas em segundo plano, escreveu "Aguardando a notificação" e ficou esperando até o teto do board cortá-lo.
// O board também liga CLAUDE_CODE_DISABLE_BACKGROUND_TASKS (`runMotor`); isto é para o que a variável não pega: `&`, `nohup` e os outros motores.
const SEM_SEGUNDO_PLANO = "- 🔴 NADA em segundo plano: nem `run_in_background`, nem `&`, nem `nohup`. Rode cada comando em primeiro plano, com teto (`timeout` de até 10 min), e o que for mais longo divida em pedaços. Sua resposta final É o parecer: nunca termine dizendo que está esperando algo, porque ninguém volta para ler o resto e a rodada acaba cortada sem veredito.";

// O `-p` vai na linha de comando, e o Linux recusa argumento acima de 128 KiB: o teto só protege contra um parecer fora do normal.
const TETO_PARECER = 30000;

// GRAVE × MENOR (#300, aprovado pelo dono na Central, aprovação #5caff1ae5626): o título de cada bloco, em qualquer roupa de markdown.
// Exige `:`, travessão ou fim de linha depois da palavra: "Menores de idade não…" é frase, não bloco.
const TITULO_BLOCO = /^[\s>*_#`-]*(?:\d+[.)]\s*)?(GRAVES?|MENOR(?:ES)?)\b[\s*_`]*(?:\(\d+\))?[\s*_`]*(?::|—|–|-\s|$)[\s*_`]*(.*)$/i;
const DIZ_NADA = /^(0|nada|n\/a|(nenhum|nenhuma|sem)( defeitos?)?( (graves?|menores?))?)$/i;
const MARCA_DE_LISTA = /^\s*(?:[-*•>]+\s+|\d+[.)]\s+)/;
const semEnfeite = (s) => String(s).replace(/[*_`.!\s]+/g, " ").trim();

/**
 * O parecer de revisor e QA, lido sem acreditar na primeira palavra. Fail-closed em todo caso que não é "sem GRAVE, por escrito":
 * - GRAVE listado reprova, mesmo com APROVADO na primeira linha; REPROVADO reprova, mesmo sem GRAVE listado.
 * - APROVADO só vale com os dois blocos legíveis (itens ou "nenhum"). Bloco vazio não é "nenhum". A palavra SOZINHA vale: não aponta nada a classificar.
 * - Sem veredito, ou APROVADO sem classificação → `veredito: null`, e null é reprova.
 */
export function lerParecer(texto) {
  const t = String(texto || "");
  const sozinhas = [...t.matchAll(/^[\s*_#>`-]*(APROVADO|REPROVADO)[\s*_.!`]*$/gim)].map((m) => m[1].toUpperCase());
  const solta = t.match(/\b(APROVADO|REPROVADO)\b/i);
  const palavra = sozinhas.includes("REPROVADO") ? "REPROVADO" : sozinhas[0] || (solta ? solta[1].toUpperCase() : null);
  const blocos = { grave: null, menor: null };
  let atual = null;
  const acrescenta = (linha) => {
    if (!/[\p{L}\p{N}]/u.test(linha)) return;
    const b = blocos[atual];
    if (DIZ_NADA.test(semEnfeite(linha.replace(MARCA_DE_LISTA, "")))) { b.nada = true; return; }
    b.itens.push(linha.replace(MARCA_DE_LISTA, "").replace(/\*\*|__/g, "").trim());
  };
  for (const linha of t.split(/\r?\n/)) {
    const m = linha.match(TITULO_BLOCO);
    if (m) { atual = /^g/i.test(m[1]) ? "grave" : "menor"; blocos[atual] ||= { nada: false, itens: [] }; acrescenta(m[2]); continue; }
    if (!atual || !linha.trim()) continue;
    const lista = MARCA_DE_LISTA.test(linha), b = blocos[atual];
    if (atual === "menor" && b.nada && !lista) continue; // "MENORES: nenhum" e uma frase solta depois não viram sobra; em GRAVES, conta (na dúvida, grave)
    if (!lista && /^\s{2,}/.test(linha) && b.itens.length) b.itens[b.itens.length - 1] += " " + linha.trim().replace(/\*\*|__/g, ""); // continuação do item
    else acrescenta(linha);
  }
  const graves = blocos.grave?.itens || [], menores = blocos.menor?.itens || [];
  const legivel = (b) => !!b && (b.nada || b.itens.length > 0);
  const classificado = legivel(blocos.grave) && legivel(blocos.menor);
  const soAPalavra = /^[\s*_#>`-]*APROVADO[\s*_.!`]*$/i.test(t);
  const veredito = !palavra ? null : graves.length || palavra === "REPROVADO" ? "REPROVADO" : classificado || soAPalavra ? "APROVADO" : null;
  const linha = sozinhas.includes("REPROVADO") ? "REPROVADO" : sozinhas[0] || null;
  return { veredito, graves, menores, semClassificacao: palavra === "APROVADO" && veredito === null, classificado, linha, soAPalavra: !!linha && semEnfeite(t).toUpperCase() === linha };
}

/**
 * O parecer de uma rodada que pode ter mais de um turno: o CLI fecha o turno (`result`), fica vivo se sobrou tarefa em segundo plano e abre outro
 * quando ela acaba. Vale o ÚLTIMO, que relê tudo e pode mudar de ideia. O anterior só volta se o último repetiu a MESMA palavra, sem os dois blocos:
 * - "REPROVADO\n\nO veredito não muda." (#288): reprova de todo jeito, e sem o anterior o agente receberia a frase em vez do defeito. Vão os dois.
 * - "APROVADO" sozinho: não acrescenta nada, e o anterior guarda as sobras.
 * - "APROVADO" com texto NÃO: o board não lê o texto, e "Na verdade a 5ª rodada falhou" pareceria com "a notificação é só a espera" (QA da #306). Fica o último, sem classificação.
 */
export function parecerDaRodada(textos) {
  const lista = textos.filter((t) => String(t || "").trim());
  const ultimo = lista.at(-1) || "";
  const fim = lerParecer(ultimo);
  if (!fim.linha || fim.classificado || (fim.linha === "APROVADO" && !fim.soAPalavra)) return ultimo;
  const antes = lista.slice(0, -1).reverse().find((t) => lerParecer(t).classificado);
  if (!antes || lerParecer(antes).veredito !== fim.linha) return ultimo;
  return fim.soAPalavra ? antes : `${ultimo}\n\n${antes}`;
}

/** Só o que reprovou: o agente conserta os GRAVES, e os menores ficam para o dono. Sem GRAVE listado, o texto vai inteiro: é tudo o que ele tem. */
export function parecerSoGrave(parecer) {
  const texto = String(parecer || "").trim();
  if (!lerParecer(texto).graves.length) return texto;
  let fora = false;
  return texto.split(/\r?\n/).filter((l) => { const m = l.match(TITULO_BLOCO); if (m) fora = /^m/i.test(m[1]); return !fora; }).join("\n").trim();
}

/** O que o agente recebe de uma reprova: igual na rodada de conserto da esteira e em toda volta depois dela. */
export function pedidoDeConserto(papel, parecer, comando = "") {
  const texto = papel === "portao" ? String(parecer || "").trim() : parecerSoGrave(parecer);
  if (papel === "portao") return ["O PORTÃO do board reprovou o seu trabalho. O comando de verificação do projeto falhou:",
    "", "$ " + comando, texto.slice(-4000), "",
    "Conserte de verdade (não desligue teste nem afrouxe conferência) e responda o que mudou."].join("\n");
  const semClasse = lerParecer(texto).semClassificacao ? "⚠️ O parecer disse APROVADO sem os blocos GRAVES e MENORES, e sem eles o board conta como reprova. Se ele não aponta defeito, não invente conserto: diga isso.\n\n" : "";
  const corpo = semClasse + (texto.slice(0, TETO_PARECER) || "(sem parecer escrito: nem veredito legível, o que conta como reprova)");
  if (papel === "revisor") return ["O REVISOR do board reprovou o seu trabalho:", "", corpo, "",
    "Corrija o que ele apontou e responda o que mudou. Se discordar, explique com evidência.",
    "Defeito MENOR não é pedido de conserto: fica para o dono decidir."].join("\n");
  return ["O QA do board testou a sua entrega e REPROVOU:", "", corpo, "",
    "Reproduza cada defeito com o passo que ele deu, conserte na causa, deixe um teste que morda o defeito, e responda o que mudou.",
    "Instabilidade que ele marcou como PRÉ-EXISTENTE não é sua: não mexa nela.",
    "Defeito MENOR não é pedido de conserto: fica para o dono decidir."].join("\n");
}

/**
 * As reprovas que nada aprovou depois, lidas do LOG, que guarda o parecer inteiro. O motivo do erro não serve: é uma
 * frase ("o QA reprovou (REPROVADO)"), e o portão, o revisor e o QA de uma rodada nova apagam task.gate/revisor/qa.
 * Vale por etapa: o revisor aprovar não resolve o que o QA reprovou. Portão cortado por tempo não é teste falhando, e
 * rodada SEM VEREDITO não é parecer (#306): na #305 o agente recebeu "Aguardando a notificação" como reprova, duas vezes.
 */
export function pareceresAbertos(task) {
  const abertos = new Map();
  const reprova = (papel, e) => { abertos.delete(papel); abertos.set(papel, { papel, at: e.at, texto: e.saida ?? e.texto, comando: e.comando }); };
  for (const e of readLog(task.id)) {
    if (e.t === "fim" && e.status === "executada") abertos.clear();
    else if (e.t === "portao" && e.estado === "falhou") { if (!e.cortado) reprova("portao", e); }
    else if (e.t === "portao" && e.estado === "passou") abertos.delete("portao");
    else if ((e.t === "revisor" || e.t === "qa") && e.veredito !== "SEM VEREDITO") { if (e.veredito === "APROVADO") abertos.delete(e.t); else reprova(e.t, e); }
  }
  return [...abertos.values()];
}

/** O bloco que vai numa volta ao agente. A sessão pode nunca ter visto este parecer: com as rodadas esgotadas, ele só foi para o log. */
export const textoDosPareceres = (abertos) => [
  "## A conferência do board reprovou, e nada aprovou depois",
  "O parecer vem aqui inteiro, com os passos de reprodução: não precisa procurar no log. Confira cada defeito; o que já estiver consertado, não mexa de novo.",
  ...abertos.flatMap((a) => ["", pedidoDeConserto(a.papel, a.texto, a.comando)]),
].join("\n");

/** O bloco de ENTREGA: com PR (o dono revisa e mescla) ou direto na pasta. */
export function deliveryRules(task, project) {
  if (task.entrega !== "pr" && task.entrega !== "deploy") {
    return [
      "ENTREGA: direto na pasta, SEM Pull Request.",
      "- Não faça push, não abra PR, não crie repositório. Se achar que o trabalho merece PR, diga no resumo.",
    ];
  }
  const g = gitInfo(project.dir);
  const base = g.repo
    ? (g.remote
        ? `O projeto já é repositório git (branch atual: ${g.branch || "?"}) e tem remoto: ${g.remote}.`
        : `O projeto é repositório git (branch atual: ${g.branch || "?"}) mas NÃO tem remoto "origin" — crie com: gh repo create ${project.slug} --private --source=. --remote=origin --push`)
    : `A pasta AINDA NÃO É repositório git. Antes de qualquer coisa: git init -b main → escreva/confira o .gitignore → confira com "git status" o que entraria → primeiro commit → gh repo create ${project.slug} --private --source=. --remote=origin --push`;
  const prBranch = branchDoPr(task, project);
  return [
    task.prUrl ? "ENTREGA: ATUALIZAR O PULL REQUEST QUE JÁ EXISTE. VOCÊ NUNCA MESCLA E NUNCA ABRE OUTRO PR."
      : "ENTREGA: abrir PULL REQUEST. VOCÊ NUNCA MESCLA.",
    task.entrega === "deploy"
      ? "Esta tarefa está no modo MESCLAR E PUBLICAR: quem mescla e quem publica é o BOARD, por comando declarado pelo dono, e só depois do portão verde e do revisor APROVADO. Você abre o PR e para por aí."
      : "Quem revisa e mescla é o dono.",
    base,
    g.sujo ? "⚠️ A pasta tem mudanças não commitadas do dono. Não as apague nem as inclua sem dizer; se atrapalharem, pare e avise." : "",
    "Sequência:",
    ...(task.prUrl ? [
      // ⚠️ Rodada de conserto com "branch NOVA" abre PR novo a cada volta: a #127 deixou TRÊS (22/09/2026).
      `0. Esta tarefa JÁ TEM Pull Request aberto: ${task.prUrl}. ELE é a entrega — não abra outro.`,
      `1. Volte para a branch dele e continue nela: \`gh pr checkout ${task.prUrl}\`${prBranch ? ` (branch \`${prBranch}\`)` : ""}. Nunca crie outra branch nem commite em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê) e push NA MESMA branch — o PR se atualiza sozinho. NUNCA `gh pr create` de novo.",
      project.principal
        ? "3. NÃO volte para main: esta cópia é descartável e o board a remove sozinho. Responda com a URL do PR (a mesma) no resumo."
        : "3. Depois do push: `git checkout main` — deixe a pasta na branch principal para o próximo. Responda com a URL do PR (a mesma) no resumo.",
    ] : project.principal ? [
      // 🔴 Em cópia (worktree) a branch principal está EM USO pela pasta do dono: `git checkout main`
      // aqui morre com "already checked out at ...". A cópia já nasceu do origin/main atualizado,
      // então não há o que puxar — e puxar seria justamente o passo que travava quando a pasta
      // do dono tinha trabalho sem commit.
      "0. Esta CÓPIA já nasceu a partir do `origin/main` atualizado — não há nada a puxar. NUNCA rode `git checkout main` nem `git pull` aqui: em cópia (worktree) a branch principal pertence à pasta do dono e o comando falha.",
      `1. Crie a branch aqui mesmo, a partir de onde você já está: \`git checkout -b board/${task.id}-<3-a-5-palavras-do-assunto>\`. Nunca commite em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê), `git push -u origin <a-sua-branch>`, e `gh pr create` com título e corpo explicando o que mudou e como testar.",
      "3. NÃO volte para main: esta cópia é descartável e o board a remove sozinho. Responda com a URL do PR no resumo.",
    ] : [
      "0. ANTES de qualquer edição: `git checkout main && git pull --ff-only origin main` (a branch principal local fica para trás a cada PR mesclado; quem começa de uma branch velha abre PR em cima de código velho). Se o pull falhar por árvore suja ou divergência, PARE e avise — não force.",
      `1. Trabalhe numa branch NOVA a partir da main atualizada: board/${task.id}-<3-a-5-palavras-do-assunto>. Nunca commite direto em main/master.`,
      "2. Ao terminar: commit com mensagem clara (o porquê, não só o quê), push da branch, e `gh pr create` com título e corpo explicando o que mudou e como testar.",
      "3. Depois do push: `git checkout main` — deixe a pasta na branch principal para o próximo. Responda com a URL do PR no resumo.",
    ]),
    "🔴 Segredos: .env, chave, token e credencial NUNCA entram no commit — ponha no .gitignore antes do primeiro commit. Se um arquivo assim já estiver rastreado no repositório, PARE e avise o dono em vez de dar push.",
    "🔴 Nunca `gh pr merge`, nunca push forçado, nunca push na branch principal.",
    task.prUrl ? "🔴 UM PR por tarefa. Se achar que o trabalho não cabe no PR aberto, PARE e avise o dono em vez de abrir outro." : "",
    "Repositório novo nasce PRIVADO (--private). Se por algum motivo precisar ser público, pare e pergunte.",
  ].filter(Boolean);
}

/**
 * O pedido fixo da vigia dos PRs (#279). Mesma sessão: o agente sabe o que fez, e as regras de entrega já dizem
 * "atualizar o PR que existe". Mesclar a main, nunca rebase: rebase pediria push forçado, que as regras proíbem.
 */
export function pedidoAtualizarPr(task, url, numero, { motivo, falhos = [], mesclado }) {
  const tronco = [
    `1. \`gh pr checkout ${url}\` e \`git fetch origin\`.`,
    "2. `git merge origin/main`. Merge, sem rebase e sem reescrever histórico.",
  ];
  const fim = [
    "Rode os testes do projeto.",
    "`git push` na MESMA branch, sem --force nem --force-with-lease.",
    `Confira: \`gh pr view ${url} --json mergeable -q .mergeable\` tem de dizer MERGEABLE (logo depois do push pode dizer UNKNOWN: espere alguns segundos e repita).`,
  ];
  const passos = motivo === "checks" ? [
    `O Pull Request desta tarefa (#${task.id}, "${task.title}") está com check do CI FALHANDO: ${falhos.join(", ")}.`,
    `Conserte no MESMO PR, ${url}:`,
    ...tronco,
    "3. Veja o que falhou (`gh pr checks " + url + "`, `gh run view <id> --log-failed`) e conserte na causa. Não desligue teste nem afrouxe o CI.",
    ...fim.map((l, i) => `${i + 4}. ${l}`),
    "Se a falha não vem deste PR (já falha na main, serviço fora do ar), não mexa: diga isso no resumo.",
  ] : [
    `O Pull Request desta tarefa (#${task.id}, "${task.title}") ficou em CONFLITO com a main${mesclado ? ` depois do merge do PR #${mesclado}` : ""}.`,
    `Atualize o MESMO PR, ${url}:`,
    ...tronco,
    "3. Resolva cada conflito MANTENDO AS DUAS MUDANÇAS: a da main e a desta tarefa. Leia o que a main trouxe antes de decidir. Se as duas não podem conviver, pare e diga exatamente por quê; não escolha uma sozinho.",
    ...fim.map((l, i) => `${i + 4}. ${l}`),
  ];
  return [...passos, "", "Não refaça a tarefa e não acrescente nada além disso. 🔴 Nunca abra outro PR, nunca mescle, nunca force push. Responda com a URL do PR (a mesma) no resumo."].join("\n");
}

export function houseRules(task, project) {
  return [
    `Você está executando a tarefa #${task.id} do BOARD do dono${DONO}, na pasta do projeto "${project.slug}" (${project.dir}).`,
    ...(project.principal ? [
      `Você é o agente #${task.agente}, numa CÓPIA isolada (worktree git) deste projeto — a pasta principal é a bancada do dono e pode ter trabalho dele sem commit. Trabalhe SÓ em ${project.dir}; nunca mexa na pasta principal (${project.principal})${task.paralelo ? "; ⚡ outros agentes podem estar em outras cópias ao mesmo tempo" : ""}.`,
      task.worktree?.producao || task.prUrl ? "" : "Não faça commit, branch nem push: quando a conferência aprovar, o board junta o seu trabalho na pasta principal.",
    ].filter(Boolean) : []),
    "Regras da casa:",
    "- Leia o CLAUDE.md do projeto antes de mexer. Trabalhe direto nesta pasta.",
    `- Projeto de PRODUÇÃO${PRODUCAO.length ? " (" + PRODUCAO.join(", ") + ")" : ""}: NUNCA deploy, NUNCA mudança em banco — o portão é sempre o PR que o dono revisa. Publicar (o 🚀 do board, /api/publicar) é só o dono, pelo clique.`,
    "- Não invente número nem promessa. Se travar em algo que só o dono decide, pare e diga exatamente o que falta.",
    "- Teste instável ou problema FORA do escopo da tarefa: anote no resumo e siga. Não pare para investigar — o portão do board confere a suíte. (Uma tarefa já gastou os 45 min inteiros investigando teste instável e não entregou.)",
    SEM_PKILL,
    "- Ao terminar, responda com um resumo curto (3–8 linhas): o que fez, o que verificou (comandos/testes) e o que ficou pendente.",
    "Interface e textos em português do Brasil; código em inglês.",
    "",
    ...deliveryRules(task, project),
  ].join("\n");
}

/**
 * Onde está o trabalho a revisar. Depois que o agente abre o PR, a pasta pode estar de volta na
 * branch principal e limpa — `git diff` sozinho não mostra nada e o revisor "aprovaria o vazio".
 * Com PR aberto, o diff certo é o da branch dele contra a principal.
 */
export function branchDoPr(task, project) {
  if (!task.prUrl) return "";
  try {
    return execFileSync("gh", ["pr", "view", task.prUrl, "--json", "headRefName", "-q", ".headRefName"],
      { cwd: project.dir, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; /* sem gh ou PR inacessível: segue sem o nome da branch */ }
}

export function ondeEstaOTrabalho(task, project) {
  if (!task.prUrl) return "";
  const branch = branchDoPr(task, project);
  return [`O trabalho JÁ está no Pull Request ${task.prUrl}${branch ? ` (branch \`${branch}\`)` : ""}.`,
    branch ? `A pasta pode estar de volta na branch principal e limpa — o diff que vale é \`git diff origin/main...${branch}\` (ou \`gh pr diff ${task.prUrl}\`).` :
      `Use \`gh pr diff ${task.prUrl}\` para ver o que mudou.`].join(" ");
}

/** A régua dos dois papéis e o formato que `lerParecer` lê (#300). */
const CLASSIFICAR = [
  "Classifique CADA defeito que achar:",
  "- GRAVE (reprova): segurança; isolamento entre empresas; perda ou vazamento de dado; documento fiscal ou valor errado; função pedida que não funciona; produção quebrada; teste instável em arquivo da entrega.",
  "- MENOR (não reprova): caso raro, texto, aparência, entrada improvável, melhoria.",
  "- Na dúvida entre as duas, é GRAVE.",
  "Veredito: REPROVADO se houver um GRAVE; APROVADO se não houver nenhum, mesmo com menores. Menor não volta para o agente: vai para o dono decidir.",
];
const formatoDoParecer = (evidencia, comoGrave) => [
  "Responda assim: a PRIMEIRA LINHA é exatamente APROVADO ou REPROVADO.",
  evidencia,
  "TERMINE SEMPRE com os dois blocos abaixo, nesta ordem, sem nada depois. Cada bloco lista itens com `- ` ou diz `nenhum`:",
  "GRAVES:", `- ${comoGrave}`,
  "MENORES:", "- o que é e onde, em uma linha",
  "Sem os dois blocos legíveis o board conta como REPROVADO, mesmo com APROVADO na primeira linha.",
];

/** As regras do REVISOR: ele lê o que mudou e dá veredito. Não escreve código. */
export function reviewerRules(task, project) {
  return [
    `Você é o REVISOR do board, revisando a tarefa #${task.id} no projeto "${project.slug}" (${project.dir}).`,
    "NÃO escreva nem altere arquivo nenhum. Não faça commit, push, PR nem merge. Você só lê e julga.",
    "🔴 PROIBIDO mexer na árvore de trabalho: nada de `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`.",
    "Um stash que não volta apaga o trabalho do agente. Para ver o estado anterior use só leitura: `git diff`, `git show HEAD:<arquivo>`.",
    SEM_PKILL,
    SEM_SEGUNDO_PLANO,
    ondeEstaOTrabalho(task, project),
    "Como revisar: veja o que mudou (`git status`, `git log --oneline -5`, `git diff` da branch contra a principal)",
    "e leia os arquivos tocados. Confira contra o CLAUDE.md do projeto.",
    "O portão JÁ rodou a verificação do projeto e passou; não repita a suíte inteira várias vezes. Rode no máximo UM comando de teste, focado no que mudou.",
    "Procure DEFEITO DE VERDADE: quebra de regra da casa, isolamento/segurança furados, teste que não morde,",
    "número inventado, segredo commitado, promessa no resumo que o código não cumpre.",
    "Estilo e gosto pessoal NÃO reprovam.",
    ...CLASSIFICAR,
    ...formatoDoParecer("Depois, no máximo 8 linhas de evidência, antes dos blocos.", "exatamente o que consertar"),
  ].join("\n");
}

/**
 * As regras do QA: ele TENTA QUEBRAR o que foi entregue, rodando de verdade — o revisor lê, o QA
 * executa. Não escreve no projeto: o único que escreve código é o agente (duas mãos na mesma pasta
 * se atropelam). Sonda e teste descartável vão para fora do repositório.
 */
export function qaRules(task, project) {
  return [
    `Você é o QA do board, testando a entrega da tarefa #${task.id} no projeto "${project.slug}" (${project.dir}).`,
    "Seu trabalho é TENTAR QUEBRAR o que foi entregue, executando de verdade. O revisor já leu o código; você roda.",
    "🔴 NÃO altere arquivo do projeto, não faça commit, push, PR nem merge. Sonda, script ou teste descartável só FORA do repositório (ex.: /tmp).",
    "🔴 PROIBIDO mexer na árvore de trabalho: nada de `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`.",
    SEM_PKILL,
    SEM_SEGUNDO_PLANO,
    "O que fazer, nesta ordem e sem se alongar (orçamento: uns 15 minutos):",
    ondeEstaOTrabalho(task, project),
    "1. Veja o que mudou (`git status`, `git diff`, ou `gh pr diff` se houver PR) e leia o CLAUDE.md do projeto.",
    "2. Exercite a mudança como um usuário e como um atacante: entrada vazia, enorme e inválida; outro tenant; papel sem permissão; repetir e disparar ao mesmo tempo. Use o que for executável: testes focados, chamadas à API, scripts em /tmp.",
    "3. INSTABILIDADE: rode os arquivos de teste que a tarefa criou ou alterou 5 vezes seguidas. Falha intermitente nesses arquivos é defeito DESTA entrega (reprova). Falha em arquivo que a tarefa não tocou é instabilidade PRÉ-EXISTENTE: anote e NÃO reprove por ela.",
    "Reprove só por defeito real, reproduzível e GRAVE. Estilo, gosto e melhoria opcional não reprovam.",
    ...CLASSIFICAR,
    ...formatoDoParecer("Depois, no máximo 10 linhas de evidência, antes dos blocos. Se houver instabilidade pré-existente, cite numa linha separada, fora dos blocos.", "o passo exato que reproduz (comando), o que aconteceu e o que devia acontecer"),
  ].join("\n");
}
