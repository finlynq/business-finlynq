"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TaxReviewValues } from "./tax-draft-review.client";
import type { previewTaxWorkpaperControl } from "@/modules/tax/workpaper-controls";
type Preview=Awaited<ReturnType<typeof previewTaxWorkpaperControl>>;
export function TaxWorkpaperControls({filingId,canManage}:{filingId:string;canManage:boolean}){
 const router=useRouter();const[preview,setPreview]=useState<Preview|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState("");
 const[action,setAction]=useState<"DELETE"|"RESTORE"|"REVIEW"|"LOCK">("DELETE");const[reason,setReason]=useState("");const[confirmation,setConfirmation]=useState("");
 const command=useRef({fingerprint:"",key:""});
 async function inspect(){setBusy(true);setError("");try{const response=await fetch(`/api/tax/filings/controls/preview?filingId=${encodeURIComponent(filingId)}`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error??"Dependencies could not be loaded.");setPreview(data);setAction(data.deleted?"RESTORE":"DELETE");setConfirmation("");}catch(e){setError(e instanceof Error?e.message:"Preview failed.");}finally{setBusy(false);}}
 const expected=`${action} ${filingId}${action==="DELETE"?" UNFILED":""}`;
 async function commit(){if(!preview)return;setBusy(true);setError("");const fields={filingId,action,expectedVersion:preview.version,previewHash:preview.previewHash,reason,confirmation};
  const fingerprint=JSON.stringify(fields);if(command.current.fingerprint!==fingerprint)command.current={fingerprint,key:crypto.randomUUID()};
  try{const response=await fetch("/api/tax/filings/controls",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...fields,idempotencyKey:command.current.key})});const data=await response.json();if(!response.ok)throw new Error(data.error??"The workpaper action failed.");setPreview(null);setConfirmation("");router.refresh();}catch(e){setError(e instanceof Error?e.message:"The workpaper action failed.");}finally{setBusy(false);}
 }
 return <div className="form-footnote"><button type="button" disabled={busy} onClick={()=>void inspect()}>Review lock and cleanup eligibility</button>
 {preview&&<section aria-label="Exact workpaper review"><h3>Workpaper {filingId}</h3><TaxReviewValues value={preview.workpaper}/>
 <p>{preview.submissionState}</p><p>{preview.retention}</p><h4>Review, lock and export history</h4><TaxReviewValues value={preview.events}/><h4>Inbound dependencies</h4><TaxReviewValues value={preview.dependencies}/>
 {preview.reasons.map(text=><p key={text}>{text}</p>)}
 {canManage&&<><label>Action<select value={action} onChange={e=>{setAction(e.target.value as typeof action);setConfirmation("");}}>{preview.deleted?<option value="RESTORE">Restore draft</option>:<><option value="DELETE" disabled={!preview.eligible}>Delete draft</option><option value="REVIEW">Record review</option><option value="LOCK">Lock workpaper</option></>}</select></label>
 <label>Reason<input value={reason} minLength={8} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
 <label>Confirm exact record and action: {expected}<input value={confirmation} autoComplete="off" onChange={e=>setConfirmation(e.target.value)}/></label>
 <button type="button" disabled={busy||confirmation!==expected||reason.trim().length<8||(action==="DELETE"&&!preview.eligible)} onClick={()=>void commit()}>{action==="DELETE"?"Delete draft":action==="RESTORE"?"Restore draft":action==="REVIEW"?"Record review":"Lock workpaper"}</button></>}
 </section>}{error&&<p role="alert">{error}</p>}</div>;
}
