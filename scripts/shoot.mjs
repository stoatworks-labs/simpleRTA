/**
 * Take the documentation screenshots, from the real application.
 *
 *   node scripts/shoot.mjs [--url http://localhost:5191] [--out docs/screenshots]
 *
 * Headless Chrome over CDP. Nothing is composited, mocked or drawn by hand: the
 * page is loaded, the pink-noise source is started, the analyser is left to
 * settle, and the frame is captured. What is in the PNG is what the app drew.
 *
 * Two things make this less obvious than "load a page and screenshot it":
 *
 *  - **`element.click()` does not confer user activation**, and an AudioContext
 *    will not start without it. The handler runs, `resume()` never resolves,
 *    and the shot is of an idle analyser with no error anywhere. The clicks
 *    here go through `Input.dispatchMouseEvent`, which is a real gesture.
 *
 *  - **Headless Chrome has no audio device.** Web Audio still runs — the graph
 *    is pulled against a null sink at the nominal sample rate — which is
 *    exactly what is wanted, because the source being analysed is generated
 *    inside the page. A microphone shot would need a machine with a signal on
 *    its input; this needs nothing.
 *
 * The analyser is given real time to average: `--settle` is in seconds and the
 * default is chosen so the Slow average has converged and the spectrograph has
 * filled. Shortening it produces a ragged trace, which is a photograph of a
 * measurement that has not finished rather than of the tool.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = '9224'; // not 9222/9223 — the video pipeline uses those
const WIDTH = 1600;
const HEIGHT = 900;

function opt(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const URL_ = opt('url', 'http://localhost:5191');
const OUT = opt('out', 'docs/screenshots');
const SETTLE = Number(opt('settle', '12'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over the WebSocket the browser advertises. */
async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(new URL(URL_).host));
  if (!page) throw new Error('no page target matching the app URL');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  return { send, close: () => ws.close() };
}

const evaluate = async (send, expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    const why =
      exceptionDetails.exception?.description ??
      exceptionDetails.exception?.value ??
      exceptionDetails.text;
    throw new Error(`evaluate failed: ${why}`);
  }
  return result.value;
};

/**
 * Poll @p expression until it is truthy.
 *
 * A page target exists from navigation commit, not from load, so connecting
 * successfully says nothing about whether the application is there yet.
 * Everything downstream waits on something only the running app can produce.
 */
async function waitFor(send, expression, what, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await evaluate(send, expression)) return;
    } catch {
      /* the document may still be swapping under us */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/**
 * A real gesture at the centre of the button whose visible text is @p label.
 *
 * By text rather than by selector because these controls are identified in the
 * UI by what they say — "1/48", "Split" — and a class name would be a second,
 * silently-breakable description of the same thing.
 *
 * @p label may be an array of acceptable labels, tried in order. The same
 * control is worded differently in the two places it appears — the first-run
 * source picker says "Pink noise test signal", the toolbar just says "Pink
 * noise" — and which one is on screen depends on stored state that this script
 * deliberately clears. Naming both is honest about that; matching loosely on a
 * substring would silently pick whichever came first in the DOM.
 */
async function clickText(send, label) {
  const labels = Array.isArray(label) ? label : [label];
  const found = await evaluate(
    send,
    `(() => { const wanted = ${JSON.stringify(labels)};
      const buttons = [...document.querySelectorAll('button')];
      for (const w of wanted) {
        const b = buttons.find(el => el.textContent.trim() === w);
        if (b) {
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null; })()`,
  );
  if (!found) throw new Error(`no button labelled ${labels.join(' or ')}`);
  const common = { x: found.x, y: found.y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  await sleep(250);
}

async function shoot(send, path) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`  ${path}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const profile = join(tmpdir(), `simplerta-shoot-${process.pid}`);

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    URL_,
  ], { stdio: 'ignore' });

  let cdp;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        cdp = await connect();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!cdp) throw new Error('chrome never came up on the debug port');
    const { send } = cdp;

    await send('Page.enable');
    await send('Runtime.enable');

    const RENDERED = `!!document.querySelector('.controls')`;
    await waitFor(send, RENDERED, 'the app to render');

    // localStorage carries settings between runs; a shoot must not inherit
    // whatever the last one left, or the shots stop being reproducible. Cleared
    // after the first render, because on a not-yet-navigated document the
    // access itself throws.
    await evaluate(send, `localStorage.clear()`);
    await send('Page.reload');
    await waitFor(send, RENDERED, 'the app to render after the reload');

    // `.controls` is the bottom bar, and it mounts a beat before the source
    // buttons at the top do. Waiting on it alone is a race the shoot loses on a
    // cold profile: the click lands on a toolbar that has not drawn its source
    // buttons yet, and the run dies claiming the button does not exist.
    const SOURCE_READY = `[...document.querySelectorAll('button')]
      .some(b => ['Pink noise test signal', 'Pink noise'].includes(b.textContent.trim()))`;
    await waitFor(send, SOURCE_READY, 'the source buttons to render');

    console.log(`starting the pink noise source, settling ${SETTLE}s`);
    await clickText(send, ['Pink noise test signal', 'Pink noise']);
    await sleep(SETTLE * 1000);

    // 1 — the RTA, which is the picture of the tool
    await shoot(send, join(OUT, 'rta.png'));

    // The same frame under the name the website's shots.json points at. It is
    // written here rather than left to be taken by hand because that is exactly
    // what had happened: simplerta.png was the project's hero image and the one
    // file in this directory no script produced, so it silently aged past every
    // other shot. Same picture, one capture, two names.
    await shoot(send, join(OUT, 'simplerta.png'));

    // 2 — 1/48 octave, where the resolution claim is
    await clickText(send, '1/48');
    await sleep(4000);
    await shoot(send, join(OUT, 'rta-48th.png'));

    // 3 — split view, RTA over the spectrograph on a shared axis. The waterfall
    // is empty when it mounts, so it gets its own fill time.
    await clickText(send, '1/12');
    await clickText(send, 'Split');
    await sleep(20000);
    await shoot(send, join(OUT, 'split.png'));

    // 4 — the spectrograph alone
    await clickText(send, 'Spectro');
    await sleep(22000);
    await shoot(send, join(OUT, 'spectrograph.png'));
  } finally {
    cdp?.close();
    chrome.kill();
    // Chrome is still flushing its profile as it exits, so a removal here races
    // it and throws ENOTEMPTY. Thrown from `finally`, that replaces whatever
    // actually went wrong in the body — the first failed run reported a
    // temp-directory problem and hid the real one entirely. Give it a moment,
    // and never let tidying up be the error anyone sees.
    await sleep(750);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
