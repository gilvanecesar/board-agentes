// O que cada papel recebe por escrito: regras da casa, de entrega (direto/PR/cópia), do revisor e do QA.
import { execFileSync } from "child_process";
import { DONO, PRODUCAO } from "./config.mjs";
import { gitInfo } from "./projetos.mjs";
   // id → processo do portão

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

export function houseRules(task, project) {
  return [
    `Você está executando a tarefa #${task.id} do BOARD do dono${DONO}, na pasta do projeto "${project.slug}" (${project.dir}).`,
    ...(project.principal ? [
      `Você é o agente #${task.agente}, numa CÓPIA isolada (worktree git) deste projeto — a pasta principal é a bancada do dono e pode ter trabalho dele sem commit. Trabalhe SÓ em ${project.dir}; nunca mexa na pasta principal (${project.principal})${task.paralelo ? "; ⚡ outros agentes podem estar em outras cópias ao mesmo tempo" : ""}.`,
      task.worktree?.producao ? "" : "Não faça commit, branch nem push: quando a conferência aprovar, o board junta o seu trabalho na pasta principal.",
    ].filter(Boolean) : []),
    "Regras da casa:",
    "- Leia o CLAUDE.md do projeto antes de mexer. Trabalhe direto nesta pasta.",
    `- Projeto de PRODUÇÃO${PRODUCAO.length ? " (" + PRODUCAO.join(", ") + ")" : ""}: NUNCA deploy, NUNCA mudança em banco — o portão é sempre o PR que o dono revisa.`,
    "- Não invente número nem promessa. Se travar em algo que só o dono decide, pare e diga exatamente o que falta.",
    "- Teste instável ou problema FORA do escopo da tarefa: anote no resumo e siga. Não pare para investigar — o portão do board confere a suíte. (Uma tarefa já gastou os 45 min inteiros investigando teste instável e não entregou.)",
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

/** As regras do REVISOR: ele lê o que mudou e dá veredito. Não escreve código. */
export function reviewerRules(task, project) {
  return [
    `Você é o REVISOR do board, revisando a tarefa #${task.id} no projeto "${project.slug}" (${project.dir}).`,
    "NÃO escreva nem altere arquivo nenhum. Não faça commit, push, PR nem merge. Você só lê e julga.",
    "🔴 PROIBIDO mexer na árvore de trabalho: nada de `git stash`, `git checkout`, `git reset`, `git clean`, `git restore`.",
    "Um stash que não volta apaga o trabalho do agente. Para ver o estado anterior use só leitura: `git diff`, `git show HEAD:<arquivo>`.",
    ondeEstaOTrabalho(task, project),
    "Como revisar: veja o que mudou (`git status`, `git log --oneline -5`, `git diff` da branch contra a principal)",
    "e leia os arquivos tocados. Confira contra o CLAUDE.md do projeto.",
    "O portão JÁ rodou a verificação do projeto e passou; não repita a suíte inteira várias vezes. Rode no máximo UM comando de teste, focado no que mudou.",
    "Procure DEFEITO DE VERDADE: quebra de regra da casa, isolamento/segurança furados, teste que não morde,",
    "número inventado, segredo commitado, promessa no resumo que o código não cumpre.",
    "Estilo e gosto pessoal NÃO reprovam.",
    "Responda assim: a PRIMEIRA LINHA é exatamente APROVADO ou REPROVADO.",
    "Depois, no máximo 8 linhas. Se reprovou, diga exatamente o que consertar, em itens.",
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
    "O que fazer, nesta ordem e sem se alongar (orçamento: uns 15 minutos):",
    ondeEstaOTrabalho(task, project),
    "1. Veja o que mudou (`git status`, `git diff`, ou `gh pr diff` se houver PR) e leia o CLAUDE.md do projeto.",
    "2. Exercite a mudança como um usuário e como um atacante: entrada vazia, enorme e inválida; outro tenant; papel sem permissão; repetir e disparar ao mesmo tempo. Use o que for executável: testes focados, chamadas à API, scripts em /tmp.",
    "3. INSTABILIDADE: rode os arquivos de teste que a tarefa criou ou alterou 5 vezes seguidas. Falha intermitente nesses arquivos é defeito DESTA entrega (reprova). Falha em arquivo que a tarefa não tocou é instabilidade PRÉ-EXISTENTE: anote e NÃO reprove por ela.",
    "Reprove só por defeito real e reproduzível. Estilo, gosto e melhoria opcional não reprovam.",
    "Responda assim: a PRIMEIRA LINHA é exatamente APROVADO ou REPROVADO.",
    "Depois, no máximo 10 linhas. Para cada defeito: o passo exato que reproduz (comando), o que aconteceu e o que devia acontecer. Se houver instabilidade pré-existente, cite numa linha separada.",
  ].join("\n");
}
