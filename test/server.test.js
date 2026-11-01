const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { createTestServer, userId, passwordHash } = require('./support/server');
const registration = { username: 'new-reader', password: 'correct-password', confirmPassword: 'correct-password', email: 'new@example.com', nickname: '새 독자', age: '10-19' };

test('Naver login never authenticates a local account with the same identifier', async t => {
  const local = { _id: new ObjectId(), username: 'collision', provider: 'local', password: passwordHash };
  const s = await createTestServer(t, { records: { users: [local] } });
  const user = await s.verify('naver', 'access', 'refresh', { id: 'collision', displayName: '네이버', _json: {} });
  assert.equal(user.provider, 'naver');
  assert.notEqual(String(user._id), String(local._id));
});

test('legacy Naver accounts keep their user id and records', async t => {
  const legacy = { _id: new ObjectId(), username: 'legacy-id', provider: 'naver' };
  const s = await createTestServer(t, { records: { users: [legacy] } });
  const user = await s.verify('naver', 'access', 'refresh', { id: 'legacy-id', displayName: '기존', _json: {} });
  assert.equal(String(user._id), String(legacy._id));
  assert.equal(s.collections.users.length, 1);
});

test('local login skips Naver accounts sharing a username', async t => {
  const users = [ { _id: new ObjectId(), username: 'reader', provider: 'naver' },
    { _id: userId, username: 'reader', provider: 'local', password: passwordHash } ];
  const s = await createTestServer(t, { records: { users } });
  const user = await s.verify('local', 'reader', 'correct-password');
  assert.equal(String(user._id), String(userId));
});

test('local accounts without a provider still authenticate', async t => {
  const s = await createTestServer(t, { records: { users: [{ _id: userId, username: 'old-user', password: passwordHash }] } });
  const user = await s.verify('local', 'old-user', 'correct-password');
  assert.equal(String(user._id), String(userId));
});

test('registration rejects mismatched confirmation without inserting a user', async t => {
  const s = await createTestServer(t);
  const { token } = await s.form('/register');
  const res = await s.request('/register', { method: 'POST', body: { ...registration, confirmPassword: 'different', _csrf: token } });
  assert.equal(res.status, 400);
  assert.equal(s.collections.users.length, 1);
});

test('registration trims before validating and rejects whitespace-only names', async t => {
  const s = await createTestServer(t);
  const { token } = await s.form('/register');
  const res = await s.request('/register', { method: 'POST', body: { ...registration, nickname: '   ', _csrf: token } });
  assert.equal(res.status, 400);
});

test('ordinary punctuation in a memo is accepted and stored as text', async t => {
  const s = await createTestServer(t);
  await s.login();
  const { token } = await s.form('/record/temp');
  const res = await s.request('/record/temp', { method: 'POST', body: { temperature: '37.5', memo: '체온 37.5도. 비용 $5.', _csrf: token } });
  assert.equal(res.status, 302);
  assert.equal(s.collections.tempRecords[0].memo, '체온 37.5도. 비용 $5.');
});

test('GET cancer confirmation cannot create a health profile', async t => {
  const s = await createTestServer(t);
  await s.login();
  await s.request('/cancer-info/confirm?cancer=위암&stage=1&susul=before&hangam=none');
  assert.equal((s.collections.userdata || []).length, 0);
});

test('cancer profile uses an authenticated CSRF-protected POST', async t => {
  const s = await createTestServer(t);
  await s.login();
  const { token } = await s.form('/cancer-info');
  assert.ok(token, 'profile form provides a CSRF token');
  const body = { cancer: '위암', stage: '1', susul: 'before', hangam: 'none' };
  const blocked = await s.request('/cancer-info/confirm', { method: 'POST', body });
  assert.equal(blocked.status, 403);
  const saved = await s.request('/cancer-info/confirm', { method: 'POST', body: { ...body, _csrf: token } });
  assert.equal(saved.status, 302);
  assert.equal(s.collections.userdata[0].cancer, '위암');
});

test('same-meal entries sum on the KST day and charts cover exactly seven days', async t => {
  const mealRecords = [
    { userId, mealType: 'breakfast', totalKcal: 120, date: new Date('2026-11-01T15:10:00Z') },
    { userId, mealType: 'breakfast', totalKcal: 230, date: new Date('2026-11-01T15:20:00Z') },
    { userId, mealType: 'dinner', totalKcal: 900, date: new Date('2026-11-01T14:59:00Z') },
    { userId, mealType: 'lunch', totalKcal: 700, date: new Date('2026-10-20T00:00:00Z') },
    { userId: new ObjectId(), mealType: 'breakfast', totalKcal: 9999, date: new Date('2026-11-01T15:30:00Z') }
  ];
  const s = await createTestServer(t, { records: { mealRecords } });
  await s.login();
  const res = await s.request('/record/meal');
  assert.equal(res.status, 200);
  assert.match(res.text, /350\s*kcal/);
  const chart = JSON.parse(res.text.match(/const mealChart = (\{.*\});/)[1]);
  assert.deepEqual(chart.labels, ['2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01','2026-11-02']);
  assert.deepEqual(chart.values, [0,0,0,0,0,900,350]);
});

