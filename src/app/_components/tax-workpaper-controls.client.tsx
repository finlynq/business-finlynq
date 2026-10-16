"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TaxReviewValues } from "./tax-draft-review.client";
import type { previewTaxWorkpaperControl } from "@/modules/tax/workpaper-controls";
type Preview=Awaited<ReturnType<typeof previewTaxWorkpaperControl>>;
export function TaxWorkpaperControls({filingId,canManage}:{filingId:string;canManage:boolean}){
 const router=useRouter();const[preview,setPreview]=useState<Preview|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState("");
 const[action,setAction]=useState<"DELETE"|"RESTORE"|"REVIEW"|"LOCK">("REVIEW");const[reason,setReason]=useState("");const[confirmation,setConfirmation]=useState("");
 const command=useRef({fingerprint:"",key:""});
 async function inspect(){setBusy(true);setError("");try{const response=await fetch(`/api/tax/filings/controls/preview?filingId=${encodeURIComponent(filingId)}`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error??"Report details could not be loaded.");setPreview(data);setAction(data.deleted?"RESTORE":data.canManageDeletion?"DELETE":"REVIEW");setConfirmation("");}catch(e){setError(e instanceof Error?e.message:"Preview failed.");}finally{setBusy(false);}}
 const expected=`${action} ${filingId}`;
 const canPerformAction=!!preview&&canManage&&(action==="DELETE"?preview.eligible:action==="RESTORE"?preview.deleted&&preview.canManageDeletion:!preview.deleted);
 async function commit(){if(!preview||!canPerformAction)return;setBusy(true);setError("");const fields={filingId,action,expectedVersion:preview.version,previewHash:preview.previewHash,reason,confirmation};
  const fingerprint=JSON.stringify(fields);if(command.current.fingerprint!==fingerprint)command.current={fingerprint,key:crypto.randomUUID()};
  try{const response=await fetch("/api/tax/filings/controls",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...fields,idempotencyKey:command.current.key})});const data=await response.json();if(!response.ok)throw new Error(data.error??"The workpaper action failed.");setPreview(null);setConfirmation("");router.refresh();}catch(e){setError(e instanceof Error?e.message:"The workpaper action failed.");}finally{setBusy(false);}
 }
 return <div className="form-footnote"><button type="button" disabled={busy} onClick={()=>void inspect()}>Report actions</button>
 {preview&&<section aria-label="Tax report actions"><h3>{preview.workpaper.entityName} · {preview.workpaper.periodStart} – {preview.workpaper.periodEnd}</h3><p>Report ID: {filingId}</p>
 <p>{preview.retention}</p><p>{preview.submissionState}</p><details><summary>Report details and history</summary><TaxReviewValues value={preview.workpaper}/><h4>Review, lock, export and Trash history</h4><TaxReviewValues value={preview.events}/><h4>Related records</h4><TaxReviewValues value={preview.dependencies}/></details>
 {preview.reasons.map(text=><p key={text}>{text}</p>)}
 {canManage&&(!preview.deleted||preview.canManageDeletion)&&<><label>Action<select disabled={busy} value={action} onChange={e=>{setAction(e.target.value as typeof action);setConfirmation("");}}>{preview.deleted?<option value="RESTORE">Restore report</option>:<>{preview.canManageDeletion&&<option value="DELETE">Move to Trash</option>}<option value="REVIEW">Record review</option><option value="LOCK">Lock workpaper</option></>}</select></label>
 <label>Reason<input disabled={busy} value={reason} minLength={8} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
 <label>Confirm exact record and action: {expected}<input disabled={busy} value={confirmation} autoComplete="off" onChange={e=>setConfirmation(e.target.value)}/></label>
 <button type="button" disabled={busy||!canPerformAction||confirmation!==expected||reason.trim().length<8} onClick={()=>void commit()}>{action==="DELETE"?"Move to Trash":action==="RESTORE"?"Restore report":action==="REVIEW"?"Record review":"Lock workpaper"}</button></>}
 <button type="button" disabled={busy} onClick={()=>setPreview(null)}>Cancel</button>
 </section>}{error&&<p role="alert">{error}</p>}</div>;
}
