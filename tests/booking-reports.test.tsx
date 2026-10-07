import { randomUUID } from "node:crypto";
import { describe,expect,it,vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { bookingReportCsv, summarizeBookingEntries,type BookingEntry,type BookingSnapshot } from "@/modules/booking-reports/model";
import { BookingReportView } from "@/app/_components/booking-report";
vi.mock("next/link",()=>({default:({children,...props}:React.ComponentProps<"a">)=><a {...props}>{children}</a>}));
function entry(input:Partial<BookingEntry>={}):BookingEntry { const id=randomUUID();return {selected:{type:"SOURCE_DOCUMENT",id,expectedVersion:1,expectedContentHash:"a".repeat(64),group:"Financing"},id,sourceType:"payables.supplier-bill",sourceNumber:"Bill 1",version:1,contentHash:"a".repeat(64),kind:"SUPPLIER_BILL",status:"POSTED",accountingDate:"2026-10-07",documentDate:"2026-10-07",period:"October",description:"<script>alert(1)</script>",party:"Vendor",currency:"USD",functionalCurrency:"CAD",net:"90",tax:"10",gross:"100",grossFunctional:"137",outstanding:"0",journalId:randomUUID(),journalNumber:1,linesArePosted:true,lines:[{accountCombinationId:"clearing",accountCode:"1200",accountName:"Device clearing",accountClass:"ASSET",debitFunctional:"137",creditFunctional:"0",currency:"USD",debit:"100",credit:"0",fxRate:"1.37",fxSource:"Synthetic",fxDate:"2026-10-07",memo:""},{accountCombinationId:"payable",accountCode:"2100",accountName:"Payables",accountClass:"LIABILITY",debitFunctional:"0",creditFunctional:"137",currency:"USD",debit:"0",credit:"100",fxRate:"1.37",fxSource:"Synthetic",fxDate:"2026-10-07",memo:""}],taxDetails:[],treatments:[],attachments:[],approvalContext:null,differences:[],heldReason:null,...input}; }
function snapshot(entries:BookingEntry[]):BookingSnapshot{return {schemaVersion:1,title:"Synthetic report",company:"Test company",companyCode:"TEST",legalEntityId:randomUUID(),ledgerId:randomUUID(),generatedAt:"2026-10-07T00:00:00Z",generatedBy:randomUUID(),requestId:randomUUID(),reason:"Synthetic",phase:"OUTCOME",reviewReportId:null,entries,heldItems:[],summary:summarizeBookingEntries(entries,[],[])};}
describe("booking report accounting and presentation",()=>{
  it("separates original currencies, posted invoice recognition and remaining debt",()=>{
    const result=summarizeBookingEntries([entry(),entry({currency:"CAD",net:"40.10",tax:"5.21",gross:"45.31",grossFunctional:"45.31",outstanding:"12.25"}),entry({kind:"SUPPLIER_PAYMENT",net:null,tax:null,gross:null,grossFunctional:null})],[],[]);
    expect(result.invoiceCurrencies).toEqual({USD:{net:"90",tax:"10",gross:"100",outstanding:"0"},CAD:{net:"40.1",tax:"5.21",gross:"45.31",outstanding:"12.25"}});expect(result.recognizedFunctional).toBe("182.31");expect(result.counts).toMatchObject({bills:2,settlements:1,posted:3});
  });
  it("distinguishes draft lines, held items, partial completion and stale content",()=>{
    const draft=entry({status:"DRAFT",linesArePosted:false,heldReason:"Review source tax",differences:["Version changed"]});const result=summarizeBookingEntries([entry(),draft],[{description:"Prepaid usage",reason:"Deferred until monthly review"}],[]);
    expect(result.status).toBe("PARTIALLY_POSTED");expect(result.completeness).toBe("STALE");expect(result.postedDebitFunctional).toBe("137");expect(result.debitFunctional).toBe("274");expect(result.counts.held).toBe(2);expect(result.exceptions).toContain("Prepaid usage: Deferred until monthly review");
  });
  it("reconciles declared financing groups using exact decimals and flags unmatched groups",()=>{
    const first=entry(),second=entry({kind:"JOURNAL",lines:first.lines.map((line)=>({...line,debitFunctional:line.creditFunctional,creditFunctional:line.debitFunctional}))});
    expect(summarizeBookingEntries([first,second],[],[{name:"Financing",accountCombinationIds:["clearing"]}]).clearing[0]).toMatchObject({net:"0",balanced:true});
    expect(summarizeBookingEntries([first],[],[{name:"Financing",accountCombinationIds:["clearing","missing"]}]).completeness).toBe("HELD");
  });
  it("does not call an unbalanced or missing posted result complete",()=>{const broken=entry();broken.lines=broken.lines.slice(0,1);expect(summarizeBookingEntries([broken],[],[]).completeness).toBe("HELD");expect(summarizeBookingEntries([entry({linesArePosted:false,heldReason:"Missing journal"})],[],[]).status).toBe("DRAFT");});
  it("escapes untrusted text in HTML and spreadsheet formulas while preserving negative decimals",()=>{
    const e=entry({sourceNumber:"  =WEBSERVICE(1)",taxDetails:[{description:"Discount",net:"-33.87",tax:"-4.41",treatment:"RECOVERABLE",rounding:"-0.01",reason:"Printed rounding",evidence:"source.pdf"}]});const view=snapshot([e]);const csv=bookingReportCsv(view);
    expect(csv).toContain('"\'  =WEBSERVICE(1)"');expect(csv).toContain('"-33.87"');expect(csv).toContain('"-0.01"');
    const html=renderToStaticMarkup(<BookingReportView report={{batchId:randomUUID(),reportId:randomUUID(),version:1,url:"/app/reports/booking-batches",reportUrl:"/app/reports/booking-batches",hash:"a".repeat(64),status:view.summary.status,completeness:view.summary.completeness,selectedRecords:[e.selected],snapshot:view}}/>);
    expect(html).toContain("&lt;script&gt;");expect(html).not.toContain("<script>");expect(html).toContain("Actual posted journal lines");expect(html).toContain("Download CSV");
  });
});
