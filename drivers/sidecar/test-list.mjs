import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const proc = spawn(process.execPath, [path.join(dir, "sidecar.mjs")], { stdio: ["pipe","pipe","pipe"] });
let buf="", id=0; const pending=new Map();
function send(c){ const rid=`r${++id}`; c.requestId=rid; proc.stdin.write(JSON.stringify(c)+"\n"); return new Promise(r=>pending.set(rid,r)); }
proc.stdout.on("data",(c)=>{buf+=c;let i;while((i=buf.indexOf("\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let o;try{o=JSON.parse(l)}catch{continue}if(o.type==="response"){const r=pending.get(o.requestId);if(r){pending.delete(o.requestId);r(o)}}}});
proc.stderr.on("data",(c)=>process.stderr.write(c));
try {
  await send({ type:"init", cwd:"L:/projects/PI-GUI", sessionMode:"recent" });
  const res = await send({ type:"list_sessions" });
  console.log("list_sessions success:", res.success);
  const ss = res.data?.sessions ?? [];
  console.log("会话数:", ss.length);
  for (const s of ss.slice(0,3)) console.log(" -", s.firstMessage?.slice(0,30), "| msgs:", s.messageCount, "| 修改:", s.modified);
  await send({ type:"exit" });
  process.exit(res.success && ss.length > 0 ? 0 : 1);
} catch(e){ console.error(e); process.exit(1); }
