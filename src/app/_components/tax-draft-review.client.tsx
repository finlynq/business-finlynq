"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TaxDraftRow } from "@/modules/tax/draft-service";

function label(key:string){return key.replaceAll("_"," ").replace(/([a-z])([A-Z])/g,"$1 $2");}
export function TaxReviewValues({value}:{value:unknown}){
 if(value===null || value===undefined)return <span>None</span>;
 if(typeof value!=="object")return <span style={{overflowWrap:"anywhere"}}>{String(value)}</span>;
 if(Array.isArray(value))return value.length?<ul>{value.map((entry,index)=><li key={index}><TaxReviewValues value={entry}/></li>)}</ul>:<span>None</span>;
 return <dl>{Object.entries(value).map(([key,entry])=><div key={key}><dt>{label(key)}</dt><dd><TaxReviewValues value={entry}/></dd></div>)}</dl>;
}
export function TaxDraftReview({draft,dirty,canManage,onChange}:{draft:TaxDraftRow;dirty:boolean;canManage:boolean;onChange:(draft:TaxDraftRow)=>void}){
 const router=useRouter();const[busy,setBusy]=useState(false);const[error,setError]=useState("");const[reason,setReason]=useState(draft.reason);
 const command=useRef({fingerprint:"",key:""});
 async function act(action:"REVIEW"|"LOCK"|"DISCARD"|"RESTORE"|"CORRECT"){
  if(busy)return;setBusy(true);setError("");
  const fields={kind:draft.kind,action,draftId:draft.draft_id,expectedVersion:draft.version,reason, ...(action==="LOCK"?{reviewHash:draft.review_hash}:{})};
  const fingerprint=JSON.stringify(fields);if(command.current.fingerprint!==fingerprint)command.current={fingerprint,key:crypto.randomUUID()};
  try{const response=await fetch("/api/tax/drafts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...fields,idempotencyKey:command.current.key})});
   const payload=await response.json();if(!response.ok)throw new Error(payload.error??"The draft action could not be completed.");
   if(action==="CORRECT")router.push(`/app/tax?draft=${encodeURIComponent(payload.draft.draft_id)}`);
   else{onChange(payload.draft);router.refresh();}
  }catch(e){setError(e instanceof Error?e.message:"The draft action failed.");}finally{setBusy(false);}
 }
 return <section className="panel" aria-label="Tax draft review" onChangeCapture={event=>event.stopPropagation()}>
  <h2>{draft.kind.toLowerCase()} draft · revision {draft.version} · {draft.state.toLowerCase()}</h2>
  <p>Draft {draft.draft_id}. Recorded by {draft.created_by} at <time dateTime={new Date(draft.created_at).toISOString()}>{new Date(draft.created_at).toISOString()}</time>.</p>
  {draft.correction_of_draft_id&&<p>Corrects locked draft {draft.correction_of_draft_id}. The original remains unchanged.</p>}
  <p>Review lock does not submit a return or close an accounting period. A locked mapping needs a separate filing configuration before use.</p>
  {dirty&&<p role="status">Inputs have changed. Save draft again before reviewing or locking.</p>}
  <details open={draft.state==="REVIEWED"}><summary>Exact saved inputs and review</summary><TaxReviewValues value={draft.review??draft.payload}/></details>
  {draft.result&&<><h3>Committed version</h3><TaxReviewValues value={draft.result}/></>}
  {canManage&&<><label>Review or correction reason<input value={reason} minLength={8} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
   <div className="form-actions">
    {draft.state==="DRAFT"&&<button type="button" disabled={busy||dirty||reason.trim().length<8} onClick={()=>void act("REVIEW")}>Review changes</button>}
    {draft.state==="REVIEWED"&&<button type="button" disabled={busy||dirty||reason.trim().length<8} onClick={()=>void act("LOCK")}>Lock version</button>}
    {["DRAFT","REVIEWED"].includes(draft.state)&&<button type="button" disabled={busy||reason.trim().length<8} onClick={()=>void act("DISCARD")}>Discard draft</button>}
    {draft.state==="DISCARDED"&&<button type="button" disabled={busy||reason.trim().length<8} onClick={()=>void act("RESTORE")}>Restore draft</button>}
    {draft.state==="LOCKED"&&<button type="button" disabled={busy||reason.trim().length<8} onClick={()=>void act("CORRECT")}>Create corrected version</button>}
   </div></>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
