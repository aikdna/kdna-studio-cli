'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const ROOT = fs.mkdtempSync(path.join(process.env.KDNA_CLI_TEST_ROOT || os.tmpdir(), 'numeric308-termination-'));
const BIN = process.env.KDNA_CLI_TEST_BIN || path.resolve(__dirname, '../../bin/kdna-studio.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PRELOAD = path.join(ROOT, 'observe.cjs');
fs.writeFileSync(PRELOAD, `
const fs = require('node:fs');
const events = [];
for (const name of ['end','close','error']) process.stdin.on(name, error => events.push({event:name,at:new Date().toISOString(),code:error?.code}));
if (process.env.NUMERIC308_INPUT_FAULT) {
  let injected = false;
  const stream = process.env.NUMERIC308_INPUT_FAULT_STAGE === 'human' ? process.stderr : process.stdout;
  const write = stream.write;
  stream.write = function(chunk, ...rest) {
    const result = write.call(this, chunk, ...rest);
    let trigger = stream === process.stderr;
    if (!trigger) {
      const value = JSON.parse(String(chunk));
      const stage = process.env.NUMERIC308_INPUT_FAULT_STAGE;
      trigger = stage === 'interpret' ? value.event === 'human_reply' : stage === 'confirmed' ? Boolean(value.result?.final_decision?.artifact_digest) : Boolean(value.result?.directory);
    }
    if (!injected && trigger) {
      injected = true;
      queueMicrotask(() => process.stdin.destroy(process.env.NUMERIC308_INPUT_FAULT === 'error' ? Object.assign(new Error('synthetic native input error'), {code:'NUMERIC308_INJECTED_INPUT'}) : undefined));
    }
    return result;
  };
}
process.once('beforeExit', code => fs.writeFileSync(process.env.NUMERIC308_EXIT_FILE, JSON.stringify({
  code,pid:process.pid,events,inputs:process._getActiveHandles().filter(x=>x!==process.stdout&&x!==process.stderr).map(x=>({type:x.constructor.name,fd:x.fd})),
  requests:process._getActiveRequests().map(x=>x.constructor.name)
})));
`);
const material = path.join(ROOT, 'notes.md');
fs.writeFileSync(material, 'NUMERIC308全新合成材料：借阅归还时间不清楚时保留原登记，核对借阅人和登记记录后再补充。');
let number = 0;
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NUMERIC308_TEST_OBSERVATION_BOUND')), 5000); })]).finally(() => clearTimeout(timer));
}
class Session {
  constructor(fault, faultStage = 'human') {
    this.name = 'case-' + (++number); this.output = path.join(ROOT, this.name + '-bundle');
    this.exitFile = path.join(ROOT, this.name + '-exit.json'); this.records = []; this.events = []; this.errors = [];
    this.stdout = ''; this.stderr = ''; this.id = 0; this.start = new Date().toISOString(); this.parentHumanEndRequested = false;
    const env = { ...process.env, NUMERIC308_EXIT_FILE: this.exitFile };
    if (fault) { env.NUMERIC308_INPUT_FAULT = fault; env.NUMERIC308_INPUT_FAULT_STAGE = faultStage; }
    this.argv = ['-i', ...Object.entries(env).map(([k,v])=>k+'='+v), '/bin/sh', '-c', 'exec "$@"', 'numeric308-child',
      process.execPath, '--require', PRELOAD, BIN, 'session', '--out', this.output, '--text', material, '--human-fd', '3', '--synthetic-fixture'];
    this.child = spawn('/usr/bin/env', this.argv, {stdio:['pipe','pipe','pipe','pipe']});
    for (const [stream,name] of [[this.child.stdin,'agent-writer'],[this.child.stdio[3],'human-writer']]) stream.on('error', error=>this.errors.push({name,code:error.code}));
    this.child.stdout.on('data', b=>{this.stdout+=b;}); this.child.stderr.on('data', b=>{this.stderr+=b;});
    this.lines = readline.createInterface({input:this.child.stdout})[Symbol.asyncIterator]();
    this.exit = new Promise(resolve=>this.child.on('close',(code,signal)=>{this.closed=true;resolve({code,signal});}));
  }
  async next() { const next = await bounded(this.lines.next()); assert.equal(next.done,false,this.stderr); const event=JSON.parse(next.value);this.events.push(event);return event; }
  raw(bytes) { this.records.push({at:new Date().toISOString(),channel:'agent',bytes:Buffer.byteLength(bytes)}); this.child.stdin.write(bytes); }
  send(op,data={}) { const frame={id:'numeric308-'+(++this.id),op,data};this.records.push({channel:'agent-frame',frame});this.child.stdin.write(JSON.stringify(frame)+'\n'); }
  async op(op,data) { this.send(op,data);const event=await this.next();assert.equal(event.status,'ok');return event.result; }
  human(text) { this.records.push({channel:'synthetic-human',text});this.child.stdio[3].write(text+'\n'); }
  endHuman() { this.parentHumanEndRequested = true; this.records.push({event:'parent-human-end-request'}); this.child.stdio[3].end(); }
  async prompt(kind) {
    if (kind==='interview') this.send('interview',{title:'终止相位合成访谈',question:'NUMERIC308 请描述保留登记的方法。'});
    else this.send('review');
    await bounded((async()=>{while(!this.stderr)await delay(5);})());
  }
  async review(kind,candidates) {
    this.send('review');this.human(kind==='confirm'?'我确认当前展示的合成预览。':'我选择这一条合成候选。');
    const event=await this.next();assert.equal(event.event,'human_reply');
    const data={replyTo:event.replyTo,kind};if(candidates)data.candidates=candidates;
    this.send('interpret',data);assert.equal((await this.next()).status,'ok');
  }
  async prepare(confirm=true) {
    await this.op('brief',{title:'合成借阅登记','scope':'仅本次测试'});
    await this.op('propose',{title:'先保留再复核',subject:'模糊归还时间',scope:'这份合成记录',statement:'保留原登记，核对借阅人与登记记录后补充。',rationale:'单次记忆不足以覆盖来源。',materials:[1]});
    await this.review('select',[1]);await this.op('preview');if(confirm)await this.review('confirm');
  }
  async endAgent() {
    this.records.push({at:new Date().toISOString(),event:'parent-end-request'});
    await bounded(new Promise(resolve=>this.child.stdin.end(resolve)));
    this.records.push({at:new Date().toISOString(),event:'parent-end-callback',notChildEOF:true});
  }
  async finish(code,expectedError,exported=false) {
    const result=await bounded(this.exit);
    const observation=JSON.parse(fs.readFileSync(this.exitFile));
    const parentWriterEnded=this.child.stdio[3].writableEnded;
    this.child.stdio[3].destroy();
    const capture={name:this.name,pid:this.child.pid,bin:BIN,argv:['/usr/bin/env',...this.argv],start:this.start,end:new Date().toISOString(),result,
      stdout:this.stdout,stderr:this.stderr,records:this.records,events:this.events,parentWriterEndedBeforeParentCleanup:parentWriterEnded,parentHumanEndRequested:this.parentHumanEndRequested,writerErrors:this.errors,observation,synthetic:true};
    fs.writeFileSync(path.join(ROOT,this.name+'.json'),JSON.stringify(capture,null,2)+'\n');
    assert.equal(result.code,code,this.stderr);assert.equal(result.signal,null);assert.deepEqual(observation.inputs,[]);assert.deepEqual(observation.requests,[]);
    if(expectedError)assert.match(this.stderr,new RegExp(expectedError));
    assert.equal(fs.existsSync(this.output),exported);
    if(exported)assert.deepEqual(fs.readdirSync(this.output).sort(),['asset.kdna','binding.json','complete.json','creation-evidence.json','verification.json']);
    return capture;
  }
  async cleanup() {
    if(!this.closed) { this.child.kill('SIGKILL'); await this.exit; fs.writeFileSync(path.join(ROOT,this.name+'-FAILED-CLEANUP.json'),JSON.stringify({stdout:this.stdout,stderr:this.stderr,records:this.records,forcedExit:true})); }
    this.child.stdio[3].destroy();
  }
}
async function run(callback,fault,faultStage) {
  const session=new Session(fault,faultStage);
  try {assert.equal((await session.next()).event,'ready');await callback(session);}
  finally {await session.cleanup();}
}
for(const phase of ['idle','interview','review','interpret','preview','confirmed']) {
  test('Agent EOF abandons '+phase+' without waiting for the human writer',()=>run(async s=>{
    if(phase==='interview'||phase==='review')await s.prompt(phase);
    if(phase==='interpret') {await s.prompt('review');s.human('先记录这条合成意见。');assert.equal((await s.next()).event,'human_reply');}
    if(phase==='preview'||phase==='confirmed')await s.prepare(phase==='confirmed');
    await s.endAgent();
    const capture=await s.finish(2,phase==='interpret'?'CLI_AGENT_CHANNEL_CLOSED':'CLI_SESSION_UNEXPORTED');
    assert.equal(capture.parentHumanEndRequested,false);
    assert.ok(capture.observation.events.some(x=>x.event==='end'),'Actual child EOF must be observed');
  }));
}
for(const phase of ['interview','review']) {
  test('healthy slow human remains able to complete '+phase,()=>run(async s=>{
    await s.prompt(phase);await delay(300);assert.equal(s.closed,undefined);
    s.human('合成回复：保留原登记，暂不确认。');
    const event=await s.next();
    if(phase==='review') {assert.equal(event.event,'human_reply');s.send('interpret',{replyTo:event.replyTo,kind:'note'});assert.equal((await s.next()).status,'ok');}
    else assert.equal(event.status,'ok');
    await s.endAgent();await s.finish(2,'CLI_SESSION_UNEXPORTED');
  }));
  test('human EOF rejects pending '+phase+' with Agent writer still open',()=>run(async s=>{
    await s.prompt(phase);s.endHuman();const capture=await s.finish(2,'CLI_HUMAN_CHANNEL_CLOSED');
    assert.equal(capture.records.some(x=>x.event==='parent-end-request'),false);
  }));
  for (const malformed of ['partial','invalid']) test('human '+malformed+' frame rejects pending '+phase,()=>run(async s=>{
    await s.prompt(phase);
    s.child.stdio[3].write(malformed==='partial' ? Buffer.from('unterminated') : Buffer.from([255,10]));
    if(malformed==='partial')s.endHuman();
    await s.finish(2,malformed==='partial'?'CLI_FRAME_INCOMPLETE':'CLI_UTF8_INVALID');
  }));
  for(const fault of ['error','close']) test('native Agent '+fault+' cancels '+phase,()=>run(async s=>{
    await s.prompt(phase);const capture=await s.finish(2,fault==='error'?'NUMERIC308_INJECTED_INPUT':'CLI_AGENT_CHANNEL_CLOSED');
    assert.ok(capture.observation.events.some(x=>x.event===fault));
  },fault));
}
for(const fault of ['error','close']) {
  test('native Agent '+fault+' ends interpretation wait',()=>run(async s=>{
    await s.prompt('review');s.human('合成审查意见，不是导出授权。');assert.equal((await s.next()).event,'human_reply');
    await s.finish(2,fault==='error'?'NUMERIC308_INJECTED_INPUT':'CLI_AGENT_CHANNEL_CLOSED');
  },fault,'interpret'));
  test('native Agent '+fault+' after confirmation prevents a later export',()=>run(async s=>{
    await s.prepare();await s.finish(2,fault==='error'?'NUMERIC308_INJECTED_INPUT':'CLI_AGENT_CHANNEL_CLOSED');
  },fault,'confirmed'));
  test('native Agent '+fault+' after committed export does not undo the bundle',()=>run(async s=>{
    await s.prepare();assert.equal((await s.op('export')).verification.status,'consistent');await s.finish(0,undefined,true);
  },fault,'exported'));
}
test('queued request is discarded on Agent EOF during human wait',()=>run(async s=>{
  await s.prompt('interview');s.send('status');await s.endAgent();const capture=await s.finish(2,'CLI_SESSION_UNEXPORTED');
  assert.equal(capture.stdout.split('\n').filter(Boolean).length,1);
}));
test('excess pending frames reject while human remains silent',()=>run(async s=>{
  await s.prompt('interview');s.raw('{"id":"a","op":"status","data":{}}\n{"id":"b","op":"status","data":{}}\n');
  await s.finish(2,'CLI_INPUT_QUEUE_LIMIT');
}));
test('partial frame EOF cancels human wait without recording an answer',()=>run(async s=>{
  await s.prompt('interview');s.raw('{"id":"partial"');await s.endAgent();await s.finish(2,'CLI_FRAME_INCOMPLETE');
}));
test('invalid UTF8 cancels human wait',()=>run(async s=>{
  await s.prompt('review');s.raw(Buffer.from([255,10]));await s.finish(2,'CLI_UTF8_INVALID');
}));
test('over-limit incomplete Agent frame cancels human wait',()=>run(async s=>{
  await s.prompt('interview');s.raw('x'.repeat(1024*1024+1));await s.finish(2,'CLI_FRAME_LIMIT');
}));
test('exactly 1 MiB frame remains accepted',()=>run(async s=>{
  const frame={id:'',op:'status',data:{}};frame.id='x'.repeat(1024*1024-Buffer.byteLength(JSON.stringify(frame)));
  const raw=JSON.stringify(frame);assert.equal(Buffer.byteLength(raw),1024*1024);s.raw(raw+'\n');assert.equal((await s.next()).status,'ok');
  await s.endAgent();await s.finish(2,'CLI_SESSION_UNEXPORTED');
}));
test('late human bytes after observed child EOF cannot revive or export',()=>run(async s=>{
  await s.prompt('interview');await s.endAgent();await bounded(s.exit);
  s.human('晚到的合成回答不能恢复会话。');s.send('export');await delay(10);
  const capture=await s.finish(2,'CLI_SESSION_UNEXPORTED');
  assert.ok(capture.observation.events.some(x=>x.event==='end'));
  assert.equal(capture.events.filter(x=>x.status==='ok').length,0);assert.equal(fs.existsSync(s.output),false);
}));
test('completed export remains complete after caller Agent end',()=>run(async s=>{
  await s.prepare();const result=await s.op('export');assert.equal(result.verification.status,'consistent');
  if(!s.child.stdin.destroyed)await s.endAgent();await s.finish(0,undefined,true);
}));
test.after(()=>console.log(JSON.stringify({numeric308_evidence_root:ROOT,scenarios:number,observation_bound_is_not_public_timeout:true})));
