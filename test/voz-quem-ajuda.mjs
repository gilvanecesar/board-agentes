// O comum dos testes de "só a voz do dono" (#298): um motor FALSO que diz a nota que o teste mandar.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { preparar, wavDeAmostra } from "./voz-ajuda.mjs";

// Lê o WAV pela entrada, como o de verdade. A nota vem de $HOME/quem-nota (vetor [n, √(1-n²)] contra a impressão [1, 0]); "quebrado" sai com erro.
export const MOTOR_FALSO = `#!/usr/bin/env node
const fs=require("fs"),{join}=require("path"),H=process.env.HOME,modo=process.argv[2];
fs.writeFileSync(join(H,"quem-pid"),String(process.pid));
const ler=(n,d)=>{try{return fs.readFileSync(join(H,n),"utf8").trim()}catch{return d}};
let n=0;process.stdin.on("data",(d)=>n+=d.length).on("end",async()=>{
  fs.appendFileSync(join(H,"quem.log"),"stdin "+modo+" "+n+"\\n");
  const demora=Number(ler("quem-demora",0));if(demora)await new Promise((r)=>setTimeout(r,demora*1000));
  const nota=ler("quem-nota","0.9");if(nota==="quebrado"){console.error("sem memória");process.exit(3)}
  if(n<44||process.env.QUEM_FALSO_FORMATO)process.exit(2);
  if(modo==="cadastro")return console.log(JSON.stringify({vetor:[1,0],seg:Number(ler("quem-seg",28)),janelas:{curtas:[0.1,0.5,0.6],longas:[0.7,0.8]}}));
  const x=Number(nota);console.log(JSON.stringify({vetor:[x,Math.sqrt(1-x*x)],seg:Number(ler("quem-trecho-seg",3))}));
});
`;
export const CADASTRO = wavDeAmostra([[220, 2000]]);

export async function comQuem(opcoes = {}) {
  const p = await preparar({ ...opcoes, quem: MOTOR_FALSO, env: { BOARD_VOZ_CADASTRO_S: "2", ...opcoes.env } });
  const H = p.caixa.home;
  return { ...p, nota: (n) => writeFileSync(join(H, "quem-nota"), String(n)), quemSeg: (s) => writeFileSync(join(H, "quem-seg"), String(s)) };
}
export async function pedirQuem(b, metodo, rota, corpo, origem = b.url) {
  const r = await fetch(b.url + rota, { method: metodo, headers: { "content-type": "application/octet-stream", ...(origem ? { origin: origem } : {}) }, body: corpo });
  return { status: r.status, json: await r.json().catch(() => null) };
}
export const cadastrar = async (b) => { const r = await pedirQuem(b, "POST", "/api/voz/impressao", CADASTRO); if (r.status !== 200) throw new Error("cadastro: " + JSON.stringify(r)); return r.json; };
export const ajustar = (b, nivel) => pedirQuem(b, "POST", "/api/voz/impressao/ajuste", JSON.stringify({ nivel }));
