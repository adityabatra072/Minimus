#!/usr/bin/env node
/**
 * Laptop side of the on-device QA bridge (apps/mobile/src/services/qaBridge.ts).
 *
 *   node scripts/qa/qa.mjs serve                 # start the command server (port 8787)
 *   node scripts/qa/qa.mjs ping
 *   node scripts/qa/qa.mjs ask "turn on the flashlight"
 *   node scripts/qa/qa.mjs checks | deep | bench | logs
 *   node scripts/qa/qa.mjs screenshot [out.jpg]
 *   node scripts/qa/qa.mjs navigate models      # chat|models|tools|settings|history|rehearsal|diagnostics
 *   node scripts/qa/qa.mjs run <name> '{"json":"args"}'
 *
 * The phone polls GET /poll and answers POST /result/:id. The CLI enqueues on
 * POST /enqueue and long-polls GET /wait/:id. Everything is plain JSON over
 * the local network; nothing leaves the LAN.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.QA_PORT ?? 8787);
const SERVER = process.env.QA_SERVER ?? `http://127.0.0.1:${PORT}`;

function serve() {
  // A QA server that dies mid-session loses the phone; log and carry on.
  process.on('uncaughtException', (err) => console.error('qa server error:', err.message));
  process.on('unhandledRejection', (err) => console.error('qa server rejection:', err));
  const queue = [];
  const results = new Map();
  const waiters = new Map();
  let lastSeen = null;

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/poll') {
        lastSeen = { device: url.searchParams.get('device'), at: Date.now() };
        const cmd = queue.shift();
        if (!cmd) return json(res, 204);
        return json(res, 200, cmd);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/result/')) {
        const id = url.pathname.slice('/result/'.length);
        const body = JSON.parse((await readBody(req)) || '{}');
        results.set(id, body);
        for (const w of waiters.get(id) ?? []) {
          try {
            w(body);
          } catch {
            /* a waiter whose response already timed out */
          }
        }
        waiters.delete(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/enqueue') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
        queue.push({ id, name: body.name, args: body.args ?? {} });
        return json(res, 200, { id });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/wait/')) {
        const id = url.pathname.slice('/wait/'.length);
        if (results.has(id)) return json(res, 200, results.get(id));
        const waiter = (body) => {
          clearTimeout(timer);
          if (!res.writableEnded) json(res, 200, body);
        };
        const timer = setTimeout(() => {
          const list = (waiters.get(id) ?? []).filter((w) => w !== waiter);
          if (list.length) waiters.set(id, list);
          else waiters.delete(id);
          if (!res.writableEnded) json(res, 204);
        }, 25_000);
        waiters.set(id, [...(waiters.get(id) ?? []), waiter]);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, { queued: queue.length, lastSeen });
      }
      json(res, 404, { error: 'not found' });
    })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`qa server on :${PORT} — phone should poll http://<this-mac-ip>:${PORT}/poll`);
    });
}

async function run(name, args, { timeoutMs = 20 * 60_000 } = {}) {
  const enq = await fetch(`${SERVER}/enqueue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const { id } = await enq.json();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${SERVER}/wait/${id}`);
    if (res.status === 200) return res.json();
  }
  throw new Error(`timed out waiting for ${name}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'serve') return serve();
  if (cmd === 'status') {
    const r = await fetch(`${SERVER}/status`);
    console.log(await r.text());
    return;
  }
  let name = cmd;
  let args = {};
  if (cmd === 'ask') args = { prompt: rest.join(' ') };
  else if (cmd === 'navigate') args = { screen: rest[0] ?? 'chat' };
  else if (cmd === 'screenshot') args = {};
  else if (cmd === 'run') {
    name = rest[0];
    args = rest[1] ? JSON.parse(rest[1]) : {};
  } else if (rest[0]) {
    try {
      args = JSON.parse(rest[0]);
    } catch {
      args = { text: rest.join(' ') };
    }
  }
  const started = Date.now();
  const result = await run(name, args);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (cmd === 'screenshot' && result.ok) {
    const out = rest[0] ?? `screenshot-${Date.now()}.jpg`;
    fs.writeFileSync(out, Buffer.from(result.data.jpegBase64, 'base64'));
    console.log(`saved ${path.resolve(out)} (${secs}s)`);
    return;
  }
  if (cmd === 'logs' && result.ok) {
    console.log(result.data.lines.join('\n'));
    return;
  }
  console.log(JSON.stringify({ ...result, secs }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
