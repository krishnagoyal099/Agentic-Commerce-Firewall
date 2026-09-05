# Agentic Commerce Firewall — 5-Minute Video Pitch

**Format:** screen recording with voiceover · **Spoken words:** ~660
**Timing:** ≈4:15 of speech at a clear presentation pace (150 wpm) + ~45s of demo pauses ≈ **5:00**.
If you naturally speak slower than that, use the cut list at the bottom — don't speed up. Talking fast is the one thing that makes a pitch sound nervous.

---

## Before you hit record

1. `npm run dev`, open `http://localhost:5173`, press **RESET** once. Start on the **Overview** tab.
2. Have the intent sentence ready to type — don't compose it live.
3. Zoom the browser to **110–125%**. Judges often watch on a laptop; default text is too small in a recording.
4. Close every other tab. The browser chrome should show nothing but this app.
5. Record in one take if you can. A visible cursor moving between real tabs is the thing that makes it feel live — cuts make it feel edited.

---

## 0:00 – 0:25 · The hook

> **ON SCREEN:** Overview tab, sitting still. Don't click anything yet.

An AI agent can already do your shopping. It can search a catalog, build a cart, apply a discount, and check out — completely on its own.

Here's the uncomfortable part. Between that agent deciding to spend your money, and your money actually moving, most systems today have nothing. Just a prompt. *"Please don't exceed the budget."*

That's a request. Not a control.

> **DELIVERY:** Land hard on the last three words, then pause for one full second before continuing. This is the only line in the video that needs a pause around it.

---

## 0:25 – 0:50 · The idea

> **ON SCREEN:** Still the Overview tab. Let the blue hero panel do the work.

So we built the part that's missing. It's called the Agentic Commerce Firewall.

One line: **AI proposes. Policy decides.**

The agent can propose anything it likes. It simply has no path to money that skips the check. And that check isn't another model — it's deterministic code. Same input, same verdict, every single time.

And it answers to two different humans. The shopper sets a mandate — how much, on what, for how long. The merchant sets a policy — order caps, discount caps, daily budgets. Whichever one is stricter wins, and the agent can't appeal to either.

---

## 0:50 – 1:40 · Demo 1 — intent to order

> **ON SCREEN:** Click into the intent box. Type the sentence out loud as you say it. Then **Preview mandate**, then **RUN MY INTENT**.

Let me show you. I'll type what I want, in plain English — *"I need running shoes for my marathon, under ₹8,000."*

Before anything runs, I preview the mandate. My sentence has just become bounded authority: an ₹8,000 ceiling, two allowed categories, valid for 24 hours. Nothing exists yet — I'm being shown the limit *before* I grant it.

Now, run it.

> **ON SCREEN:** Let the metrics populate. Stay silent for a beat while the numbers land.

The buyer agent searched the catalog, built a cart, and asked for permission. A growth agent proposed an upsell from real co-purchase data. The firewall approved both. Payment captured. Order complete. Two seconds.

> **DELIVERY:** "Two seconds" is a throwaway line — say it lightly. The speed is the point; don't oversell it.

---

## 1:40 – 2:15 · Demo 2 — the receipt, and who is in charge

> **ON SCREEN:** Firewall tab → click the top ALLOW row so the receipt opens. Then Merchant tab → edit a price → back to Overview → rerun.

Every action produced a receipt. Not "approved for safety" — the actual mandate it ran under, the exact policy version, the drift score, and the specific rule that decided it. Policies are versioned and immutable, so you can reconstruct any decision months later — which is what a finance team actually asks for.

And here's who's actually in charge: the merchant. I'll change this product's price. Rerun the same intent — and the new price flows straight through.

The agent can *read* this catalog. It can never *write* to it. Same for the policy. Every attempt is rejected in code, and the rejection itself is logged.

---

## 2:15 – 3:15 · Demo 3 — attack it

