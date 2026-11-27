# Logbook sync server

Erg Trainer sends workouts to your Concept2 Logbook through this tiny server. It's needed because
Concept2's sign-in uses a **client secret** that must never be put in a public web page. The server
holds the secret, handles sign-in, and relays two calls: read your profile, and add a result.
Your Logbook tokens are kept in your browser; the server stores nothing.

It runs free on Cloudflare Workers. Setup takes about 15 minutes, plus Concept2's approval time.

## 1. Get Concept2 developer access

Concept2 issues API keys on a self-serve page. Apps that **write** results (like this one) must be
created and tested on the **development Logbook** first, then approved by Concept2 for the real one.

Do step 2 first if you can, so you already have the worker address for the redirect URI.

1. Go to https://log-dev.concept2.com/developers/keys and log in. The development Logbook is separate from your
   real Logbook, so you may need to create an account there (the same email is fine).
2. Create a new application. When asked for the redirect (callback) URI, enter
   `https://<your-worker-address>/callback`.
3. Concept2 shows a **client ID** and **client secret**. Keep the secret private.

API documentation: https://log.concept2.com/developers/documentation/

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
6. If you created the Concept2 application before the worker, make sure its redirect URI is
   `https://<your-worker-address>/callback`.

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
your app (the live key page is https://log.concept2.com/developers/keys). When approved:

1. Change `C2_BASE_URL` to `https://log.concept2.com` (and the client ID/secret if Concept2 gives you new ones).
2. In the app, tap **Disconnect Logbook**, then **Connect Logbook** again to sign in to the real Logbook.

## What gets sent

| App workout | Logbook workout type |
|---|---|
| Just row | JustRow, 5-minute splits |
| Single distance (e.g. 2,000m) | FixedDistanceSplits, same splits the PM5 uses |
| Single time (e.g. 30:00) | FixedTimeSplits |
| Intervals and the Pete Plan | VariableInterval, with rest time/distance and target pace |
| Anything ended early, in the app or with the PM5's Menu button | JustRow, with everything rowed up to that point |

Each result includes average stroke rate, stroke count, calories and heart rate (when a strap was
connected). Only RowErg, SkiErg and BikeErg workouts can be sent. If you upload the same workout
twice, the Logbook rejects the copy and the app says *Already in your Logbook*.

If you also use ErgData with the PM5 for the same workout, you may get it twice in the Logbook;
use one or the other.
