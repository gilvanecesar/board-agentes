// Modo voz (#286): o que se entende do que foi dito (comando, invenção do whisper, eco) e o texto que o board fala. Funções puras.
import { VOZ_NOME } from "./config.mjs";
import { VOCABULARIO } from "./ditado.mjs";

// Sem partir um par de surrogates: a metade solta derruba o encodeURIComponent do cabeçalho da fala.
const cut = (t, n) => { t = String(t); return t.length > n ? t.slice(0, n).replace(/[\ud800-\udbff]$/, "") : t; };
// ── O que foi dito ────────────────────────────────────────────────────────────
const normal = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const palavras = (t) => normal(t).match(/[a-z0-9]+/g) || [];
const so = (t) => palavras(t).join(" ");

// Frase INTEIRA, nunca pedaço: "explica o modo voz" é mensagem, não comando. Repetir vale ("espera, espera").
const LIGAR = /^(ok |oi |ei |board |central )*(modo vo[zs]|vamos conversar|liga a voz|ligar a voz)( por favor)?$/;
const DESLIGAR = /^(ok |ei |board |central )*(modo texto|para( ai)? de falar|pare de falar|desliga a voz|desligar a voz|desliga o modo voz)( por favor)?$/;
const CORTE = "(espera|espere|perai|pera|para|pare|parou|chega|basta|silencio|calma|um momento|so um momento)";
const CORTAR = new RegExp(`^(ok |ei )*${CORTE}( ${CORTE})*( ai| por favor)?$`);
// Só com o board falando: o que o whisper fez de "espera" e "para" ditos soltos (medido na #286). Nesse momento, sozinhas, essas
// frases são quase sempre o corte; fora dele são mensagem, e "paz" ou "está aí" não podem calar nada.
const ESCUTADO = "(espero|eu espero|esta ai|paz|pai)";
const CORTAR_FALANDO = new RegExp(`^${ESCUTADO}( ${ESCUTADO})*$`);
export function comandoDeVoz(texto, { falando = false } = {}) {
  const t = so(texto);
  if (LIGAR.test(t)) return "ligar";
  if (DESLIGAR.test(t)) return "desligar";
  return CORTAR.test(t) || (falando && CORTAR_FALANDO.test(t)) ? "cortar" : null;
}

// Trecho curto é quase sempre comando, e o whisper com o vocabulário geral errava ("Malovos.", "Mal o texto."). Com as frases dos
// comandos no fim do --prompt ele acerta (medido com o Piper, ver CLAUDE.md), mas em ruído DEVOLVE esse prompt ("Vamos conversar.
// Espera."). Por isso este prompt nunca decide se houve fala: ver `transcreverTrecho` em voz.mjs.
export const PROMPT_CURTO = `Board, Loja, ERP, CRM, ${VOZ_NOME}, PR, deploy. Modo voz. Modo texto. Vamos conversar. Para de falar. Espera. Para.`;
const CURTO_S = 4.5; // a pausa de 3 s (o máximo) + o que vem antes da fala + uma frase curta
const BYTES_S = 32000; // WAV 16 kHz mono de 16 bits
export const trechoCurto = (bytes) => bytes <= CURTO_S * BYTES_S + 44;
/** O que o vocabulário geral ouviu pode ser um comando mal entendido? Nenhum comando tem mais de 4 palavras (mal ouvidas, não mais que isso). */
export const podeSerComando = (texto) => palavras(texto).length <= 4;

