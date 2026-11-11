import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { registerModelsOn } from '../src/models.js';
import worker from '../src/index.js';
import { signToken } from '../src/jwt.js';
import { cents, creditKey } from '../src/credit.js';
let repl, conn, models, env, adminToken, customerToken, secret, account, product, order;
let seq = 0;
const pending = [];
async function call(path, method = 'GET', body, token = adminToken) {
  const response = await worker.fetch(new Request(`https://local.test${path}`, { method, headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'cf-connecting-ip':'127.0.0.1' }, ...(body ? {body:JSON.stringify(body)} : {}) }), env, { waitUntil: p => pending.push(p) });
  return { status: response.status, data: await response.json() };
}
const stock = async () => (await models.Product.findById(product._id)).stockQuantity;
before(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.24' } });
  conn = await mongoose.createConnection(repl.getUri()).asPromise(); models = registerModelsOn(conn);
  const admin = await models.Admin.create({ name:'מנהל בדיקה',email:'local@test.invalid',passwordHash:'unused',role:'admin' });
  const customer = await models.User.create({name:'בדיקה', phone:'0500000000',role:'customer'});
  const rate = {check: async (key, ms, max) => ({allowed:true,max,count:1,resetAt:Date.now()+ms})};
  const auth = {hashPassword:p => bcrypt.hash(p,4),verifyPassword:(p,h) => bcrypt.compare(p,h)};
  const binding = stub => ({idFromName: x=>x,get:()=>stub});
  env = { MONGO_URI:repl.getUri(), JWT_SECRET:randomBytes(48).toString('hex'), DIRECT_MODE:'1',NODE_ENV:'production',AUTH_DO:binding(auth),REALTIME_DO:binding({broadcast:async()=>({delivered:0})}),RATE_LIMIT_DO:binding(rate) };
  adminToken = await signToken({id:String(admin._id),role:'admin'},'1h',env);
  customerToken = await signToken({id:String(customer._id),role:'customer'},'1h',env);
  secret = randomBytes(16).toString('hex');
  const cat = await models.Category.create({name:'בדיקה',slug:'test'});
  product = await models.Product.create({name:'מוצר בדיקה',category:cat._id,price:12.5,stockQuantity:100});
  // Stub only calendar provider in this local test, not the application guards.
  const originalFetch = global.fetch;
  global.fetch = (input, opts) => String(input).includes('hebcal.com') ? Promise.resolve(new Response(JSON.stringify({items:[{category:'candles',date:'2099-01-01T16:00:00+02:00'},{category:'havdalah',date:'2099-01-02T20:00:00+02:00'}]}))) : originalFetch(input,opts);
});
after(async()=>{await Promise.allSettled(pending); await conn?.close(); await repl?.stop();});
const checkoutBody = () => ({paymentMethod:'credit',creditCredentials:{name:'לקוח בדיקה',password:secret},customer:{name:'קונה בדיקה',phone:'0500000000',address:{street:'בדיקה 1',city:'בדיקה'}},items:[{productId:String(product._id),quantity:2}]});
test('money parsing and name normalization',()=>{assert.equal(cents('-12.30',{signed:true}),-1230);assert.equal(cents('0'),0);for(const x of ['',null,'1e3',{},'0.001','NaN']) assert.throws(()=>cents(x));assert.equal(creditKey('  לקוח   בדיקה '),'לקוח בדיקה');});
test('credit account auth, uniqueness and non-disclosure',async()=>{
  assert.equal((await call('/api/admin/credit-accounts','GET',undefined,'')).status,401);
  assert.equal((await call('/api/admin/credit-accounts','GET',undefined,customerToken)).status,401);
  let r=await call('/api/admin/credit-accounts','POST',{name:'לקוח בדיקה',password:secret});assert.equal(r.status,201);account=r.data.account;assert.equal(account.balanceCents,0);assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(r).includes('passwordHash'));
  assert.equal((await call('/api/admin/credit-accounts','POST',{name:' לקוח  בדיקה ',password:secret})).status,409);
  assert.equal((await call('/api/admin/credit-accounts','POST',{name:{$ne:null},password:secret})).status,400);
});
test('wrong or disabled credit credentials cannot place order or reduce stock',async()=>{
  const before=await stock();const b=checkoutBody();b.creditCredentials.password='bad-password';const r=await call('/api/checkout','POST',b,'');assert.equal(r.status,401);assert.equal(await stock(),before);assert.equal(await models.Order.countDocuments(),0);
  await models.CreditAccount.updateOne({_id:account._id},{$set:{active:false}});assert.equal((await call('/api/checkout','POST',checkoutBody(),'')).status,401);await models.CreditAccount.updateOne({_id:account._id},{$set:{active:true}});
});
test('credit checkout snapshots account and reserves stock but does not add debt',async()=>{
  const r=await call('/api/checkout','POST',checkoutBody(),'');assert.equal(r.status,201);order=r.data.order;assert.equal(order.payment.provider,'credit');assert.equal(order.credit.name,'לקוח בדיקה');assert.equal(order.total,25);assert.equal(await stock(),98);assert.equal((await models.CreditAccount.findById(account._id)).balanceCents,0);assert.ok(!JSON.stringify(r).includes(secret));
});
test('shipping does not add debt; paid and missing delivery decision rejected',async()=>{
  assert.equal((await call(`/api/admin/orders/${order._id}/status`,'PATCH',{paymentStatus:'paid',fulfillmentStatus:'pending'})).status,409);
  assert.equal((await call(`/api/admin/orders/${order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'shipped'})).status,200);
  assert.equal((await models.CreditAccount.findById(account._id)).balanceCents,0);
  assert.equal((await call(`/api/admin/orders/${order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'delivered'})).status,400);
});
test('concurrent repeated delivery adds debt only once and conflicting decision rejects',async()=>{
  const b={paymentStatus:'pending',fulfillmentStatus:'delivered',creditDecision:{mode:'total',reason:''}};
  const results=await Promise.all(Array.from({length:5},()=>call(`/api/admin/orders/${order._id}/status`,'PATCH',b)));assert.ok(results.every(x=>x.status===200),JSON.stringify(results));
  assert.equal((await models.CreditAccount.findById(account._id)).balanceCents,2500);assert.equal(await models.CreditEntry.countDocuments({kind:'delivery'}),1);
  const conflict={...b,creditDecision:{mode:'skip',reason:''}};assert.equal((await call(`/api/admin/orders/${order._id}/status`,'PATCH',conflict)).status,409);
});
test('signed custom delivery preserves credit balance and no-add skips',async()=>{
  const r=await call('/api/checkout','POST',checkoutBody(),'');const id=r.data.order._id;
  await call(`/api/admin/orders/${id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'shipped'});
  assert.equal((await call(`/api/admin/orders/${id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'delivered',creditDecision:{mode:'custom',amount:'-40',reason:'תשלום יתר'}})).status,200);
  assert.equal((await models.CreditAccount.findById(account._id)).balanceCents,-1500);
  const next=await call('/api/checkout','POST',checkoutBody(),'');const nextId=next.data.order._id;
  await call(`/api/admin/orders/${nextId}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'shipped'});
  assert.equal((await call(`/api/admin/orders/${nextId}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'delivered',creditDecision:{mode:'skip',reason:''}})).status,200);assert.equal((await models.CreditAccount.findById(account._id)).balanceCents,-1500);
});
test('optimistic edits prevent overwriting concurrent balance and reset logs change',async()=>{
  const a=await models.CreditAccount.findById(account._id);const b={mode:'set',amount:'50',reason:'תיקון בדיקה',expectedVersion:a.version,requestId:crypto.randomUUID()};
  const results=await Promise.all([call(`/api/admin/credit-accounts/${a._id}/balance`,'PATCH',b),call(`/api/admin/credit-accounts/${a._id}/balance`,'PATCH',{...b,amount:'60',requestId:crypto.randomUUID()})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const latest=await models.CreditAccount.findById(a._id);assert.equal((await call(`/api/admin/credit-accounts/${a._id}/balance`,'PATCH',{mode:'reset',reason:'התקבל תשלום',expectedVersion:latest.version,requestId:crypto.randomUUID()})).status,200);assert.equal((await models.CreditAccount.findById(a._id)).balanceCents,0);
});
test('legacy offline orders unchanged, cancellation restores stock, disabled existing account delivery allowed',async()=>{
  const b=checkoutBody();delete b.creditCredentials;delete b.paymentMethod;const r=await call('/api/checkout','POST',b,'');assert.equal(r.status,201);assert.equal(r.data.order.payment.provider,'offline');assert.equal(r.data.order.status,'pending_payment');const before=await stock();assert.equal((await call(`/api/admin/orders/${r.data.order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'cancelled'})).status,200);assert.equal(await stock(),before+2);
  const cr=await call('/api/checkout','POST',checkoutBody(),'');await call(`/api/admin/orders/${cr.data.order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'shipped'});await models.CreditAccount.updateOne({_id:account._id},{$set:{active:false}});assert.equal((await call(`/api/admin/orders/${cr.data.order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'delivered',creditDecision:{mode:'total',reason:''}})).status,200);
  const h=await call(`/api/admin/credit-accounts/${account._id}/history`);assert.equal(h.status,200);assert.ok(h.data.entries.every(e=>e.actorId));assert.ok(!JSON.stringify(h).includes(secret));
});
test('legacy Express compatibility routes exercise same accounting and checkout guards',async()=>{
  const { createRequire }=await import('node:module'); const require=createRequire(new URL('../../backend/server.js',import.meta.url));
  const express=require('express');const legacyMongoose=require('mongoose');process.env.JWT_SECRET=env.JWT_SECRET;
  await legacyMongoose.connect(repl.getUri());const lm=require('./src/models/index.js');
  const legacyAdmin=await lm.Admin.findOne({email:'local@test.invalid'});const jwt=require('jsonwebtoken');const t=jwt.sign({id:String(legacyAdmin._id),role:'admin'},env.JWT_SECRET);
  const {resetShabbatCache}=require('./src/middleware/shabbat');resetShabbatCache();
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:String(legacyAdmin._id),role:'admin'};next();});app.use(require('./src/routes/creditCompatibility'));app.use((e,req,res,next)=>res.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const port=server.address().port;
  const lc=async(p,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${port}${p}`,{method,headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
  try{let r=await lc('/api/admin/credit-accounts');assert.equal(r.status,200);assert.equal(r.data.accounts.length,1);
    r=await lc('/api/admin/credit-accounts','POST',{name:'לקוח מקומי שני',password:secret});assert.equal(r.status,201);const a=r.data.account;
    r=await lc(`/api/admin/credit-accounts/${a._id}/balance`,'PATCH',{mode:'set',amount:'-15.25',reason:'בדיקת זכות',expectedVersion:a.version,requestId:crypto.randomUUID()});assert.equal(r.status,200);assert.equal(r.data.account.balanceCents,-1525);
    const body=checkoutBody();body.creditCredentials.name='לקוח מקומי שני';r=await lc('/api/checkout','POST',body); // no customer token: admin bearer intentionally disallowed
    assert.equal(r.status,401);
    const raw=await fetch(`http://127.0.0.1:${port}/api/checkout`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});r={status:raw.status,data:await raw.json()};assert.equal(r.status,201,JSON.stringify(r));
    const id=r.data.order._id;assert.equal((await lc(`/api/admin/orders/${id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'shipped'})).status,200);
    assert.equal((await lc(`/api/admin/orders/${id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'delivered',creditDecision:{mode:'total',reason:''}})).status,200);
    assert.equal((await lm.CreditAccount.findById(a._id)).balanceCents,975);
  }finally{await new Promise(resolve=>server.close(resolve));await legacyMongoose.disconnect();}
});

test('active alone gates orderability; zero stock orders and cancellation never invent stock', async () => {
  const category=await models.Category.create({name:'זמינות בלבד',slug:'availability-only'});
  const zero=await models.Product.create({name:'זמין באפס',category:category._id,price:3,stockQuantity:0,active:true});
  const low=await models.Product.create({name:'זמין בכמות קטנה',category:category._id,price:4,stockQuantity:2,active:true});
  const off=await models.Product.create({name:'חסר למרות כמות',category:category._id,price:5,stockQuantity:9,active:false});
  const cart=[{productId:String(zero._id),quantity:3},{productId:String(low._id),quantity:5}];
  assert.equal((await call('/api/checkout/validate','POST',{items:cart},'')).data.valid,true);
  assert.equal((await call('/api/checkout/validate','POST',{items:[{productId:String(off._id),quantity:1}]},'')).data.valid,false);
  const payload=checkoutBody();delete payload.paymentMethod;delete payload.creditCredentials;payload.items=cart;
  const placed=await call('/api/checkout','POST',payload,'');assert.equal(placed.status,201);
  const saved=await models.Order.findById(placed.data.order._id).lean();
  assert.deepEqual(saved.items.map(i=>i.stockDeducted),[0,2]);
  assert.equal((await models.Product.findById(zero._id)).stockQuantity,0);
  assert.equal((await models.Product.findById(low._id)).stockQuantity,0);
  assert.equal((await call(`/api/admin/orders/${saved._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'cancelled'})).status,200);
  assert.equal((await models.Product.findById(zero._id)).stockQuantity,0);
  assert.equal((await models.Product.findById(low._id)).stockQuantity,2);
  await call(`/api/admin/orders/${saved._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'cancelled'});
  assert.equal((await models.Product.findById(low._id)).stockQuantity,2,'repeated cancellation must not restore twice');
  payload.items=[{productId:String(off._id),quantity:1}];
  assert.equal((await call('/api/checkout','POST',payload,'')).status,400);
  await models.StorefrontConfig.findByIdAndUpdate('storefront',{$set:{featuredProduct:zero._id}},{upsert:true});
  assert.equal(String((await call('/api/featured-product','GET',undefined,'')).data.product._id),String(zero._id));
  assert.equal((await call('/api/admin/catalog/featured-product','PUT',{productId:String(zero._id)})).status,200);
});

test('historical orders without stockDeducted restore their original reservation exactly once',async()=>{
  const body=checkoutBody();delete body.paymentMethod;delete body.creditCredentials;
  const placed=await call('/api/checkout','POST',body,'');assert.equal(placed.status,201);
  await models.Order.updateOne({_id:placed.data.order._id},{$unset:{'items.0.stockDeducted':1}});
  const before=await stock();
  await call(`/api/admin/orders/${placed.data.order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'cancelled'});
  assert.equal(await stock(),before+2);
  await call(`/api/admin/orders/${placed.data.order._id}/status`,'PATCH',{paymentStatus:'pending',fulfillmentStatus:'cancelled'});
  assert.equal(await stock(),before+2);
});
