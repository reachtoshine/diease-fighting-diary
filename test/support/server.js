const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const express = require('express');
const session = require('express-session');
const { Passport } = require('passport');
const { ObjectId } = require('mongodb');
const bcrypt = require('bcrypt');

const root = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(root, 'server.js'));
const userId = new ObjectId('111111111111111111111111');
const passwordHash = bcrypt.hashSync('correct-password', 4);

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(doc, part));
    if (key === '$and') return expected.every(part => matches(doc, part));
    const actual = doc[key];
    if (expected instanceof ObjectId) return String(actual) === String(expected);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([op, value]) => {
        if (op === '$exists') return (actual !== undefined) === value;
        if (op === '$gte') return actual >= value;
        if (op === '$lte') return actual <= value;
        if (op === '$lt') return actual < value;
        if (op === '$ne') return actual !== value;
        throw new Error(`Unsupported filter ${op}`);
      });
    }
    return actual === expected;
  });
}

async function createTestServer(t, { records = {}, upstream, databaseConnect = async () => {}, now = '2026-11-01T16:00:00.000Z' } = {}) {
  let connectionAttempts = 0;
  const collections = {
    users: [{ _id: userId, username: 'reader', provider: 'local', password: passwordHash,
      nickname: '독자', email: 'reader@example.com' }],
    ...records
  };
  const db = {
    collection(name) {
      const docs = collections[name] ||= [];
      return {
        async findOne(filter) { return docs.find(doc => matches(doc, filter)) || null; },
        async insertOne(doc) { doc._id ||= new ObjectId(); docs.push(doc); return { insertedId: doc._id }; },
        find(filter) {
          let selected = docs.filter(doc => matches(doc, filter));
          return {
            sort(order) { const [key, dir] = Object.entries(order)[0]; selected.sort((a,b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir); return this; },
            limit(n) { selected = selected.slice(0,n); return this; },
            async toArray() { return selected; }
          };
        }
      };
    }
  };
  const app = express();
  app.listen = () => ({ close() {} }); // Suppress production startup; the test owns the HTTP server.
  const testExpress = () => app;
  Object.assign(testExpress, express);
  const passport = new Passport();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = {
    require(name) {
      if (name === 'express') return testExpress;
      if (name === 'passport') return passport;
      if (name === 'dotenv') return { config() {} };
      if (name === 'connect-mongo') return { create() { return undefined; } };
      if (name === 'express-session') return options => session({ ...options, store: new session.MemoryStore() });
      if (name === 'mongodb') return { ObjectId, MongoClient: class { async connect() { connectionAttempts++; await databaseConnect(connectionAttempts); return { db: () => db }; } } };
      return localRequire(name);
    },
    __dirname: root,
    process: { env: { SESSION_SECRET: 'test-only-session-secret', MONGODB_URI: 'unused',
      NAVER_CLIENT_ID: 'test', NAVER_CLIENT_SECRET: 'test', CALLBACK_URL: 'http://localhost/callback/naver' }, nextTick: process.nextTick },
    console: { log() {}, error() {} },
    fetch: upstream || (() => { throw new Error('Unexpected upstream network request'); }),
    AbortSignal,
    Promise,
    Date: FixedDate,
    module: { exports: {} },
    exports: {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context, { filename: path.join(root, 'server.js') });
  await new Promise(resolve => setImmediate(resolve));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  let cookie = '';
  async function request(url, { method = 'GET', body } = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body) : undefined
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async function form(url) {
    const res = await request(url);
    return { ...res, token: res.text.match(/name="_csrf" value="([^"]+)"/)?.[1] };
  }
  async function login() {
    const { token } = await form('/login');
    const res = await request('/login', { method: 'POST', body: { _csrf: token, username: 'reader', password: 'correct-password' } });
    if (res.status !== 302 || res.location === '/login?error=invalid') throw new Error(`Login failed: ${res.status} ${res.location}`);
  }
  async function verify(strategy, ...args) {
    await request('/login');
    return new Promise((resolve, reject) => passport._strategy(strategy)._verify(...args, (err, user) => err ? reject(err) : resolve(user)));
  }
  const deserialize = async value => {
    await request('/login');
    return new Promise((resolve, reject) => passport.deserializeUser(value, (err, user) => err ? reject(err) : resolve(user)));
  };
  return { app, collections, request, form, login, verify, deserialize, userId, exportedApp: context.module.exports, get connectionAttempts() { return connectionAttempts; } };
}

module.exports = { createTestServer, userId, passwordHash };