const distancia = (a, b) => {
  let linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const nova = [i];
    for (let j = 1; j <= b.length; j++) nova[j] = Math.min(linha[j] + 1, nova[j - 1] + 1, linha[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    linha = nova;
  }
  return linha[b.length];
};
/**
 * O que a 1ª passada ouviu pode ser `frase` mal ouvida? Cada palavra da frase tem de bater em pelo menos metade das letras com um
 * pedaço do que foi ouvido, em ordem, e sem sobrar nada: "Mal o texto." e "Malovos." passam; "mais texto", "pode falar", "vai
 * conversar", "chega de falar" e "um" são frases legíveis de outra coisa (QA: viravam comando e a mensagem sumia). Na frase inteira
 * a distância não separa os dois casos: "mal o texto" e "mais texto" estão ambas a 2–3 letras de "modo texto".
 */
export function pareceFrase(ouvido, frase) {
  const alvo = palavras(frase), texto = palavras(ouvido).join("");
  if (!alvo.length || texto.length > 40) return false;
  const cabe = (i, p) => {
    if (p === alvo.length) return i === texto.length;
    for (let j = i; j <= texto.length; j++) if (distancia(texto.slice(i, j), alvo[p]) <= Math.floor(alvo[p].length / 2) && cabe(j, p + 1)) return true;
    return false;
  };
  return cabe(0, 0);
}

// ── A palavra de chamada (#305) ───────────────────────────────────────────────
// O nome tem de ABRIR a frase, no máximo depois de um chamamento. "e" e "em" são o "Ei" como o whisper escreve (6 de 12 na medição).
// "o" fica de fora de propósito: "O Atena caiu" é falar DO servidor.
const CHAMAMENTO = new Set(["ei", "e", "em", "oi", "ok", "ola", "opa", "hey"]);
const PALAVRA = /[\p{L}\p{N}]+/gu;
const NOME_PARTIDO = 3; // o whisper pode partir o nome ("Sa turno")
/**
 * A frase começa com o nome? Devolve `resto`, o que vem depois dele. Compara sem acento e tolera UMA letra (ver a medição em CLAUDE.md):
 * o nome vem da configuração, então não há lista de formas de um nome só.
 */
export function lerChamada(texto, nome = VOZ_NOME) {
  const alvo = palavras(nome).join(""), todas = [...String(texto).matchAll(PALAVRA)];
  let i = 0;
  while (i < todas.length - 1 && CHAMAMENTO.has(so(todas[i][0]))) i++;
  for (let n = 1, juntas = ""; n <= NOME_PARTIDO && i + n <= todas.length; n++) {
    juntas += so(todas[i + n - 1][0]);
    if (distancia(juntas, alvo) > (n === 1 ? 1 : 0)) continue; // partido, só exato: "O Atena" juntaria em "osaturno", a uma letra do nome
    const u = todas[i + n - 1], resto = String(texto).slice(u.index + u[0].length).replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return { citou: true, resto: resto.charAt(0).toUpperCase() + resto.slice(1), texto };
  }
  return { citou: false, resto: "", texto };
}

// O que o whisper inventa em silêncio e ruído: fórmula de legenda de vídeo, som entre colchetes, o --prompt devolvido.
// Só vale a transcrição INTEIRA: "muda a legenda da tabela de fretes" é pedido do dono, e sumir com ele seria calado.
const FORMULA = "(legendas? (pela|por|da) comunidade( do)? amara( org)?|legendad[oa] pela comunidade( do)? amara( org)?|obrigad[oa] por assistir( ao video)?|inscreva se( no canal)?|tchau tchau)";
const SO_FORMULA = new RegExp(`^${FORMULA}( ${FORMULA})*$`);
const DO_VOCABULARIO = new Set(palavras(VOCABULARIO));
export function ehInvencaoDoWhisper(texto) {
  const p = palavras(String(texto).replace(/\[[^\]]*\]|\([^)]*\)|♪/g, " "));
  if (!p.length || p.join("").length < 2) return true;
  if (SO_FORMULA.test(p.join(" "))) return true;
  return p.length >= 4 && p.every((w) => DO_VOCABULARIO.has(w)); // devolveu o --prompt
}

/** O microfone pegou a própria fala do board (o eco que sobrou): quase tudo o que ouviu estava no que ele estava falando. */
export function ehEco(ouvido, falado) {
  const o = palavras(ouvido), f = new Set(palavras(falado));
  return o.length >= 2 && o.filter((w) => f.has(w)).length / o.length >= 0.7;
}

