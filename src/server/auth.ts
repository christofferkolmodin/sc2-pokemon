/**
 * Shared-password gate for hosting the game on the internet.
 *
 * The password comes from the GAME_PASSWORD environment variable or, failing
 * that, the first line of `.game-password` in the repo root (git-ignored).
 * With no password set, the server is open, as before.
 *
 * Visitors get a login page; the right password sets a cookie holding a hash
 * of the password, valid for 30 days (changing the password logs everyone out).
 * Requests made directly on this machine (localhost, not through the tunnel)
 * skip the gate, so playing locally needs no password.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "pokecraft_auth";
const MAX_AGE = 60 * 60 * 24 * 30;

export function loadPassword(root: string): string | null {
  const env = process.env.GAME_PASSWORD?.trim();
  if (env) return env;
  const file = join(root, ".game-password");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
  return line || null;
}

export class Gate {
  private token: string;
  private failures = new Map<string, { n: number; until: number }>();

  constructor(private password: string) {
    this.token = createHash("sha256").update(`pokecraft:${password}`).digest("hex");
  }

  /** Direct requests from this machine; tunnel traffic carries Cloudflare's headers. */
  private local(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? "";
    const loop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    return loop && !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
  }

  private client(req: IncomingMessage): string {
    return String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
  }

  allowed(req: IncomingMessage): boolean {
    if (this.local(req)) return true;
    const m = /(?:^|;\s*)pokecraft_auth=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
    if (!m) return false;
    return timingSafeEqual(Buffer.from(m[1]), Buffer.from(this.token));
  }

  /** Handles /login. Returns true if it answered the request. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path !== "/login") return false;
    if (req.method !== "POST") {
      this.page(res, "");
      return true;
    }
    const ip = this.client(req);
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      this.page(res, "Too many tries. Wait a minute and try again.");
      return true;
    }
    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const given = Buffer.from(form.get("password") ?? "");
    const want = Buffer.from(this.password);
    const ok = given.length === want.length && timingSafeEqual(given, want);
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      // Slow down guessing: after 5 wrong tries, lock this address out for a minute.
      this.failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      await new Promise((r) => setTimeout(r, 800));
      this.page(res, "Wrong password.");
      return true;
    }
    this.failures.delete(ip);
    const next = form.get("next") ?? "/";
    const secure = req.headers["x-forwarded-proto"] === "https" || /"scheme":"https"/.test(String(req.headers["cf-visitor"] ?? ""));
    res.writeHead(303, {
      location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      "set-cookie": `${COOKIE}=${this.token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
      "cache-control": "no-store",
    });
    res.end();
    return true;
  }

  /** Answer a request that isn't logged in: the login page for pages, 401 for everything else. */
  deny(req: IncomingMessage, res: ServerResponse, path: string) {
    if (path === "/" || path.endsWith(".html")) {
      const url = new URL(req.url ?? "/", "http://x");
      this.page(res, "", url.pathname + url.search);
      return;
    }
    res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" }).end("Log in first.");
  }

  private page(res: ServerResponse, error: string, next = "/") {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.writeHead(error ? 401 : 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>PokeCraft</title>
<style>
  html,body{margin:0;height:100%;background:radial-gradient(ellipse at 50% 30%,#13222b 0%,#07090b 70%);color:#d7e6ee;font:15px/1.4 "Segoe UI",system-ui,sans-serif}
  main{height:100%;display:grid;place-items:center}
  form{width:min(340px,calc(100% - 32px));background:#0e1418;border:1px solid #2a4652;border-radius:6px;padding:26px;box-shadow:0 0 40px rgba(79,163,192,.12)}
  h1{margin:0 0 4px;font-size:28px;letter-spacing:.04em;text-transform:uppercase}
  h1 span{color:#ffcb05}
  p{color:#7d939e;margin:0 0 16px}
  input{box-sizing:border-box;width:100%;font:inherit;color:#d7e6ee;background:#0a1014;border:1px solid #2a4652;border-radius:3px;padding:8px}
  button{margin-top:12px;width:100%;font:inherit;color:#d7e6ee;background:linear-gradient(#1f5a33,#123a20);border:1px solid #3c9a5a;border-radius:3px;padding:8px;cursor:pointer}
  .err{color:#ff5a4a;min-height:1.4em;margin:10px 0 0}
</style></head><body><main>
<form method="post" action="/login">
  <h1>Poke<span>Craft</span></h1>
  <p>Enter the password.</p>
  <input type="password" name="password" autofocus autocomplete="current-password" aria-label="Password">
  <input type="hidden" name="next" value="${esc(next)}">
  <button type="submit">Enter</button>
  <div class="err">${esc(error)}</div>
</form></main></body></html>`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4096) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}
