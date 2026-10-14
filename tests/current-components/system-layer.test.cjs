"use strict";
// The `system` op through the real CLI: a two-judgment session declares the
// system layer, exports, and the CLI's own read of the completed bundle shows
// the shared declarations and the relation. A provided boundaries key is a
// named refusal and the session stays unexported.
const test=require("node:test"),assert=require("node:assert/strict"),{spawn}=require("node:child_process"),fs=require("node:fs"),path=require("node:path");
const base=path.resolve(process.env.STUDIO_TEST_PACKAGE_ROOT||path.resolve(__dirname,"../..")),bin=path.join(base,"bin/kdna-studio.js"),root=path.resolve(process.env.STUDIO_TEST_ARTIFACT_ROOT||path.join(__dirname,".artifacts",String(process.pid)));fs.mkdirSync(root,{recursive:true});let serial=0;
function run(argv,label){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[bin,...argv],{cwd:base,stdio:["pipe","pipe","pipe","pipe"]});let out="",err="",partial="";const events=[];const timer=setTimeout(()=>p.kill("SIGTERM"),15000);p.stdout.on("data",b=>{out+=b;partial+=b;let k;while((k=partial.indexOf("\n"))>=0){const line=partial.slice(0,k);partial=partial.slice(k+1);try{events.push(JSON.parse(line));}catch{}}});p.stderr.on("data",b=>err+=b);p.stdin.on("error",()=>{});p.stdio[3].on("error",()=>{});p.on("error",reject);p.on("close",code=>{clearTimeout(timer);resolve({code,out,err,events});});run.last=p;});}
const alt=(key,statement)=>({localKey:key,title:"Candidate "+key,subject:"A synthetic observation",scope:"Declared scope only",statement,rationale:"Stated basis for the synthetic candidate.",materials:[1],method:{method:{term:"feeling"},components:[{localKey:"states",type:"taxonomy",method:{term:"feeling"},role:"个人感受",statement:"The authored preference rests on an actual felt priority.",content:{items:[{key:"known",title:"Observed",meaning:"Input observation is present."}],broader:[]}}]}});
function create({boundaries=false}={}){
  const label="system-"+(++serial),folder=path.join(root,label);fs.mkdirSync(folder);
  const source=path.join(folder,"material.txt");fs.writeFileSync(source,"PRIVATE_SYSTEM_SOURCE_"+label);
  const delegation=path.join(folder,"delegation.json");fs.writeFileSync(delegation,JSON.stringify({coordinate:"fixture:authorized-local-agent",statement:"Synthetic provider execution only, no real editorial acceptance."}));
  const bundle=path.join(folder,"bundle");
  const promise=run(["session","--out",bundle,"--text",source,"--synthetic-fixture","--agent-adoption-fd","3","--delegation-record",delegation],label);
  const p=run.last;let buffer="";
  const send=(id,op,data)=>p.stdin.write(JSON.stringify({id,op,data})+"\n");
  const declaration={worldview:{statement:"How the synthetic work reads a case.",items:["Practice before novelty."]},value_order:{statement:"Ordering for the synthetic disagreement.",items:["Boundary first."]},relations:[{localKey:"rel-support",kind:"support",from:"system-b",to:"system-a",statement:"The boundary judgment backs the earlier choice."}],...(boundaries?{boundaries:[{statement:"Out of scope for this work."}]}:{})};
  p.stdout.on("data",b=>{buffer+=b;let k;while((k=buffer.indexOf("\n"))>=0){const raw=buffer.slice(0,k);buffer=buffer.slice(k+1);let e;try{e=JSON.parse(raw);}catch{continue;}
    if(e.event==="ready")send("brief","brief",{title:"CLI system fixture",scope:"Independent process synthetic integration.",highest_question:"Which choice carries the author's ordering?"});
    else if(e.id==="brief")send("proposal-a","propose",{localKey:"system-a",alternatives:[alt("a-preserve","Retain unknown when evidence is absent."),alt("a-infer","Treat absence as a negative.")]});
    else if(e.id==="proposal-a")send("proposal-b","propose",{localKey:"system-b",alternatives:[alt("b-preserve","Keep the boundary until the author decides."),alt("b-infer","Move the boundary immediately.")]});
    else if(e.id==="proposal-b")send("declare","system",declaration);
    else if(e.id==="declare"){send("select-review","review",{});p.stdio[3].write("Select the preserve alternatives.\n");}
    else if(e.event==="adoption_reply")send("interpret-"+e.replyTo,"interpret",{replyTo:e.replyTo,kind:e.review?.preview?"confirm":"select",...(e.review?.preview?{}:{choices:[{judgmentLocalKey:"system-a",alternativeLocalKey:"a-preserve"},{judgmentLocalKey:"system-b",alternativeLocalKey:"b-preserve"}]})});
    else if(e.id==="select-review")send("preview","preview",{});
    else if(e.id==="preview"){send("confirm-review","review",{});p.stdio[3].write("Confirm this preview.\n");}
    else if(e.id==="confirm-review")send("export","export",{});
  }});
  return {promise,bundle,label};
}
test("the system op exports and the bundle read carries the declared system layer",async()=>{
  const {promise,bundle,label}=create();
  const finished=await promise;
  assert.equal(finished.code,0,finished.err);
  const bytes=fs.readFileSync(path.join(bundle,"asset.kdna"));
  assert.equal(bytes.includes(Buffer.from("PRIVATE_SYSTEM_SOURCE_")),false);
  const read=await run(["read","--bundle",bundle,"--allow-read","--judgment","1","--budget","1048576"],label+"-read");
  assert.equal(read.code,0,read.err);
  const content=read.events[0].envelope.content;
  const shared=content.closure.filter(entry=>entry.role==="shared_declaration").map(entry=>({kind:entry.value.kind,value:entry.value.value}));
  assert.deepEqual(shared.map(entry=>entry.kind).sort(),["value_order","worldview"]);
  assert.deepEqual(shared.find(entry=>entry.kind==="value_order").value,["Boundary first."]);
  const relations=content.closure.filter(entry=>entry.role==="relationship").map(entry=>({kind:entry.value.kind.term,roles:entry.value.participants.map(p=>p.role.term)}));
  assert.deepEqual(relations,[{kind:"support",roles:["supporter","claim"]}]);
});
test("a provided boundaries key is a named refusal and leaves no bundle",async()=>{
  const {promise,bundle}=create({boundaries:true});
  const finished=await promise;
  assert.equal(finished.code,2);
  assert.match(finished.err,/CREATION_BOUNDARIES_ACTOR_REQUIRED/);
  assert.equal(fs.existsSync(bundle),false);
});
