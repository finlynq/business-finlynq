import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { handleMcpRequest } from "@/modules/mcp/server";
import { INVOICE_NOTIFICATION_RESOURCE } from "@/modules/email/invoice-notifications";
const mocks=vi.hoisted(()=>({ count:0,revision:"a".repeat(64),revoked:false,denied:false,sourceFailed:false,reads:vi.fn() }));
vi.mock("@/modules/mcp/oauth-store",async(original)=>({
 ...await original<typeof import("@/modules/mcp/oauth-store")>(),
 verifyAccessToken:async(token:string)=>{
   if(mocks.revoked || !["tenant-a","tenant-b"].includes(token))throw new Error("Synthetic revoked token");
   return {clientId:token,connectionId:token,organizationId:token,userId:token,scopes:["mcp:daily:read"],tokenExpiresAt:new Date(Date.now()+120000)};
 },
}));
vi.mock("@/modules/mcp/connection-policy",async(original)=>({
 ...await original<typeof import("@/modules/mcp/connection-policy")>(),
 loadMcpAuthorizationSnapshot:async(principal:unknown)=>({principal,permissions:new Set(mocks.denied?[]:["payables.read"]),dailyMode:"READ_ONLY",setupMode:"OFF",toolOverrides:{},connectionVersion:1}),
}));
vi.mock("@/modules/mcp/tool-types",async(original)=>({
 ...await original<typeof import("@/modules/mcp/tool-types")>(),registerMcpTools:(server:McpServer)=>{ void server; },
}));
vi.mock("@/modules/email/invoice-notifications",async(original)=>({
 ...await original<typeof import("@/modules/email/invoice-notifications")>(),
 readInvoiceNotifications:async(context:{organizationId:string},afterRevision?:string)=>{
   mocks.reads(context.organizationId);
   if(mocks.sourceFailed)throw new Error("Private database detail");
   const count=context.organizationId==="tenant-a"?mocks.count:0;
   const revision=context.organizationId==="tenant-a"?mocks.revision:"b".repeat(64);
   return {availability:"AVAILABLE",revision,invoiceCount:count,emailCount:count,readyCount:count,shouldNotify:count>0&&afterRevision!==revision,items:[],observedAt:new Date().toISOString(),refreshAfterMs:15000};
 },
}));
const controllers:AbortController[]=[];
beforeEach(()=>{
 vi.useFakeTimers();vi.stubEnv("APP_ORIGIN","https://business.example.test");vi.stubEnv("BUSINESS_FINLYNQ_PUBLIC_URL","");
 mocks.count=0;mocks.revision="a".repeat(64);mocks.revoked=false;mocks.denied=false;mocks.sourceFailed=false;mocks.reads.mockClear();
});
afterEach(async()=>{for(const controller of controllers.splice(0))controller.abort();await vi.advanceTimersByTimeAsync(0);vi.useRealTimers();vi.unstubAllEnvs();});
function request(method:string,params:Record<string,unknown>={},token="tenant-a",modern=false){
 const controller=new AbortController();controllers.push(controller);
 return new Request("https://business.example.test/mcp",{method:"POST",signal:controller.signal,headers:{authorization:`Bearer ${token}`,"content-type":"application/json",accept:"application/json, text/event-stream","mcp-protocol-version":modern?"2026-07-28":"2025-06-18",...(modern?{"mcp-method":method}:{})},
 body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:{...params,...(modern?{_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"synthetic-notification-client",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}}:{})}})});
}
async function readUntil(reader:ReadableStreamDefaultReader<Uint8Array>,expected:string){
 let text="";
 for(let attempt=0;attempt<5;attempt++){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);if(text.includes(expected))return text;}
 throw new Error("Expected stream data missing: "+text);
}
describe("invoice notifications through the real MCP HTTP transport",()=>{
 it("includes backlog at connection and exposes the authorized read-only resource",async()=>{
   mocks.count=2;
   const initialized=await handleMcpRequest(request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"fixture",version:"1"}}));
   const text=(await initialized.text()).replaceAll("\\","");
   expect(text).toContain('"readyCount":2');expect(text).toContain("Current received invoice work");
   const listed=await handleMcpRequest(request("resources/list"));expect(await listed.text()).toContain(INVOICE_NOTIFICATION_RESOURCE);
   const read=await handleMcpRequest(request("resources/read",{uri:INVOICE_NOTIFICATION_RESOURCE}));
   expect((await read.text()).replaceAll("\\","")).toContain('"invoiceCount":2');
 });
 it("delivers a new arrival on an already open subscription without reconnecting",async()=>{
   const response=await handleMcpRequest(request("subscriptions/listen",{notifications:{resourceSubscriptions:[INVOICE_NOTIFICATION_RESOURCE]}},"tenant-a",true));
   expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("text/event-stream");
   const reader=response.body!.getReader();
   await readUntil(reader,"notifications/subscriptions/acknowledged");
   await vi.advanceTimersByTimeAsync(0);
   mocks.count=1;mocks.revision="c".repeat(64);
   await vi.advanceTimersByTimeAsync(15000);
   const notification=await readUntil(reader,"notifications/resources/updated");
   expect(notification).toContain(INVOICE_NOTIFICATION_RESOURCE);expect(notification).toContain("c".repeat(64));
   await reader.cancel();
 });
 it("keeps another organization's read empty and closes a stream when its token is revoked",async()=>{
   mocks.count=3;
   const other=await handleMcpRequest(request("resources/read",{uri:INVOICE_NOTIFICATION_RESOURCE},"tenant-b"));
   expect((await other.text()).replaceAll("\\","")).toContain('"invoiceCount":0');
   const response=await handleMcpRequest(request("subscriptions/listen",{notifications:{resourceSubscriptions:[INVOICE_NOTIFICATION_RESOURCE]}},"tenant-a",true));
   const reader=response.body!.getReader();await readUntil(reader,"notifications/subscriptions/acknowledged");
   await vi.advanceTimersByTimeAsync(0);
   await readUntil(reader,"notifications/resources/updated");
   mocks.revoked=true;await vi.advanceTimersByTimeAsync(15000);
   let done=false;for(let attempt=0;attempt<3;attempt++){const chunk=await reader.read();if(chunk.done){done=true;break;}}
   expect(done).toBe(true);
 });
 it("reports source failures as unavailable and hides the resource after permission revocation",async()=>{
   mocks.sourceFailed=true;
   const unavailable=await handleMcpRequest(request("resources/read",{uri:INVOICE_NOTIFICATION_RESOURCE}));
   const text=await unavailable.text();expect(text).toContain("UNAVAILABLE");expect(text).not.toContain("Private database detail");
   mocks.denied=true;mocks.reads.mockClear();
   const denied=await handleMcpRequest(request("resources/read",{uri:INVOICE_NOTIFICATION_RESOURCE}));
   expect(await denied.text()).not.toContain("UNAVAILABLE");expect(mocks.reads).not.toHaveBeenCalled();
 });
 it("bounds concurrent subscriptions per connection and releases capacity on disconnect",async()=>{
   for(let index=0;index<4;index++) {
     const response=await handleMcpRequest(request("subscriptions/listen",{notifications:{resourceSubscriptions:[INVOICE_NOTIFICATION_RESOURCE]}},"tenant-a",true));
     expect(response.status).toBe(200);
   }
   const denied=await handleMcpRequest(request("subscriptions/listen",{notifications:{resourceSubscriptions:[INVOICE_NOTIFICATION_RESOURCE]}},"tenant-a",true));
   expect(denied.status).toBe(429);
   controllers[0].abort();await vi.advanceTimersByTimeAsync(0);
   const retry=await handleMcpRequest(request("subscriptions/listen",{notifications:{resourceSubscriptions:[INVOICE_NOTIFICATION_RESOURCE]}},"tenant-a",true));
   expect(retry.status).toBe(200);
 });

});
