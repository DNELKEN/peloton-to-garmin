# Erg Trainer (web)

A browser app for indoor rowing, SkiErg and bike workouts. It connects to the machine over
Web Bluetooth, runs interval workouts with pace targets, and exports a FIT file you can upload
to Garmin Connect, Strava, TrainingPeaks or intervals.icu.

No build step and no dependencies: plain HTML, CSS and JavaScript modules.

## What it does

- **Connects to**
  - Concept2 PM5 (RowErg, SkiErg, BikeErg) via the PM5 Bluetooth interface
  - Any FTMS rower or smart bike (WaterRower with ComModule, RP3, many Rogue/generic machines)
  - A Bluetooth heart rate strap (takes priority over the erg's own HR)
  - A built-in **simulator**, so you can try everything without hardware
- **Workouts**: Just row, 2k, 5k, 30 min, preset intervals, or build your own
  (reps × distance or time, rest, optional target pace).
- **During the workout**: remaining metres/time, live pace, split average, stroke rate/cadence,
  watts, heart rate, calories, projected finish, ahead/behind target, beeps at transitions and
  a 3-2-1 countdown at the end of rests. The screen stays awake.
- **After**: splits table, FIT download (records, laps with work/rest intensity, session),
  splits CSV, and a short local history.

The workout clock is kept by the app, not the PM5: set the monitor to **Just Row** and the
workout starts on your first stroke (or tap *Start now*).

## Running it

Web Bluetooth only works over `https://` or on `localhost`.

```bash
cd erg-web
python3 -m http.server 8080   # or: npm start
# open http://localhost:8080 in Chrome or Edge
```

To use it on a phone, host the folder on any static HTTPS host (GitHub Pages, Netlify,
Cloudflare Pages).

### Browser support

| Platform | Works? |
|---|---|
| Chrome / Edge on Windows, macOS, Linux, ChromeOS | Yes |
| Chrome on Android | Yes |
| Safari on iPhone / iPad | No Web Bluetooth. Use the free **Bluefy** browser. |
| Firefox | No Web Bluetooth |

## Tests

```bash
cd erg-web
npm test        # node --test, needs Node 18+
```

Covers the PM5, FTMS and heart rate parsers, the workout engine (armed start, interval
transitions, finish-time interpolation, monitor resets, speed integration) and the FIT
encoder's header and CRCs.

## Layout

| File | Purpose |
|---|---|
| `js/pm5.js` | Concept2 PM5 Bluetooth UUIDs, packet parsers, connection |
| `js/ftms.js` | Fitness Machine Service rower and indoor bike data |
| `js/hr.js` | Heart rate strap |
| `js/simulator.js` | Fake erg for testing |
| `js/workout.js` | Machines, presets, interval builder, workout engine |
| `js/fit.js` | FIT activity encoder, CSV export |
| `js/app.js` | UI |

## Notes and limits

- Calories use the Concept2 formula (4 × watts + 300 per hour), so they're an estimate for
  non-Concept2 machines.
- SkiErg files are tagged as cross-country skiing, since FIT has no indoor-ski sport.
- The *FIT file device* setting can label files as a Garmin Forerunner 945 so Garmin Connect
  calculates Training Effect, like peloton-to-garmin's device option.
- Not yet: programming workouts onto the PM5 itself, Concept2 Logbook sync, force curves.
