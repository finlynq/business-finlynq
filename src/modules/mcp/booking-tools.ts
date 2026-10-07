import "server-only";
import { PERMISSIONS } from "@/modules/identity/permissions";
import { createBookingBatchSchema,readBookingReportSchema,refreshBookingReportSchema,postBookingBatchSchema } from "@/modules/booking-reports/model";
import { createBookingBatch,readBookingReport,refreshBookingReport,postBookingBatch } from "@/modules/booking-reports/service";
import { mcpMutationContext } from "./oauth-store";
import { defineMcpTool, type McpToolRuntime } from "./tool-types";
import { effectiveToolMode, isMcpToolVisible } from "./connection-policy";
const context=(runtime:McpToolRuntime,reason:string)=>mcpMutationContext(runtime.principal,runtime.requestId,reason);
function linked<T extends {url:string}>(result:T,runtime:McpToolRuntime) { const url=runtime.requestUrl?new URL(result.url,runtime.requestUrl).href:result.url;return {...result,url,reportUrl:url}; }
export const BOOKING_MCP_TOOLS=[
  defineMcpTool({policy:{name:"finlynq_daily_create_booking_batch",group:"DAILY",access:"WRITE",permission:PERMISSIONS.readMcpLedger},title:"Create booking review",description:"Group exact company-owned source documents and manual journals by current version and content hash. Creates an immutable, printable draft review with tax, FX, evidence and clearing checks. This operation does not post or approve accounting. Use current approvalVersion (0 for an unsubmitted journal) for journal expectedVersion. Include settlement records already booked through their normal command.",inputSchema:createBookingBatchSchema,idempotent:true,
    invoke:async(args,runtime)=>linked(await createBookingBatch(context(runtime,args.reason),args),runtime)}),
  defineMcpTool({policy:{name:"finlynq_daily_get_booking_batch_report",group:"DAILY",access:"READ",permission:PERMISSIONS.readMcpLedger},title:"Read booking report",description:"Read the latest or an exact historical booking report, including selected hashes, versions, status, completeness and its permission-checked link. Historical reports never silently change.",inputSchema:readBookingReportSchema,
    invoke:async(args,runtime)=>linked(await readBookingReport(context(runtime,"Read booking report"),args),runtime)}),
  defineMcpTool({policy:{name:"finlynq_daily_refresh_booking_batch_report",group:"DAILY",access:"WRITE",permission:PERMISSIONS.readMcpLedger},title:"Capture booking outcome",description:"Save a new immutable outcome report from current source records and actual posted journal lines. Detect edits since review and show held or partial results. Never posts accounting; use this to recover a report after a reporting failure without repeating financial writes.",inputSchema:refreshBookingReportSchema,idempotent:true,
    invoke:async(args,runtime)=>linked(await refreshBookingReport(context(runtime,args.reason),args),runtime)}),
  defineMcpTool({policy:{name:"finlynq_daily_post_booking_batch",group:"DAILY",access:"WRITE",permission:PERMISSIONS.postJournal},title:"Post reviewed booking batch",description:"Explicitly book the exact immutable review through existing bill/invoice and manual journal commands, then automatically capture actual posted results and return a report link. Requires confirmed=true plus exact review ID/hash. Normal journal approvals, source-tax review, company permissions, connection restrictions and version checks apply. Holds individual failures; never approves a journal. Retry identical arguments safely or refresh the report without posting again.",inputSchema:postBookingBatchSchema,idempotent:true,
    invoke:async(args,runtime)=>linked(await postBookingBatch(context(runtime,args.reason),args,(entries)=>{
      for(const entry of entries.filter((item)=>!item.linesArePosted)){
        const name=entry.kind==="SUPPLIER_BILL"?"finlynq_daily_issue_supplier_bill":entry.kind==="SALES_INVOICE"?"finlynq_daily_issue_sales_invoice":"finlynq_daily_post_journal";
        const permission=entry.kind==="SUPPLIER_BILL"?PERMISSIONS.postPayables:entry.kind==="SALES_INVOICE"?PERMISSIONS.postReceivables:PERMISSIONS.postJournal;
        const childPolicy={name,group:"DAILY" as const,access:"WRITE" as const,permission};
        if(effectiveToolMode(runtime.snapshot,childPolicy)==="CONFIRM_WRITES" && effectiveToolMode(runtime.snapshot,{name:"finlynq_daily_post_booking_batch",group:"DAILY",access:"WRITE",permission:PERMISSIONS.postJournal})!=="CONFIRM_WRITES")throw new Error("A selected action requires confirmation. Use its normal approved posting command and then refresh this batch report, or require confirmation for batch posting too.");
        if(!isMcpToolVisible(runtime.snapshot,childPolicy))throw new Error("This connection does not allow a selected posting action. Review its Daily tool permissions.");
      }
    }),runtime)})
];
