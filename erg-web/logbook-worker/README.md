# Logbook sync server

Erg Trainer sends workouts to your Concept2 Logbook through this tiny server. It's needed because
Concept2's sign-in uses a **client secret** that must never be put in a public web page. The server
holds the secret, handles sign-in, and relays two calls: read your profile, and add a result.
Your Logbook tokens are kept in your browser; the server stores nothing.

It runs free on Cloudflare Workers. Setup takes about 15 minutes, plus Concept2's approval time.

## 1. Get Concept2 developer access

1. Make an account on the **development Logbook**, https://log-dev.concept2.com. It's separate from
   your real Logbook, and Concept2 requires every app to be tested there first.
2. Open its developer page (https://log-dev.concept2.com/developers) and register an application.
   Concept2 gives you a **client ID** and a **client secret**. If you don't see the option, email
   ranking@concept2.com and ask for API access for a personal app.
3. You'll be asked for a **redirect URI**. You don't have it until step 2 below; come back and set it to
   `https://<your-worker-address>/callback`.

## 2. Create the server on Cloudflare (no command line needed)

1. Sign up at https://dash.cloudflare.com (the free plan is enough).
2. Go to **Workers & Pages → Create → Create Worker**, name it e.g. `erg-trainer-logbook`, and click
   **Deploy**. Note its address, e.g. `https://erg-trainer-logbook.yourname.workers.dev`.
3. Click **Edit code**, replace everything with the contents of [`worker.js`](worker.js), and click **Deploy**.
4. In the worker's **Settings → Variables and Secrets**, add:

   | Name | Type | Value |
   |---|---|---|
   | `C2_CLIENT_ID` | Text | your client ID |
   | `C2_CLIENT_SECRET` | **Secret** | your client secret |
   | `STATE_SECRET` | **Secret** | any long random string (e.g. 40 random letters and digits) |
   | `C2_BASE_URL` | Text | `https://log-dev.concept2.com` |
   | `APP_URL` | Text | `https://dnelken.github.io/peloton-to-garmin/erg-web/` |

5. Open the worker's address in a browser. It should say *"Erg Trainer Logbook sync server is running."*
6. Back in Concept2's developer page, set the redirect URI to `https://<your-worker-address>/callback`.

Prefer the command line? Fill in `C2_CLIENT_ID` in [`wrangler.toml`](wrangler.toml), then:

```bash
cd erg-web/logbook-worker
npx wrangler login
npx wrangler secret put C2_CLIENT_SECRET
npx wrangler secret put STATE_SECRET
npx wrangler deploy
```

## 3. Connect the app

1. In Erg Trainer, scroll to **Settings → Concept2 Logbook**.
2. Paste the worker address into **Sync server address** and tap **Connect Logbook**.
3. Sign in to Concept2 and approve access. You return to the app, which shows *Connected as …*.
4. Row a short workout. With **Send each workout automatically** ticked it uploads when you finish;
   otherwise tap **Send to Concept2 Logbook** on the summary.
5. Check it appears on log-dev.concept2.com.

## 4. Switch to your real Logbook

Once it works on the development Logbook, email ranking@concept2.com to ask for live access for
your app. When approved:

1. Change `C2_BASE_URL` to `https://log.concept2.com` (and the client ID/secret if Concept2 gives you new ones).
2. In the app, tap **Disconnect Logbook**, then **Connect Logbook** again to sign in to the real Logbook.

## What gets sent

| App workout | Logbook workout type |
|---|---|
| Just row | JustRow, 5-minute splits |
| Single distance (e.g. 2,000m) | FixedDistanceSplits, same splits the PM5 uses |
| Single time (e.g. 30:00) | FixedTimeSplits |
| Intervals and the Pete Plan | VariableInterval, with rest time/distance and target pace |
| Anything ended early | JustRow |

Each result includes average stroke rate, stroke count, calories and heart rate (when a strap was
connected). Only RowErg, SkiErg and BikeErg workouts can be sent. If you upload the same workout
twice, the Logbook rejects the copy and the app says *Already in your Logbook*.

If you also use ErgData with the PM5 for the same workout, you may get it twice in the Logbook;
use one or the other.