// ── O texto da fala: a resposta escrita continua inteira na tela ──────────────
const TIROU = "\u0001"; // onde saiu um link ou código: frase que fica sem substância ("Veja e.") não se fala
const semMarcas = (t) => String(t)
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/https?:\/\/\S+/g, TIROU)
  .replace(/`([^`\n]*)`/g, (_, c) => /[\/\\=(){}<>$]|^\S+\.\w{1,5}$|^-/.test(c) || c.length > 32 ? TIROU : c)
  .replace(/(^|\s)~?\/[\w.-]+(\/[\w.-]+)+/g, "$1" + TIROU)
  .replace(/\baprova[cç][aã]o #?[0-9a-f]{12}\b/gi, "")
  .replace(/\b[0-9a-f]{7,40}\b/g, (h) => /\d/.test(h) && /[a-f]/.test(h) ? "" : h)
  .replace(/\bR\d+\b/g, "")
  .replace(/\b\d{7,}\b/g, "")
  .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
  .replace(/[*_~>|]+|#(?!\d)/g, " ")
  .replace(/\s*\(([^()]{1,80})\)/g, ", $1,") // parêntese vira pausa, como se fala
  .replace(/\s+[—–]\s+/g, ", ");

/** Tira do markdown o que não se ouve (tabela, código, link) e diz quanto ficou de fora. */
function linhasFalaveis(md) {
  let cerca = false;
  const out = [];
  for (const crua of String(md).split("\n")) {
    const l = crua.trim();
    if (/^(```|~~~)/.test(l)) { cerca = !cerca; continue; }
    if (cerca) continue;
    if (/^\|.*\|$/.test(l) || /^[|:\s-]{3,}$/.test(l) && l.includes("-")) continue; // tabela
    if (/^\s*PEDIDO DE SIM/i.test(l.replace(/^[\s>*_-]+/, ""))) continue; // vai no fim, inteiro
    if (!l) continue;
    if (/^#{1,6}\s/.test(l)) continue; // título não se fala: "Resumo." solto soa a robô lendo a tela
    out.push(l.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, ""));
  }
  return { linhas: out };
}
// Número de tarefa: um só se fala ("tarefa 286"); uma lista deles não se ouve e fica na tela.
const semListaDeTarefas = (frase) => {
  const n = frase.match(/#\d+/g) || [];
  return n.length > 1 ? frase.replace(/\s*#\d+(\s*(,|e|a)\s*#\d+)*/g, "").replace(/[:,;]\s*([.!?])/g, "$1") : frase.replace(/#(\d+)/g, "$1");
};

// Ponto só termina frase seguido de espaço ou do fim: em 1.500,00, 2.4.0 e board.env ele é parte da palavra, e nada se descarta.
const FRASE = /(?:[^.!?]|[.!?](?=\S))+(?:[.!?]+(?=\s|$)|$)/g;

export function textoDaFala(markdown, pedidoSim = null, max = Number(process.env.BOARD_VOZ_FALA_MAX || 420)) { // ~25 s de voz
  const { linhas } = linhasFalaveis(markdown);
  const corrido = linhas.map((l) => semMarcas(l).replace(/\s+/g, " ").trim()).filter(Boolean).map((l) => /[.!?:;]$/.test(l) ? l : l + ".").join(" ");
  const frases = corrido.match(FRASE)?.map((f) => semListaDeTarefas(f.trim()).replace(/\s+([,.!?])/g, "$1").trim()).filter((f) => /[a-zà-ú0-9]/i.test(f)) || [];
  const sobra = frases.filter((f) => !f.includes(TIROU) || palavras(f).length > 4).map((f) => f.replaceAll(TIROU, "").replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").replace(/,+(?=[,.!?:;]|$)/g, "").replace(/^,\s*/, ""));
  const fala = [];
  let usados = 0;
  for (const f of sobra) {
    if (fala.length && usados + f.length > max) break;
    fala.push(usados + f.length > max ? cut(f, max).replace(/\s+\S*$/, "") + "." : f);
    usados += f.length;
  }
  let texto = fala.join(" ");
  if (pedidoSim) {
    const limpo = semMarcas(pedidoSim), perdeu = limpo.includes(TIROU); // link, caminho ou código não se leem: quem aprova vê na tela
    const acao = limpo.replaceAll(TIROU, " ").replace(/#(\d+)/g, "$1").replace(/\s+/g, " ").trim().replace(/\s*[.!:,;]+$/, "");
    texto = `${texto} ${acao ? `Preciso do seu sim para: ${acao}.` : "Preciso do seu sim."}${perdeu ? " A ação completa está na tela." : ""} Aprove no botão Aprovar da tela: sim falado não vale.`.trim();
  } else if (!texto) texto = "A resposta está na tela.";
  return texto;
}

// ── Como se fala (só o que vai ao Piper; a tela mostra o texto como está) ──────
// O espeak lê "02/11" como "zero dois onze", "5 min" como "cinco min", "US$ 0,15" como "U S cifrão zero vírgula quinze" e
// "→" como "seta à direita" (conferido com o piper_phonemize, #313). Aqui vira o que um colega diria.
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const um = (n, sing, plur) => `${n} ${Number(String(n).replace(/\./g, "")) === 1 ? sing : plur}`;
function dinheiro(inteiro, cent, real) {
  const c = cent ? Number(cent.padEnd(2, "0")) : 0, centavos = c ? um(c, "centavo", "centavos") : "";
  if (!Number(inteiro.replace(/\./g, ""))) return centavos ? centavos + (real ? "" : " de dólar") : real ? "zero real" : "zero dólar";
  return um(inteiro, real ? "real" : "dólar", real ? "reais" : "dólares") + (centavos ? " e " + centavos : "");
}
const hora = (h, m) => {
  const hh = Number(h), nome = hh === 1 ? "uma" : String(hh);
  return Number(m) ? `${nome} e ${Number(m)}` : hh === 1 ? "uma hora" : `${nome} horas`;
};
const SIGLAS = [[/\bPRs\b/g, "pê erres"], [/\bPR\b/g, "pê erre"], [/\bCT-e\b/gi, "cê tê é"], [/\bMDF-e\b/gi, "ême dê éfe é"], [/\bQA\b/g, "quê á"],
  [/\bAPIs?\b/g, "a pê í"], [/\bJSON\b/gi, "jêisson"], [/\bURLs?\b/g, "u erre ele"], [/\bCLI\b/g, "cê ele í"], [/\bOK\b/g, "ok"], [/\bPDFs?\b/g, "pê dê éfe"]];
const UNIDADES = [["ms", "milissegundo", "milissegundos"], ["min", "minuto", "minutos"], ["s", "segundo", "segundos"], ["h", "hora", "horas"],
  ["KB", "kilobyte", "kilobytes"], ["MB", "mega", "megas"], ["GB", "giga", "gigas"], ["TB", "tera", "teras"]];
export function paraPronuncia(t) {
  let s = String(t)
    .replace(/\b(R|US)\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g, (_, m, i, c) => dinheiro(i, c, m === "R"))
    .replace(/\bUS\$/g, "dólares").replace(/\bR\$/g, "reais")
    .replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (x, d, m, a) => {
      if (!(Number(d) >= 1 && Number(d) <= 31 && Number(m) >= 1 && Number(m) <= 12) || (!a && (d.length < 2 || m.length < 2))) return x; // 3/4 é fração
      return `${Number(d) === 1 ? "primeiro" : Number(d)} de ${MESES[Number(m) - 1]}${a ? " de " + (a.length === 2 ? "20" + a : a) : ""}`;
    })
    .replace(/\b([01]?\d|2[0-3])(?::|h)([0-5]\d)\b/g, (_, h, m) => hora(h, m))
    .replace(/\b([01]?\d|2[0-3])h\b/g, (_, h) => hora(h, "00"));
  for (const [u, sing, plur] of UNIDADES) s = s.replace(new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s?${u}\\b`, "g"), (_, n) => /,/.test(n) ? `${n} ${plur}` : um(n, sing, plur));
  s = s.replace(/\b(\d+)\s?[x×]\b/g, (_, n) => um(n, "vez", "vezes")).replace(/(\d)\s*×\s*(\d)/g, "$1 vezes $2")
    .replace(/\s*(?:→|->|=>)\s*/g, " para ").replace(/[~≈]\s*(?=\d)/g, "uns ").replace(/\s\+\s/g, " mais ").replace(/\s&\s/g, " e ")
    .replace(/\bvs\.?(?=\s)/gi, "contra").replace(/\be\.g\./gi, "por exemplo").replace(/\bi\.e\./gi, "ou seja")
    .replace(/(\p{L})\/(\p{L})/gu, "$1 ou $2");
  return SIGLAS.reduce((x, [re, por]) => x.replace(re, por), s);
}