for (const [name, items] of [ ['empty', []], ['null', [null]], ['negative kcal', [{ name:'밥', kcal:-1, weight:100 }]],
  ['infinite kcal', [{ name:'밥', kcal:'Infinity', weight:100 }]], ['zero weight', [{ name:'밥', kcal:120, weight:0 }]],
  ['missing name', [{ kcal:120, weight:100 }]] ]) {
  test(`meal rejects ${name} items without writing records`, async t => {
    const s = await createTestServer(t); await s.login();
    const { token } = await s.form('/meal/breakfast');
    const res = await s.request('/record/meal/breakfast', { method: 'POST', body: { items: JSON.stringify(items), _csrf: token } });
    assert.equal(res.status, 400);
    assert.equal((s.collections.mealRecords || []).length, 0);
  });
}

test('valid decimal meal items are saved with their total', async t => {
  const s = await createTestServer(t); await s.login();
  const { token } = await s.form('/meal/breakfast');
  const res = await s.request('/record/meal/breakfast', { method:'POST', body:{ _csrf: token, items: JSON.stringify([{name:'밥',kcal:120.5,weight:100},{name:'국',kcal:20,weight:50}]) } });
  assert.equal(res.status,302);
  assert.equal(s.collections.mealRecords[0].totalKcal,140.5);
});

test('food API preserves decimal calories and applies an abort deadline', async t => {
  let options;
  const s = await createTestServer(t, { upstream: async (_url, opts) => {
    options = opts;
    return { ok:true, json: async () => ({ body:{ items:[{FOOD_NM_KR:'밥',AMT_NUM1:'123.45',SERVING_SIZE:'100g'}] } }) };
  } });
  const res = await s.request('/api/food?k=밥');
  assert.equal(res.status,200);
  assert.equal(JSON.parse(res.text)[0].kcal,123.45);
  assert.ok(options?.signal, 'upstream fetch has a deadline');
});

test('food API returns an empty result for an empty upstream list', async t => {
  const s = await createTestServer(t, { upstream: async () => ({ ok:true, json: async () => ({ body:{ items:null, totalCount:0 } }) }) });
  const res = await s.request('/api/food?k=없는음식');
  assert.equal(res.status,200);
  assert.deepEqual(JSON.parse(res.text),[]);
});

test('food API does not treat an upstream HTTP failure as a successful result', async t => {
  const s = await createTestServer(t, { upstream: async () => ({ ok:false, json: async () => ({body:{items:[]}}) }) });
  const res = await s.request('/api/food?k=밥');
  assert.equal(res.status,502);
});

test('password reset page does not promise an unavailable email', async t => {
  const s = await createTestServer(t);
  const res = await s.request('/forgot-password');
  assert.equal(res.status,200);
  assert.doesNotMatch(res.text,/action="\/forgot-password"/);
  assert.match(res.text,/준비 중/);
});

for (const [type, body, collection] of [
  ['exercise', {type:'걷기',duration:'30',intensity:'low',memo:'30분. 가볍게.'},'exerciseRecords'],
  ['bowel', {status:'normal',count:'1'},'bowelRecords'],
  ['temp', {temperature:'36.5'},'tempRecords'],
  ['pressure', {systolic:'120',diastolic:'80',glucose:''},'pressureRecords'],
  ['weight', {weight:'60.5',bodyFat:''},'weightRecords'],
  ['mood', {mood:'good',energy:'high'},'moodRecords'],
  ['pain', {level:'0',location:'복부'},'painRecords'],
  ['water', {amount:'1500'},'waterRecords']
]) {
  test(`${type} saves for its owner and renders a chronological chart`, async t => {
    const s = await createTestServer(t); await s.login();
    const {token} = await s.form(`/record/${type}`);
    const saved = await s.request(`/record/${type}`, {method:'POST',body:{...body,_csrf:token}});
    assert.equal(saved.status,302);
    assert.equal(String(s.collections[collection][0].userId),String(userId));
    const page = await s.request(`/record/${type}`);
    assert.equal(page.status,200);
    const chart = JSON.parse(page.text.match(/const chartData = (\{.*\});/)[1]);
    assert.equal(chart.labels.length,1);
    const want = {exercise:30,bowel:1,temp:36.5,pressure:120,weight:60.5,mood:4,pain:0,water:1500}[type];
    assert.deepEqual(type === 'pressure' ? chart.systolic : chart.values,[want]);
  });
}

test('record chart keeps only the latest seven records in chronological order and excludes other users', async t => {
  const tempRecords = Array.from({length:9},(_,i)=>({userId,temperature:36+i/10,date:new Date(`2026-10-${String(20+i).padStart(2,'0')}T00:00:00Z`)}));
  tempRecords.push({userId:new ObjectId(),temperature:45,date:new Date('2026-11-01T00:00:00Z')});
  const s = await createTestServer(t,{records:{tempRecords}}); await s.login();
  const page = await s.request('/record/temp');
  const chart = JSON.parse(page.text.match(/const chartData = (\{.*\});/)[1]);
  assert.deepEqual(chart.values,[36.2,36.3,36.4,36.5,36.6,36.7,36.8]);
});