> **ON SCREEN:** Attack Lab. Launch **Unauthorized Discount** → read the report. Then **Slow Authority Drift**. Then **Payment Timeout**.

Now let's attack it.

**Unauthorized discount.** The agent asks for ₹2,000 off. The merchant's cap is ₹500. Blocked — and it names the exact rule that stopped it.

**Slow authority drift.** This one's the interesting case. Fifteen individually reasonable actions. Not one of them breaks a rule. But the drift score climbs, and at 0.70 the system stops and asks a human. And an agent can never approve its own request.

**Payment timeout.** The provider goes silent. Did it charge or didn't it? Most systems retry — and double-charge your customer. This one marks the payment UNKNOWN, queries the provider, finds the original charge succeeded, and reconciles. One charge. Never two.

> **DELIVERY:** These are three separate beats. Small pause between each. Don't rush — this is the strongest minute in the video.

---

## 3:15 – 4:00 · Proof

> **ON SCREEN:** Fuzz panel → **Run 5,000 Fuzz Tests**. Let it run. Then Audit tab.

But three attacks that I chose is a demo. So — five thousand generated attacks, run against the real engine.

> **ON SCREEN:** Stay quiet while it runs. Let the stat row fill in.

Bypasses: zero. It's seeded, so you can reproduce that exact run. One bypass and it exits non-zero — and CI fails the build.

And everything you just watched — the order, the block, the price change — is sitting in one hash-chained record. Change a single historical row, and every hash after it stops matching.

---

## 4:00 – 4:40 · What's actually real

> **ON SCREEN:** Slowly scroll the Audit list, or cut to the README. Nothing to click.

Everything here is real. No API keys, no cloud, no Docker — `npm install`, `npm run dev`. The transaction history is generated by running real commerce flows, which is why the growth analytics are computed rather than hardcoded.

MCP is fully implemented: ten safe tools, and refunds, payouts and policy writes simply aren't exposed. ACP and AP2 are extension points behind one adapter interface — we don't claim them.

And the firewall itself never calls an LLM. That's rather the point.

---

## 4:40 – 5:00 · Close

> **ON SCREEN:** Overview tab, or a still title card.

Agentic commerce is arriving whether or not anyone solves this. The real question is whether a merchant can let an agent transact without handing over the keys — because an upsell agent that can be overruled is worth far more to a merchant than one that can't.

We don't make agents trustworthy. **We make their authority enforceable.**

Thank you.

---

## If you're running long

Cut in this order — each is self-contained, so removing it costs you nothing structurally:

| Cut | Saves | Cost |
|---|---|---|
| The merchant price-edit (2:15 section, second half) | ~20s | Loses "who's in charge", but the receipt still lands |
| Payment timeout (third attack) | ~20s | Two attacks still prove the pattern |
| The "What's actually real" section, keep only the last line | ~25s | Loses the honesty framing — cut this last |

**Never cut:** the hook, the intent running end to end, one blocked attack with its rule named, and the fuzzer's zero.

---

## If a judge asks afterwards

- **"Is the AI part real?"** — The agents are deterministic and the firewall never calls a model. An optional LLM only drafts the mandate from your sentence, and it falls back to a parser.
- **"Are those numbers hardcoded?"** — No. History is generated through real flows, analytics computed from it. Reset and they're recomputed.
- **"Why not just prompt the model?"** — A prompt can't be versioned per merchant, audited, or proven after the fact. A policy object can be all three.

---

## Recording notes

- **Audio matters more than video.** A phone's voice-memo app next to your face beats a laptop mic in a room. Record it separately and lay it over the screen capture if you can.
- **Don't narrate your clicking.** Never say "now I'm going to click on the Attack Lab tab." Just click it and keep talking about the idea.
- **Silence is fine while something runs.** The fuzzer filling in is more persuasive than you talking over it.
- **One rehearsal, then record.** Third and fourth takes get worse, not better — they start sounding recited.
