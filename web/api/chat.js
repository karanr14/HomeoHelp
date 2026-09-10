import fs from "node:fs";
import path from "node:path";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const CSV_PATH = new URL("./sbl_indications.csv", import.meta.url);

function parseCSV(text){
  const lines=text.trim().split(/\r?\n/); const headers=split(lines.shift());
  return lines.map(line=>{const cells=split(line),o={};headers.forEach((h,i)=>o[h.trim()]=cells[i]??"");return o});
}
function split(line){let a=[],cur="",q=false;for(let i=0;i<line.length;i++){let c=line[i];if(c=='"')q=!q;else if(c==","&&!q){a.push(cur.replace(/^"|"$/g,"").replace(/""/g,'"'));cur=""}else cur+=c}a.push(cur.replace(/^"|"$/g,"").replace(/""/g,'"'));return a}
function words(s){return [...new Set((s||"").toLowerCase().match(/[a-z]{3,}/g)||[])];}
function rank(rows,query,answers=[]){
 const terms=words(query+" "+answers.join(" "));
 return rows.map(row=>{const text=Object.values(row).join(" ").toLowerCase();let score=0;terms.forEach(t=>{if(text.includes(t))score+=1});return {...row,_score:score}})
 .filter(x=>x._score>0).sort((a,b)=>b._score-a._score).slice(0,12);
}
function cleanJSON(s){return s.replace(/```json|```/g,"").trim()}
async function askAI(message,state,candidates){
 const prompt=`You are an educational dataset narrowing assistant. You are NOT a doctor. Do not diagnose, prescribe, recommend treatment, or claim a dataset entry is medically suitable.
Your only task is to help narrow DATABASE ENTRIES using the user's words and the supplied candidate records.

User message: ${message}
Previous answers: ${(state.answers||[]).join(" | ")||"none"}
Candidate records:
${JSON.stringify(candidates.map(x=>({product_name:x.product_name,indications:x.indications})))}

Ask exactly ONE short, neutral follow-up question that best separates the remaining records. Only ask about a characteristic represented in the candidate records. Do not ask for information already given. Prefer a question that can eliminate several candidates.
Return ONLY valid JSON:
{"action":"question","question":"...","options":["option 1","option 2","Not sure"]}
If fewer than 3 meaningfully different candidates remain, return:
{"action":"results"}`;
 const res=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.GROQ_API_KEY},
 body:JSON.stringify({model:MODEL,temperature:0.2,max_tokens:220,response_format:{type:"json_object"},messages:[{role:"system",content:"Return JSON only."},{role:"user",content:prompt}]})});
 if(!res.ok) throw new Error("AI provider error: "+await res.text());
 const data=await res.json(); return JSON.parse(cleanJSON(data.choices[0].message.content));
}

export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"POST only"});
 try{
  if(!process.env.GROQ_API_KEY)throw new Error("Missing GROQ_API_KEY environment variable");
  const {message,state={history:[],answers:[],turn:0}}=req.body||{};
  if(!message)throw new Error("Missing message");
  const rows=parseCSV(fs.readFileSync(CSV_PATH,"utf8"));
  const answers=[...(state.answers||[]),message];
  const root=(state.rootQuery||message);
  const candidates=rank(rows,root,answers).slice(0,10);
  if(!candidates.length)return res.status(200).json({type:"results",results:[],state:{rootQuery:root,answers,turn:state.turn+1}});
  if(state.turn>=5||candidates.length<=3)return res.status(200).json({type:"results",results:candidates.slice(0,5),state:{rootQuery:root,answers,turn:state.turn+1}});
  const ai=await askAI(message,{...state,answers},candidates);
  const newState={rootQuery:root,answers,turn:state.turn+1};
  if(ai.action==="results")return res.status(200).json({type:"results",results:candidates.slice(0,5),state:newState});
  return res.status(200).json({type:"question",question:ai.question,options:ai.options||["Yes","No","Not sure"],state:newState});
 }catch(e){return res.status(500).json({error:e.message||"Server error"})}
}