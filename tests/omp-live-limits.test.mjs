import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,chmod,readdir} from 'node:fs/promises';
import {createServer,createConnection} from 'node:net';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {startLiveEndpoint,sendLiveMessage,listLiveEndpoints,requestEndpoint} from '../features/tg-ctl/omp-live-runtime.mjs';
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'ol-limit-')); const received=[];
 const endpoint=await startLiveEndpoint({root,snapshot:()=>({sessionId:'s',cwd:'/test'}),send:t=>received.push(t)});
 t.after(async()=>{await endpoint.close();await rm(root,{recursive:true,force:true});});
 return {root,endpoint,received,meta:JSON.parse(await readFile(endpoint.metadataPath,'utf8'))};
}
test('unrelated stalled endpoint cannot delay a send to the requested original',async t=>{
 const f=await fixture(t),other=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore'});
 t.after(()=>other.kill('SIGTERM')); const socket=join(f.root,'stalled.sock');
 const connections=[]; const server=createServer(s=>connections.push(s)); await new Promise(r=>server.listen(socket,r));await chmod(socket,0o600);
 t.after(()=>{connections.forEach(s=>s.destroy());server.close();});
 const meta={...f.meta,pid:other.pid,instanceId:randomBytes(16).toString('hex'),socket};
 await writeFile(join(f.root,`${other.pid}-${meta.instanceId}.json`),JSON.stringify(meta),{mode:0o600});
 const before=Date.now();await sendLiveMessage({root:f.root,pid:process.pid,requestId:'target',text:'only target'});
 assert(Date.now()-before<500,'target send must not await a different host');
 assert.deepEqual(f.received,['only target']);
 // #458: a live host that accepts but does not answer is listed alive-busy, within one bounded probe.
 const start=Date.now();const rows=await listLiveEndpoints(f.root);assert(Date.now()-start<2000);
 assert.deepEqual(rows.find(r=>r.pid===other.pid)?.busy,true);assert.equal(rows.length,2);
});
test('more than 256 dead owned records do not disable the one live original',async t=>{
 const f=await fixture(t);
 for(let i=0;i<270;i++){
  const meta={...f.meta,pid:90000000+i,instanceId:randomBytes(16).toString('hex'),socket:join(f.root,'gone.sock')};
  await writeFile(join(f.root,`${meta.pid}-${meta.instanceId}.json`),JSON.stringify(meta),{mode:0o600});
 }
 assert.equal((await listLiveEndpoints(f.root)).length,1);
 assert.equal((await readdir(f.root)).filter(n=>n.endsWith('.json')).length,1);
});
test('receipt capacity fails closed without forgetting a prior accepted ID',async t=>{
 const f=await fixture(t);
 for(let i=0;i<4096;i++) await requestEndpoint(f.meta,{op:'send',sessionId:'s',requestId:`r-${i}`,text:'x'});
 await assert.rejects(requestEndpoint(f.meta,{op:'send',sessionId:'s',requestId:'overflow',text:'x'}),/receipt_capacity_reached/);
 assert.equal((await requestEndpoint(f.meta,{op:'send',sessionId:'s',requestId:'r-0',text:'x'})).accepted,true);
 assert.equal(f.received.length,4096);
});
test('oversized and idle connections are closed without callback delivery',async t=>{
 const f=await fixture(t);
 const oversized=createConnection(f.meta.socket);t.after(()=>oversized.destroy());let result='';
 oversized.on('data',b=>{result+=b;});await new Promise(r=>oversized.once('connect',r));
 const closed=new Promise(r=>oversized.once('close',r));oversized.on('error',()=>{});oversized.write('x'.repeat(110000));await closed;
 assert.match(result,/frame_too_large/);
 const idle=createConnection(f.meta.socket);t.after(()=>idle.destroy());idle.on('error',()=>{});
 const start=Date.now();await new Promise(r=>idle.once('close',r));assert(Date.now()-start<3000);
 assert.deepEqual(f.received,[]);
});
