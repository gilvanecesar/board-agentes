// O Kokoro FALSO dos testes do modo voz (#314, #327): um "python" que fala o protocolo do voz-kokoro.py e anota cada pedido.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { preparar } from "./voz-ajuda.mjs";

// "python" falso: responde {"pronto"} ao subir e, a cada linha, um WAV de verdade (24 kHz, $HOME/kokoro-ms ou 300 ms).
export const KOKORO = `#!/usr/bin/env node
const fs=require("fs"),{join}=require("path"),H=process.env.HOME;
fs.appendFileSync(join(H,"kokoro-pids"),process.pid+"\\n");
if(fs.existsSync(join(H,"kokoro-quebrado"))){process.stderr.write("ModuleNotFoundError: torch\\n");process.exit(3);}
const out=(c,d)=>{process.stdout.write(JSON.stringify(c)+"\\n");if(d)process.stdout.write(d);};
out({pronto:true});let resto="";
process.stdin.on("data",(x)=>{resto+=x;let i;while((i=resto.indexOf("\\n"))>=0){const l=resto.slice(0,i);resto=resto.slice(i+1);const p=JSON.parse(l);
fs.appendFileSync(join(H,"kokoro.log"),JSON.stringify({...p,args:process.argv.slice(2),cuda:process.env.CUDA_VISIBLE_DEVICES,offline:process.env.HF_HUB_OFFLINE})+"\\n");
if(p.voz==="pm_santa"&&fs.existsSync(join(H,"santa-erro"))){out({ok:false,erro:"falhou"});continue;}
const fim=()=>{const ms=Number(fs.existsSync(join(H,"kokoro-ms"))?fs.readFileSync(join(H,"kokoro-ms"),"utf8"):300),n=Math.round(ms*24),b=Buffer.alloc(44+n*2);
b.write("RIFF",0);b.writeUInt32LE(36+n*2,4);b.write("WAVEfmt ",8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write("data",36);b.writeUInt32LE(n*2,40);
out({ok:true,bytes:b.length,ms:5,seg:ms/1000},b);};
const demora=Number(fs.existsSync(join(H,"kokoro-demora"))?fs.readFileSync(join(H,"kokoro-demora"),"utf8"):0);if(demora){process.stdin.pause();setTimeout(()=>{fim();process.stdin.resume();},demora);}else fim();}});
`;
export async function comKokoro(opcoes = {}) {
  const r = await preparar(opcoes);
  const k = join(r.caixa.raiz, "voz", "kokoro");
  mkdirSync(join(k, "env", "bin"), { recursive: true }); mkdirSync(join(k, "pesos", "voices"), { recursive: true });
  writeFileSync(join(k, "env", "bin", "python"), KOKORO, { mode: 0o755 });
  writeFileSync(join(k, "pesos", "kokoro-v1_0.pth"), "pesos");
  for (const v of ["pf_dora", "pm_alex", "pm_santa"]) writeFileSync(join(k, "pesos", "voices", v + ".pt"), "voz");
  writeFileSync(join(k, "pesos", "voices", "af_heart.pt"), "voz em inglês: não entra");
  return r;
}
