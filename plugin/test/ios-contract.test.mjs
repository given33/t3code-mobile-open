import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { temp, port, mobile } from "./helpers.mjs";
import { LinkServer } from "../lib/link-server.mjs";
import { writeState } from "../lib/state.mjs";
import { COOKIE } from "../lib/devices.mjs";
import { shellJs } from "../lib/mobile-shell.mjs";

const source = (path) => readFileSync(new URL("../../" + path, import.meta.url), "utf8");
const tests = "ios/Core/Tests/T3MobileCoreTests/";
const fixture = (name) => JSON.parse(source(tests + "Fixtures/" + name + ".json"));
const swift = source("ios/Core/Sources/T3MobileCore/ProtocolTypes.swift");
const constant = (name) => {
  const value = new RegExp(`\\b${name} = "([^"\\n]+)"`).exec(swift)?.[1];
  assert.ok(value, `missing Swift wire constant ${name}`);
  return value;
};

test("Swift fixed public point, DER, pin and safety code agree with Node crypto", () => {
  const vector = source(tests + "FingerprintTests.swift");
  const field = (n) => vector.match(new RegExp(`let ${n}\\s*=\\s*"([^"]+)"`))[1];
  const point = Buffer.from(field("point"), "hex");
  const pub = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
  const der = pub.export({ format: "der", type: "spki" });
  const hash = createHash("sha256").update(der).digest();
  assert.equal(der.toString("hex"), field("prefix") + field("point"));
  assert.equal(hash.toString("base64url"), field("pin"));
  assert.equal(hash.subarray(0, 8).toString("hex").toUpperCase().match(/.{4}/g).join(" "), field("safety"));
  const leaf = fixture("leaf"), cert = new X509Certificate(Buffer.from(leaf.der, "base64"));
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, "prime256v1");
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(createHash("sha256").update(cert.publicKey.export({type:"spki",format:"der"})).digest("base64url"), leaf.pin);
  assert.equal(leaf.pin, fixture("hello").fingerprint);
});

test("Swift paths, response fixtures and cookie match an actual pinned LinkServer exchange", async (t) => {
  const h = temp(); t.after(h.clean);
  const p = await port(), ctx = {stateDir:h.dir, getServerInfo:()=>({environmentId:"test-env"}), issueLocalSession:async()=>null};
  const svc = new LinkServer(ctx,{host:"127.0.0.1",port:p,name:"Desk"});
  writeState(h.dir,"family-route.json",fixture("sync").family);
  await svc.start(); t.after(()=>svc.stop());
  const req = async (n, opts) => { const r = await mobile(p,svc.ident.fingerprint,constant(n),opts); assert.equal(r.status,200); return r; };
  const hello = (await req("hello")).json(), pair = (await req("pair",{method:"POST",body:{code:svc.pair.code,name:"Phone"}})).json();
  const headers = {authorization:"Bearer " + pair.token};
  assert.deepEqual((await req("hello", {headers})).json().family, fixture("sync").family);
  const web = await req("webSession",{method:"POST",headers}), sync = (await req("sync",{headers})).json();
  // Substitute only runtime values, never delete a key. Extra, missing, renamed and mistyped fields fail.
  const host = {...fixture("hello").host,id:svc.ident.id};
  assert.deepEqual(hello,{...fixture("hello"),host,fingerprint:svc.ident.fingerprint});
  assert.equal(typeof pair.deviceId,"string"); assert.match(pair.token,/^[\w-]{43}$/);
  assert.deepEqual(pair,{...fixture("pair"),host,deviceId:pair.deviceId,token:pair.token});
  assert.deepEqual(web.json(),{...fixture("web-session"),host});
  assert.equal(constant("cookie"),COOKIE); assert.equal(web.json().cookieName,COOKIE);
  assert.match(web.headers["set-cookie"][0], new RegExp(`^${COOKIE}=[\\w-]{43}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict$`));
  assert.ok(Number.isSafeInteger(sync.serverTimeMs)); assert.equal(sync.upstreamOk,false);
  assert.deepEqual(sync,{...fixture("sync"),host,serverTimeMs:sync.serverTimeMs,upstreamOk:false});
  assert.deepEqual((await req("unpair",{method:"POST",headers})).json(),{ok:true});
  const denied = await mobile(p,svc.ident.fingerprint,constant("sync"),{headers}); assert.equal(denied.status,401);
});

