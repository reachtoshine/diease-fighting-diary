const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ejs = require('ejs');
const { mealWindow, summarizeMeals, parseMealItems } = require('../lib/meal-records');

test('KST midnight changes the day independently of the server timezone', () => {
  assert.equal(mealWindow(new Date('2026-12-31T14:59:59.999Z')).today,'2026-12-31');
  const w = mealWindow(new Date('2026-12-31T15:00:00.000Z'));
  assert.equal(w.today,'2027-01-01');
  assert.equal(w.start.toISOString(),'2026-12-25T15:00:00.000Z');
  assert.equal(w.end.toISOString(),'2027-01-01T15:00:00.000Z');
  assert.deepEqual(w.labels,['2026-12-26','2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01']);
});

test('meal summary excludes out-of-window data and preserves zero-valued meals', () => {
  const w=mealWindow(new Date('2026-11-01T16:00:00Z'));
  const result=summarizeMeals([
    {date:w.start,mealType:'lunch',totalKcal:10},
    {date:w.end,mealType:'breakfast',totalKcal:999},
    {date:new Date('2026-11-01T15:00:00Z'),mealType:'breakfast',totalKcal:0},
    {date:new Date('2026-11-01T15:00:00Z'),mealType:'lunch',totalKcal:Infinity}
  ],w);
  assert.equal(result.kcalByMeal.breakfast,0);
  assert.deepEqual(result.mealChart.values,[10,0,0,0,0,0,0]);
});

test('meal item parser rejects non-numeric, malformed, excessive and blank items', () => {
  for(const raw of ['{','null','{}',JSON.stringify([{name:' ',kcal:1,weight:1}]),
    JSON.stringify([{name:'밥',kcal:null,weight:1}]),JSON.stringify([{name:'밥',kcal:'1',weight:1}]),
    JSON.stringify([{name:'밥',kcal:1,weight:100001}]),JSON.stringify(Array.from({length:101},()=>({name:'밥',kcal:1,weight:1})))]) {
    assert.throws(()=>parseMealItems(raw));
  }
  assert.deepEqual(parseMealItems('[{"name":" 밥 ","kcal":0,"weight":0.5}]'),[{name:'밥',kcal:0,weight:0.5}]);
});

test('meal chart keeps its KST calendar labels in a browser west of UTC', () => {
  const source=fs.readFileSync(path.join(__dirname,'../views/meal.ejs'),'utf8');
  const html=ejs.render(source,{kcalByMeal:{},mealChart:{labels:['2026-11-02'],values:[350]}});
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  const previousTZ=process.env.TZ;
  process.env.TZ='America/Los_Angeles';
  let config;
  try {
    vm.runInNewContext(script,{
      Date,
      document:{getElementById:()=>({getContext:()=>({})})},
      Chart:function(_ctx,options){config=options;}
    });
  } finally {
    if(previousTZ===undefined)delete process.env.TZ;else process.env.TZ=previousTZ;
  }
  assert.equal(config.data.labels[0],'2026-11-02');
});
