// Feed Miou push sender. pg_cron calls it (through feedmiou_push_tick) when an alert is due.
// It claims the due alerts, sends each one to the subscribed phones and forgets the phones whose
// push service says the subscription is gone. Calling it when nothing is due does nothing, so it
// needs no caller authentication (deployed with verify_jwt = false).
import { sendPush, type Subscription, type Vapid } from "./webpush.ts";

type Job = { id: string; kind: "fed" | "late"; left: number; total: number; payload: { e: string }; subs: Subscription[] };

const api = Deno.env.get("SUPABASE_URL")!;
const secret = (() => { try { return JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default as string | undefined; } catch { return undefined; } })();
const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
// new secret keys go in apikey only; the legacy service_role key is a JWT and also goes in Authorization
const keyHeaders: Record<string, string> = secret ? { apikey: secret } : { apikey: legacy, Authorization: `Bearer ${legacy}` };

async function rpc(name: string, args: unknown = {}) {
  const res = await fetch(`${api}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...keyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json();
}

Deno.serve(async () => {
  try {
    const { jobs, vapid } = await rpc("feedmiou_push_claim") as { jobs: Job[]; vapid: Vapid | null };
    if (!jobs.length) return Response.json({ sent: 0 });
    if (!vapid) throw new Error("no feedmiou_vapid secret in Vault");
    const gone = new Set<string>();
    let sent = 0;
    await Promise.all(jobs.flatMap((j) => j.subs.map(async (s) => {
      const msg = JSON.stringify({ id: j.id, kind: j.kind, left: j.left, total: j.total, e: j.payload.e });
      try {
        const status = await sendPush(s, msg, vapid, j.kind === "late" ? { ttl: 2 * 3600, urgency: "high" } : { ttl: 3600 });
        if (status === 404 || status === 410) gone.add(s.endpoint);
        else if (status >= 300) console.error(`${j.id} → ${new URL(s.endpoint).host}: HTTP ${status}`);
        else sent++;
      } catch (e) {
        console.error(`${j.id} → ${new URL(s.endpoint).host}: ${e}`);
      }
    })));
    if (gone.size) await rpc("feedmiou_push_gone", { p_endpoints: [...gone] });
    console.log(`alerts ${jobs.map((j) => j.id).join(", ")}: ${sent} sent, ${gone.size} gone`);
    return Response.json({ sent, gone: gone.size });
  } catch (e) {
    console.error(String(e));
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
