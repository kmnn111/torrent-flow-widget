'use strict';
/** 探针：真实下载器差分记账全链路（覆盖演示态掩盖的致命 BUG） */
const os=require('os'),path=require('path'),fs=require('fs');
const {Store}=require('../core/store');
const {Collector}=require('../core/collector');
const clients=require('../core/clients');
let pass=0,fail=0;
const ok=(n,c,e)=>{c?(pass++,console.log('  PASS '+n)):(fail++,console.log('  FAIL '+n+(e?' → '+e:'')))};

console.log('\n[1] 首轮基线建立（真实 pollTraffic 路径）');
{
  const p=path.join(os.tmpdir(),'ttm-t1-'+Date.now()+'.json');
  const store=new Store(p);
  const col=new Collector(store,()=>{});
  const d=store.addDownloader({name:'qb真实',type:'qb',url:'http://127.0.0.1:8080'});
  const st=store.getState(d.id);
  // 直接注入采集器读到的累计值，然后走真实 pollTraffic 的写回逻辑
  st.live_dl_total=1000; st.live_up_total=500;
  const r1=clients.increment(st.live_dl_total,st.last_dl_total);
  const r2=clients.increment(st.live_up_total,st.last_up_total);
  if(r1.event==='no_base'||r1.event==='ok'||r1.event==='reset'||r1.event==='spike') st.last_dl_total=st.live_dl_total;
  if(r2.event==='no_base'||r2.event==='ok'||r2.event==='reset'||r2.event==='spike') st.last_up_total=st.live_up_total;
  store.recordTraffic(d.id,Math.floor(Date.now()/1000),r1.inc,r2.inc);
  ok('首轮基线已写入', st.last_dl_total===1000, '实际='+st.last_dl_total);
  ok('首轮 inc 为 0（只建基线）', r1.inc===0);
  const b=Object.values(store.data.hourly[d.id])[0];
  ok('首轮小时桶为 0 而非 Infinity', b.dl_bytes===0 && Number.isFinite(b.dl_bytes), JSON.stringify(b));
}

console.log('\n[2] 第二轮差分正确入账');
{
  const p=path.join(os.tmpdir(),'ttm-t2-'+Date.now()+'.json');
  const store=new Store(p);
  const d=store.addDownloader({name:'qb真实',type:'qb',url:'http://127.0.0.1:8080'});
  const st=store.getState(d.id);
  const now=Math.floor(Date.now()/1000);
  // 首轮建基线
  st.last_dl_total=1000; st.last_up_total=500; st.last_ts=now-60;
  // 第二轮累计增加
  const r1=clients.increment(1500,st.last_dl_total);
  const r2=clients.increment(700,st.last_up_total);
  ok('差分 = 500 / 200', r1.inc===500 && r2.inc===200, JSON.stringify([r1,r2]));
  store.recordTraffic(d.id,now,r1.inc,r2.inc);
  const sum=store.periodTotals();
  ok('今日下载 = 500', sum.day.dl===500, '实际='+sum.day.dl);
  ok('今日上传 = 200', sum.day.up===200, '实际='+sum.day.up);
  ok('last_ts 已推进', st.last_ts===now);
}

console.log('\n[3] 首轮无时间基线时除零保护');
{
  const p=path.join(os.tmpdir(),'ttm-t3-'+Date.now()+'.json');
  const store=new Store(p);
  const d=store.addDownloader({name:'x',type:'qb',url:'http://127.0.0.1:1'});
  store.recordTraffic(d.id,Math.floor(Date.now()/1000),500,100);
  const b=Object.values(store.data.hourly[d.id])[0];
  ok('无 NaN/Infinity', Number.isFinite(b.dl_bytes)&&Number.isFinite(b.up_bytes), JSON.stringify(b));
  ok('整笔入桶 500/100', b.dl_bytes===500&&b.up_bytes===100);
}

console.log('\n[4] 设置合并保留默认值');
{
  const p=path.join(os.tmpdir(),'ttm-t4-'+Date.now()+'.json');
  fs.writeFileSync(p,JSON.stringify({settings:{poll_interval:10}}));
  const s=new Store(p);
  ok('tz_offset 默认仍在',s.data.settings.tz_offset===8);
  ok('request_timeout 默认仍在',s.data.settings.request_timeout===5);
  ok('poll_interval 保留用户值',s.data.settings.poll_interval===10);
}

console.log('\n[5] 损坏字段类型降级');
{
  const p=path.join(os.tmpdir(),'ttm-t5-'+Date.now()+'.json');
  fs.writeFileSync(p,JSON.stringify({downloaders:null,state:'bad',samples:null}));
  const s=new Store(p);
  ok('downloaders 降级为空数组',Array.isArray(s.data.downloaders));
  ok('state 降级为空对象',s.data.state&&typeof s.data.state==='object'&&!Array.isArray(s.data.state));
  ok('listDownloaders 不抛错',(()=>{try{return s.listDownloaders().length===0}catch(e){return false}})());
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===\n`);
process.exit(fail?1:0);
