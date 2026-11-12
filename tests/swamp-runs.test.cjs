const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync('mods/swamp-runs/main.js', 'utf8');
function load(text, hooks = {}) {
  const state = new Map(), notifications = [];
  const element = () => new Proxy({}, {get: (_, name) => (...args) => {
    if (name === 'when' && args[0]) args[1](el);
    return el;
  }});
  const el = element();
  const context = vm.createContext({View: class {}, div: () => el, v_flex: () => el, h_flex: () => el,
    home: () => '/home/test', theme: () => ({}), props: () => ({}),
    setShared: (key, value) => state.set(key, value), shared: key => state.get(key),
    notify: value => notifications.push(value), ...hooks});
  vm.runInContext(text.replace(/^import .*;\n/gm, '').replace('export default class', 'class') + '\nthis.api = {topLevel, SwampRuns};', context);
  return {...context.api, context, state, notifications};
}
const original = require('./top-level-original.cjs');
const revised = load(source).topLevel;
const iso = n => new Date(1700000000000 + n).toISOString();
function row(kind, n, extra = {}) { return {kind, repo:'a', key:`${kind}-${n}`, startedAt:iso(n), status:'succeeded', ms:0, ...extra}; }
function same(rows) {
  const expected = original(rows), actual = revised(rows);
  assert.deepEqual(Array.from(actual), Array.from(expected));
  for (let i=0;i<actual.length;i++) assert.equal(actual[i], expected[i]);
}
test('inclusive tolerance, open windows, repo boundaries, invalid dates and ordering', () => {
  for (const extra of [{ms:1000}, {ms:null}, {ms:undefined}, {status:'running',ms:0}, {status:'suspended',ms:0}, {ms:-5000}, {ms:NaN}, {ms:Infinity}, {ms:'1000'}]) {
    const rows = [row('workflow', 10000, extra), ...[7999,8000,10000,13000,13001,100000].map(n=>row('method',n)), row('method',10000,{repo:'b'}), row('method',0,{startedAt:'bad'}), row('other',0)];
    same(rows); same(rows.reverse());
  }
  same([row('workflow',0,{startedAt:'bad'}),row('method',0)]);
  same([row('workflow',10000,{ms:20000}),row('workflow',15000),row('workflow',34000),row('method',30000),row('method',36000),row('method',36001)]);
  same([]); same([row('method',0)]);
});
test('4000 seeded differential histories preserve rows and order without mutation', () => {
  let seed=123456789;
  const random = n => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed%n; };
  for(let trial=0;trial<4000;trial++) {
    const rows=Array.from({length:random(100)}, (_,i)=>row(random(3) ? 'method':'workflow',random(100000),{
      key:String(i), repo:['a','b','c'][random(3)], status:['succeeded','failed','running','suspended','cancelled'][random(5)],
      ms:[undefined,null,-5000,NaN,0,random(20000)][random(6)], startedAt:random(20) ? iso(random(100000)):'invalid'
    }));
    rows.forEach(Object.freeze); Object.freeze(rows); same(rows);
  }
});
test('refresh caches once; render and announce do not recompute; counts and failures update', async () => {
  const app=load(source), view=new app.SwampRuns(); let pending;
  const cx={timer:{every(){}},spawn(fn){pending=fn(cx);},notify(){}};
  view.findSwamp=async()=>{view.swampChecked=true;}; view.repoList=async()=>['a'];
  const now=Date.now(); const rows=[row('workflow',0,{key:'wf',status:'running',startedAt:new Date(now).toISOString()}),row('method',0,{key:'child',status:'failed',startedAt:new Date(now).toISOString()}),row('method',0,{key:'old',status:'failed',startedAt:new Date(now-10000).toISOString()})];
  view.loadRepo=async()=>rows;
  vm.runInContext('const actualTopLevel = topLevel; this.calls = 0; topLevel = (runs) => { this.calls++; return actualTopLevel(runs); };',app.context);
  view.init({},cx); await pending;
  assert.equal(app.context.calls,1); assert.equal(view.top.length,2);
  assert.equal(app.state.get('swamp-runs.summary').running,1); assert.equal(app.state.get('swamp-runs.summary').failedToday,1);
  assert.equal(app.notifications.length,0);
  view.render(cx); view.filter='method'; view.failedOnly=true; view.render(cx); view.announce();
  assert.equal(app.context.calls,1);
  view.loadRepo=async()=>[row('method',0,{key:'new',status:'failed',startedAt:new Date(now).toISOString()})];
  view.refresh(cx); await pending;
  assert.equal(app.context.calls,2); assert.equal(app.notifications.length,1);
  assert.equal(app.state.get('swamp-runs.summary').running,0);
  view.loadRepo=async()=>{throw new Error('offline');}; view.refresh(cx); await pending;
  assert.equal(view.top.length,0); assert.equal(view.runs.length,0); assert.equal(view.repoErrors.a,'offline');
  view.render(cx);
});
test('large history benchmark (informational timing; deterministic parse-work bound)', () => {
  const rows=[...Array.from({length:950},(_,i)=>row('workflow',i*10000)),...Array.from({length:6000},(_,i)=>row('method',20000000+i))];
  const before=performance.now(); const expected=original(rows); const oldMs=performance.now()-before;
  const after=performance.now(); const actual=revised(rows); const newMs=performance.now()-after;
  assert.deepEqual(Array.from(actual),Array.from(expected));
  let parses=0;
  const counted=load(source,{Date:{parse(value){parses++; return Date.parse(value);}}});
  counted.topLevel(rows); assert.equal(parses,6950);
  console.log(JSON.stringify({methods:6000,workflows:950,originalMs:oldMs,optimizedMs:newMs,speedup:oldMs/newMs,dateParses:parses}));
});
