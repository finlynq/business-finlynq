import { build } from "esbuild";
import { resolve } from "node:path";
import { expect,test } from "@playwright/test";
// Browser rendering uses explicit synthetic data; committed source/ledger,
// permission and replay behavior is covered by booking-reports.integration.test.ts.
test("booking report is readable, printable and escaped on narrow screens",async({page})=>{
 const root=resolve(__dirname,"..");const bundle=await build({absWorkingDir:root,bundle:true,write:false,platform:"browser",format:"iife",jsx:"automatic",outfile:"booking-report.js",loader:{".css":"local-css"},stdin:{resolveDir:root,loader:"tsx",contents:`
 import {createRoot} from "react-dom/client";
 import {BookingReportView} from "@/app/_components/booking-report";
 import {summarizeBookingEntries} from "@/modules/booking-reports/model";
 const id="60000000-0000-4000-8000-000000000001";
 const entry={selected:{type:"SOURCE_DOCUMENT",id,expectedVersion:1,expectedContentHash:"a".repeat(64),group:"Device financing"},id,sourceType:"payables.supplier-bill",sourceNumber:"SYNTHETIC-REPORT",version:2,contentHash:"a".repeat(64),kind:"SUPPLIER_BILL",status:"POSTED",accountingDate:"2026-10-07",documentDate:"2026-10-07",period:"October",description:"<script>unsafe()</script>",party:"Synthetic supplier",currency:"USD",functionalCurrency:"CAD",net:"100",tax:"0",gross:"100",grossFunctional:"137",outstanding:"20",journalId:id,journalNumber:52,linesArePosted:true,lines:[
 {accountCombinationId:"asset",accountCode:"1500",accountName:"Devices",accountClass:"ASSET",debitFunctional:"137",creditFunctional:"0",currency:"USD",debit:"100",credit:"0",fxRate:"1.37",fxSource:"Synthetic source",fxDate:"2026-10-07",memo:"Device purchase"},
 {accountCombinationId:"payable",accountCode:"2100",accountName:"Payables",accountClass:"LIABILITY",debitFunctional:"0",creditFunctional:"137",currency:"USD",debit:"0",credit:"100",fxRate:"1.37",fxSource:"Synthetic source",fxDate:"2026-10-07",memo:"Supplier amount"}],taxDetails:[],treatments:["Device cost remains on the balance sheet."],attachments:[],approvalContext:{contentHash:"a".repeat(64)},differences:[],heldReason:null};
 const snapshot={schemaVersion:1,title:"Synthetic booking report",company:"Synthetic company",companyCode:"TEST",legalEntityId:id,ledgerId:id,generatedAt:"2026-10-07T00:00:00Z",generatedBy:id,requestId:id,reason:"Synthetic browser review",phase:"OUTCOME",reviewReportId:id,entries:[entry],heldItems:[],summary:summarizeBookingEntries([entry],[],[])};
 const report={batchId:id,reportId:id,version:2,url:"/app/reports/booking-batches/"+id,hash:"a".repeat(64),status:"POSTED",completeness:"COMPLETE",selectedRecords:[entry.selected],snapshot};
 createRoot(document.getElementById("root")).render(<BookingReportView report={report}/>);
 `},plugins:[{name:"booking-link-boundary",setup(bundler){bundler.onResolve({filter:/^next\/link$/},()=>({path:"link",namespace:"booking-link"}));bundler.onLoad({filter:/.*/,namespace:"booking-link"},()=>({resolveDir:root,loader:"js",contents:'import {createElement} from "react"; export default function Link(props){return createElement("a",props)}'}));}}]});
 const script=bundle.outputFiles.find(file=>file.path.endsWith(".js"))!.text,css=bundle.outputFiles.find(file=>file.path.endsWith(".css"))?.text??"";
 await page.route("**/__e2e__/booking-report",route=>route.fulfill({contentType:"text/html",body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;margin:16px}${css}</style></head><body><main id="root"></main><script>${script.replaceAll("</script","<\\/script")}</script></body></html>`}));
 await page.goto("/__e2e__/booking-report");
 await expect(page.getByRole("heading",{name:"Synthetic company · Posted"})).toBeVisible();
 await expect(page.getByText("<script>unsafe()</script>",{exact:true})).toBeVisible();
 await expect(page.getByRole("table",{name:/Actual posted journal lines/})).toContainText("1500 · Devices");
 await expect(page.getByRole("link",{name:"Original draft review"})).toHaveAttribute("href",/reportId=/);
 await expect(page.getByRole("link",{name:"Download CSV"})).toHaveAttribute("href",/export\?reportId=/);
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
 await page.emulateMedia({media:"print"});
 await expect(page.getByRole("button",{name:"Print report"})).toBeHidden();
 await expect(page.getByRole("heading",{name:"Device financing · SYNTHETIC-REPORT"})).toBeVisible();
});