test("real mobile shell posts the Swift event fixture to the Swift handler; native calls have matching signatures", async () => {
  const messages = [], callbacks = new Map(), body = {};
  let drawer = null, notifyDrawer;
  const root = {classList:{contains:()=>true},style:{setProperty(){}}};
  class WS { constructor(url) { this.url = url; } addEventListener(k,f) { callbacks.set(k,f); } }
  const window = {WebSocket:WS, webkit:{messageHandlers:{[constant("handler")]:{postMessage:m=>messages.push(m)}}}, fetch:async()=>({status:401,url:"https://example.com/"})};
  vm.runInNewContext(shellJs,{window,URL,location:new URL("https://example.com/thread"),document:{title:"Thread",documentElement:root,head:{},body,querySelector:()=>drawer},
    history:{pushState(){},replaceState(){}},addEventListener(){},MutationObserver:class {constructor(cb){this.cb=cb} observe(el){if(el===body) notifyDrawer=this.cb}},getComputedStyle:()=>({getPropertyValue:()=>"#222222"})});
  drawer = {}; notifyDrawer(); notifyDrawer();
  drawer = null; notifyDrawer();
  new window.WebSocket("wss://example.com/ws"); callbacks.get("open")(); callbacks.get("close")(); await window.fetch("/");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)),fixture("events"));
  const bridge = window.__T3_MOBILE_BRIDGE__, view = source("ios/T3Mobile/App/OfficialWebView.swift");
  for (const [name,arity] of Object.entries({toggleSidebar:0,insertDraft:1,setKeyboard:2,reconnect:0,openRoute:1,voiceEvent:1})) {
    assert.equal(bridge[name].length,arity);
    if (!["openRoute","voiceEvent"].includes(name)) assert.ok(view.includes(`window.__T3_MOBILE_BRIDGE__?.${name}(`));
  }
});

// The ATS host is not a general-purpose DNS allowlist entry.
test("privacy exception is confined to one exact iOS ATS dictionary entry", async (t) => {
  const {execFileSync,spawnSync} = await import("node:child_process");
  const {mkdirSync,writeFileSync} = await import("node:fs");
  const {join} = await import("node:path");
  const {fileURLToPath} = await import("node:url");
  const h = temp(); t.after(h.clean); execFileSync("git", ["init","-q"], {cwd:h.dir});
  const guard = fileURLToPath(new URL("../../scripts/check-privacy.mjs", import.meta.url));
  const file = join(h.dir,"ios","T3Mobile","Info.plist"); mkdirSync(join(h.dir,"ios","T3Mobile"),{recursive:true});
  const plist = source("ios/T3Mobile/Info.plist"), host = ["t3-cloud","sslip","io"].join(".");
  const run = () => spawnSync(process.execPath,[guard],{cwd:h.dir,encoding:"utf8"}).status;
  writeFileSync(file,plist); assert.equal(run(),0);
  for (const value of ["x." + host,host + ".net",host.replace("t3-cloud","other")]) {
    writeFileSync(file,plist.replace(host,value)); assert.equal(run(),1);
  }
  writeFileSync(file,plist.replace("NSExceptionDomains","Other")); assert.equal(run(),1);
  writeFileSync(file,plist); writeFileSync(join(h.dir,"outside.txt"),host); assert.equal(run(),1);
});

test("relay fixtures: bearer/cookie auth, write gate, retry, peer-only receipt and escaped inbox", async (t) => {
  const nodes=[];
  for (const role of ["local","cloud"]) {
    const h=temp();t.after(h.clean);const p=await port();
    const svc=new LinkServer({stateDir:h.dir,getServerInfo:()=>({environmentId:"test-env"}),issueLocalSession:async()=>null},
      {enabled:true,host:"127.0.0.1",port:p,role,taskSync:{enabled:true,role}});
    await svc.start();t.after(()=>svc.stop());const req=(path,opts)=>mobile(p,svc.ident.fingerprint,path,opts);
    const pair=(await req(constant("pair"),{method:"POST",body:{code:svc.pair.code,name:"Phone"}})).json();
    const headers={authorization:"Bearer "+pair.token};const web=await req(constant("webSession"),{method:"POST",headers});
    const cookie={cookie:web.headers['set-cookie'][0].split(';')[0]};nodes.push({svc,req,headers,cookie});
  }
  const [a,b]=nodes;a.svc.relay.transport=async m=>b.svc.relay.receive(structuredClone(m));
  const body={handoffId:"test-request",threadId:"thread-one",targetRole:"cloud",title:"<user text>"};
  const post=headers=>({method:'POST',headers,body});
  assert.equal((await a.req(constant('relayStatus'))).status,401);assert.equal((await a.req(constant('handoff'),post({}))).status,401);
  assert.deepEqual((await a.req(constant('relayStatus'),{headers:a.cookie})).json(),fixture('relay'));
  assert.deepEqual((await a.req(constant('sync'),{headers:a.headers})).json().relay,fixture('relay'));
  assert.equal((await a.req(constant('handoff'),post(a.headers))).status,403);
  await a.svc.configure({actions:true});assert.equal((await a.req(constant('checkpoint'),post(a.headers))).status,200);
  for(const headers of [a.headers,a.cookie]) {const r=await a.req(constant('handoff'),post(headers));assert.equal(r.status,200);assert.deepEqual(r.json(),fixture('handoff'));}
  assert.equal((await b.req(constant('claims')+body.handoffId,{headers:b.headers})).json().targetRoute,fixture('handoff').targetRoute);
  assert.equal((await b.req(fixture('handoff').targetRoute)).status,401);
  assert.match((await b.req(fixture('handoff').targetRoute,{headers:b.cookie})).text,/&lt;user text&gt;/);
  assert.equal(b.svc.relay.lease.list('claims').length,1);
  assert.equal((await a.req(constant('handoff'),{...post(a.headers),body:{...body,threadId:'different'}})).status,409);
});
