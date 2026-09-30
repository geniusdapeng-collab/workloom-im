import pg from "pg";
import { envOf, memberToken } from "./jwt.mjs";
const BASE="http://127.0.0.1:8921", REPO="/Users/mac/WorkLoom-fleet/.wt-mcd-c";
const env=envOf(REPO); const db=new pg.Client({connectionString:env.DATABASE_URL}); await db.connect();
const m=await db.query(`SELECT m.id,m.member_no,m.name,m.role,w.tenant_id FROM members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.workspace_id='ws-yunqi' AND m.member_no='MEM-001'`);
const t=memberToken(env.JWT_SECRET,{memberId:m.rows[0].id,memberNo:m.rows[0].member_no,name:m.rows[0].name,role:m.rows[0].role,tenantId:m.rows[0].tenant_id,workspaceId:"ws-yunqi"});
const st=a=>{const s=[...a].sort((x,y)=>x-y);const at=q=>s[Math.min(s.length-1,Math.floor(q*s.length))];return{n:s.length,p50:+at(.5).toFixed(1),p95:+at(.95).toFixed(1),max:+s[s.length-1].toFixed(1)}};
const call=async(p,i)=>{const h={"content-type":"application/json",authorization:`Bearer ${t}`};const s=performance.now();const r=await fetch(`${BASE}/trpc/${p}${i?`?input=${encodeURIComponent(JSON.stringify(i))}`:""}`,{headers:h});await r.text();return performance.now()-s};
for (const [name,fn] of Object.entries({
  "threads.list":()=>call("threads.list"),
  "approvals.list(pending)":()=>call("approvals.list",{status:"pending"}),
  "captain.theater":()=>call("captain.theater"),
})){ for(let i=0;i<5;i++) await fn(); const s=[]; for(let i=0;i<40;i++) s.push(await fn()); console.log(name, JSON.stringify(st(s))); }
const vol=await db.query(`SELECT count(*)::int n FROM biz_events`); console.log("biz_events total:", vol.rows[0].n);
await db.end();