test('optional zero body fat is preserved instead of replaced with null', async t => {
  const s = await createTestServer(t); await s.login();
  const {token} = await s.form('/record/weight');
  const saved = await s.request('/record/weight',{method:'POST',body:{weight:'60',bodyFat:'0',_csrf:token}});
  assert.equal(saved.status,302);
  assert.equal(s.collections.weightRecords[0].bodyFat,0);
});

test('invalid object-shaped login identifier is rejected without a database query injection', async t => {
  const s = await createTestServer(t);
  const {token} = await s.form('/login');
  const res = await s.request('/login',{method:'POST',body:{'username[$ne]':'',password:'correct-password',_csrf:token}});
  assert.equal(res.location,'/login?error=invalid');
});

test('password whitespace remains significant during registration and login', async t => {
  const s = await createTestServer(t);
  const {token} = await s.form('/register');
  const saved = await s.request('/register',{method:'POST',body:{...registration,password:' padded-password ',confirmPassword:' padded-password ',_csrf:token}});
  assert.equal(saved.status,302);
  assert.ok(await s.verify('local','new-reader',' padded-password '));
  assert.equal(await s.verify('local','new-reader','padded-password'),false);
});

test('food API distinguishes an abort from an empty search', async t => {
  const s = await createTestServer(t,{upstream:async()=>{ const err=new Error('timeout');err.name='TimeoutError';throw err; }});
  const res = await s.request('/api/food?k=밥');
  assert.equal(res.status,504);
});

for(const items of [undefined,false,0]) {
  test(`food API rejects malformed items (${String(items)}) without claiming an empty result`, async t => {
    const s=await createTestServer(t,{upstream:async()=>({ok:true,json:async()=>({body:{items}})})});
    const res=await s.request('/api/food?k=밥');
    assert.equal(res.status,502);
  });
}

test('food API accepts an explicit zero-count empty search without items', async t => {
  const s=await createTestServer(t,{upstream:async()=>({ok:true,json:async()=>({body:{totalCount:0}})})});
  const res=await s.request('/api/food?k=밥');
  assert.equal(res.status,200);
  assert.deepEqual(JSON.parse(res.text),[]);
});

test('food API rejects application-level errors even when HTTP status is OK', async t => {
  const s=await createTestServer(t,{upstream:async()=>({ok:true,json:async()=>({header:{resultCode:'99'},body:{items:[]}})})});
  const res=await s.request('/api/food?k=밥');
  assert.equal(res.status,502);
});

test('a selectable long food name is saved using the existing 50-character storage limit', async t => {
  const name='가'.repeat(51);
  const s=await createTestServer(t,{upstream:async()=>({ok:true,json:async()=>({body:{items:[{FOOD_NM_KR:name,AMT_NUM1:'120'}]}})})});
  await s.login();
  const search=await s.request('/api/food?k=밥');
  const food=JSON.parse(search.text)[0];
  const {token}=await s.form('/meal/breakfast');
  const saved=await s.request('/record/meal/breakfast',{method:'POST',body:{_csrf:token,items:JSON.stringify([{name:food.name,kcal:food.kcal,weight:100}])}});
  assert.equal(saved.status,302);
  assert.equal(s.collections.mealRecords[0].items[0].name,'가'.repeat(50));
});

test('legacy username sessions fail closed when two providers share the identifier', async t => {
  const s=await createTestServer(t,{records:{users:[
    {_id:new ObjectId(),username:'shared',provider:'local',password:passwordHash},
    {_id:new ObjectId(),username:'shared',provider:'naver'}
  ]}});
  assert.equal(await s.deserialize({id:'shared',username:'shared'}),false);
});

test('unambiguous legacy username sessions keep working', async t => {
  const s=await createTestServer(t);
  assert.equal(String((await s.deserialize({id:'reader',username:'reader'}))._id),String(userId));
});

test('server exports the Express handler for Vercel without opening a listener', async t => {
  const s=await createTestServer(t);
  assert.equal(s.exportedApp,s.app);
  assert.equal(s.connectionAttempts,0);
});

test('first serverless requests await and share one database initialization', async t => {
  let connected=false;
  const s=await createTestServer(t,{databaseConnect:async()=>{
    await new Promise(resolve=>setTimeout(resolve,50));connected=true;
  }});
  const pages=await Promise.all([s.request('/login'),s.request('/register')]);
  assert.ok(connected);
  assert.equal(s.connectionAttempts,1);
  assert.deepEqual(pages.map(p=>p.status),[200,200]);
});

test('a transient initialization failure produces an error and retries on the next request', async t => {
  const s=await createTestServer(t,{databaseConnect:async attempt=>{if(attempt===1)throw new Error('test unavailable');}});
  const first=await s.request('/login');
  assert.equal(first.status,500);
  const next=await s.request('/login');
  assert.equal(next.status,200);
  assert.equal(s.connectionAttempts,2);
});
