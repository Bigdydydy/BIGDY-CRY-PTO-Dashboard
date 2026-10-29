const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const store=require('../server/trade_store');const D=86400000;
test('60-day retention persists pruning without incoming trades and updates richer duplicate',()=>{
 const file=path.join(__dirname,'../data/block_trades_RETENTIONTEST.json');const now=Date.now();
 fs.writeFileSync(file,JSON.stringify({trades:[{trade_id:'old',timestamp:now-61*D},{trade_id:'keep',timestamp:now-45*D}]}));
 try {let r=store.recordAndMergeTrades('RETENTIONTEST',[]);assert.equal(r.stats.retentionDays,60);assert.deepEqual(r.trades.map(x=>x.trade_id),['keep']);assert.equal(JSON.parse(fs.readFileSync(file)).trades.length,1);store.recordAndMergeTrades('RETENTIONTEST',[{trade_id:'keep',timestamp:now-45*D,iv:42}]);assert.equal(JSON.parse(fs.readFileSync(file)).trades[0].iv,42);}finally{fs.unlinkSync(file);}
});
test('30d filter stays distinct from 60d and all inventory',()=>{const now=Date.now(),rows=[{timestamp:now-D},{timestamp:now-20*D},{timestamp:now-45*D},{timestamp:now-61*D}];assert.equal(store.filterTradesByWindow(rows,'30d').length,2);assert.equal(store.filterTradesByWindow(rows,'60d').length,3);assert.equal(store.filterTradesByWindow(rows,'7d').length,1);assert.equal(store.filterTradesByWindow(rows,'all').length,4);});
