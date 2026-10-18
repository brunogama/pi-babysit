import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import extension from "./index.ts";

const tools = new Map<string, any>();
extension({ registerTool: (t: any) => tools.set(t.name, t), on() {}, registerCommand() {}, registerMessageRenderer() {}, getActiveTools: () => [], getThinkingLevel: () => "low", sendMessage() {} } as any);
const names = ["run", "check", "send", "wait", "kill"];

test("all babysit schemas require nonblank string descriptions", () => {
 for (const name of names) {
  const schema = tools.get(`babysit_${name}`).parameters;
  expect(schema.required).toContain("description");
  expect(schema.properties.description.type).toBe("string");
  expect(schema.properties.description.minLength).toBeGreaterThanOrEqual(1);
  const pattern = new RegExp(schema.properties.description.pattern);
  for (const value of ["", " ", "\t\r\n"]) expect(pattern.test(value)).toBe(false);
  expect(pattern.test("Inspect worker")).toBe(true);
 }
});

const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
const fixtures: Array<[string, Record<string, unknown>]> = [
 ["check", { state: "all", kind: "process", lines: 17, maxBytes: 3000 }],
 ["check", { id: "worker", tools: 4, lines: 9, maxBytes: 2400, pattern: "ready", screen: true }],
 ["send", { id: "worker", text: "first\nsecond\t\u001b[31m", mode: "steer", noNewline: true }],
 ["send", { id: "worker", keys: ["Enter", "C-c", "\u001b"], noNewline: false }],
 ["wait", { id: "worker", timeout: "2m", expect: "ready\n", maxBytes: 5000 }],
 ["wait", { ids: ["first", "second"], mode: "any", timeout: "3m", maxBytes: 7000 }],
 ["kill", { id: "worker" }],
];
for (const [name, payload] of fixtures) {
 test(`${name} renderer preserves all arguments and separates operation purpose: ${JSON.stringify(payload)}`, () => {
  const tool = tools.get(`babysit_${name}`);
  const description = "  Inspect operation\n\u001b[31m purpose  ";
  const render = (expanded: boolean) => tool.renderCall({ ...payload, description }, theme, { expanded }).render(10000).join("\n");
  const collapsed = render(false);
  expect(render(true)).toBe(collapsed);
  expect(collapsed).toContain(`<muted>`);
  expect(collapsed).toContain(`babysit_${name}`);
  expect(collapsed).toContain("<warning><bold>Inspect operation\\n\\x1B[31m purpose</bold></warning>");
  expect(collapsed).toContain(`<muted>${JSON.stringify(payload)}</muted>`);
  expect(collapsed).not.toContain('"description"');
  expect(collapsed.match(/Inspect operation/g)?.length).toBe(1);
  expect(collapsed).not.toContain("\u001b");
  expect(collapsed.split("\n").length).toBe(2);
 });
}
test("operation renderers safely handle legacy and incomplete streamed arguments", () => {
 for (const name of names.slice(1)) {
  const tool = tools.get(`babysit_${name}`);
  for (const args of [undefined, {}, { id: "partial", text: "line\n\u001b" }, { description: "   ", ids: [] }, { description: null, id: "partial" }]) {
   const rendered = tool.renderCall(args, theme).render(10000).join("\n");
   expect(rendered).not.toContain("\u001b");
   for (const [key, value] of Object.entries(args ?? {})) {
    if (key !== "description") expect(rendered).toContain(JSON.stringify(value));
   }
  }
 }
});

function scenario(source: string, fakeCli = false) {
 const dir = mkdtempSync(path.join(os.tmpdir(), "babysit-operation-description-"));
 const root = path.join(dir, "root");
 const file = path.join(dir, "scenario.ts");
 const cli = path.join(dir, "forbidden-cli");
 if (fakeCli) writeFileSync(cli, `#!/bin/sh\nprintf called >> '${dir}/cli-called'\nexit 99\n`, { mode: 0o755 });
 writeFileSync(file, `import assert from 'node:assert/strict';
import fs from 'node:fs';
import extension from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const tools=new Map();
extension({registerTool:t=>tools.set(t.name,t),on(){},registerCommand(){},registerMessageRenderer(){},getActiveTools:()=>[],getThinkingLevel:()=> 'low',sendMessage(){}});
const ctx={hasUI:true,ui:{setWidget(){},theme:{fg:(_,s)=>s,bg:(_,s)=>s,bold:s=>s}},cwd:${JSON.stringify(import.meta.dir)},sessionManager:{getSessionId:()=> 'operation-description-test',getSessionFile:()=>undefined},model:{provider:'fake',id:'fake'}};
const call=(name,args)=>tools.get('babysit_'+name).execute('test',args,undefined,undefined,ctx);
${source}`);
 try {
  const result = spawnSync(process.execPath, [file], { cwd: import.meta.dir, env: { ...process.env, PI_BABYSIT_DIR: root, ...(fakeCli ? { PI_BABYSIT_CLI: cli } : {}) }, encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("invalid descriptions on every tool reject before CLI or filesystem effects", () => {
 scenario(`
const root=process.env.PI_BABYSIT_DIR;
const tree=()=>fs.existsSync(root)?fs.readdirSync(root,{recursive:true}).sort():[];
const initial=tree();
for(const name of ['run','check','send','wait','kill']) {
 for(const description of [undefined,null,42,false,{},[], '', ' \\t\\r\\n ']) {
  const args={id:'must-not-exist',command:'touch must-not-exist',text:'must-not-send'};
  if(description!==undefined) args.description=description;
  await assert.rejects(()=>call(name,args),/description/i);
  assert.deepEqual(tree(),initial,name+' created files');
 }
}
assert(!fs.existsSync(root+'/../cli-called'));
`, true);
});

test("real process operations preserve session purpose and deliver exact user text", () => {
 scenario(`
const purpose='Persistent process purpose';
const ids=[];
try {
 const started=await call('run',{name:'description-echo',description:'  '+purpose+'  ',command:'IFS= read -r line; printf "RECEIVED:%s\\\\n" "$line"; sleep 60',pty:true,continueAfterStart:true});
 assert(!started.isError,JSON.stringify(started)); const id=started.details.id; ids.push(id);
 const meta=()=>JSON.parse(fs.readFileSync(process.env.PI_BABYSIT_DIR+'/meta/'+id+'.json','utf8'));
 const unchanged=()=>assert.equal(meta().description,purpose);
 unchanged();
 assert(!(await call('check',{id,description:'Inspect process progress'})).isError); unchanged();
 const text='USER_TEXT_unchanged_42 with  two spaces';
 assert(!(await call('send',{id,text,description:'Deliver exact user text'})).isError); unchanged();
 const waited=await call('wait',{id,expect:'RECEIVED:'+text,timeout:'5s',description:'Await echoed user text'});
 assert(!waited.isError,JSON.stringify(waited)); unchanged();
 const checked=await call('check',{id,lines:50,description:'Read echo output'});
 assert(!checked.isError,JSON.stringify(checked));
 const output=checked.content.map(c=>c.text??'').join('\\n'); assert(output.includes('RECEIVED:'+text),output);
 for(const description of ['Inspect process progress','Deliver exact user text','Await echoed user text','Read echo output']) assert(!output.includes(description),output);
 assert(!(await call('kill',{id,description:'Terminate echo process'})).isError); unchanged();
} finally {for(const id of ids) await call('kill',{id,description:'Clean up process fixture'});}
`);
}, 35_000);
