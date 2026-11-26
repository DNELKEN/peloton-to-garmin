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
- **Loads workouts onto the PM5**: with a PM5 connected, *Load onto PM5 and start* programs the
  workout on the monitor (single distance/time pieces with splits, or variable intervals with
  exact rests and target pace), so the PM5 runs and stores it like any workout you set up by hand.
- **The Pete Plan**: the three-week cycle from Pete's published plan, with next-session tracking,
  configurable steady/hard distances, and Pete's pacing rule built in: your average on a session
  becomes the target for every rep but the last next time.
- **During the workout**: remaining metres/time, live pace, split average, stroke rate/cadence,
  watts, heart rate, calories, projected finish, ahead/behind target, beeps at transitions and
  a 3-2-1 countdown at the end of rests. The screen stays awake.
- **After**: splits table, FIT download (records, laps with work/rest intensity, session),
  splits CSV, and a short local history.

Leave the PM5 on its main menu before loading a workout. If you untick *Load this workout onto
the PM5*, set the monitor to **Just Row** instead; either way the app starts timing on your first
stroke (or tap *Start now*).

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
| `js/pm5.js` | Concept2 PM5 Bluetooth UUIDs, packet parsers, connection, workout loading |
| `js/csafe.js` | CSAFE framing (byte stuffing, checksum, reply status) |
| `js/pm5-workouts.js` | Converts a workout into PM5 configuration commands |
| `js/plans.js` | The Pete Plan and plan progress |
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
- PM5 command sequences follow those used by the open-source ErgometerJS library over Web
  Bluetooth; each message fits in one 20-byte Bluetooth packet.
- Plan progress, targets and history are stored in this browser only.
- Not yet: Concept2 Logbook sync, the 24-week Beginner Pete Plan, force curves.
