"use strict";
// CLI-only material ordinal adapter. Shared component meaning remains upstream.
function componentOperations(workspace,materialIds){
 const fail=code=>{throw Object.assign(new Error(code),{code});};
 function record(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(v,k)))fail('CLI_COMPONENT_INPUT_INVALID');}
 function authored(a){if(!a||!Array.isArray(a.materials)||Object.hasOwn(a,'materialRefs'))fail('CLI_COMPONENT_MATERIAL_INVALID');const ids=typeof materialIds==='function'?materialIds():materialIds;const x={...a,materialRefs:a.materials.map(n=>{if(!Number.isSafeInteger(n)||n<1||n>ids.length)fail('CLI_MATERIAL_UNKNOWN');return ids[n-1];})};delete x.materials;return x;}
 return Object.freeze({
  propose(data){record(data,['localKey','alternatives']);if(!Array.isArray(data.alternatives))fail('CLI_COMPONENT_INPUT_INVALID');return workspace.agent.propose({localKey:data.localKey,alternatives:data.alternatives.map(authored)});},
  revise(data){record(data,['localKey','baseRevision','alternatives','explanation']);if(!Array.isArray(data.alternatives))fail('CLI_COMPONENT_INPUT_INVALID');return workspace.agent.revise(data.localKey,{baseRevision:data.baseRevision,alternatives:data.alternatives.map(authored),explanation:data.explanation});},
  preview(){return workspace.agent.compilePreview();},review(){return workspace.receiveAdoptionReply();},completeSavedReadback(bytes){return workspace.completeSave(bytes);},abort(){return workspace.abort();}
 });
}
module.exports={componentOperations};
