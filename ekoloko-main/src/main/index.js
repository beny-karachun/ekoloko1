const { app, BrowserWindow, BrowserView, Menu, dialog, ipcMain, shell } = require("electron");
const { execFile } = require("child_process");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const logger = require("./logger");
const googleAuth = require("./googleAuth");
const vault = require("./vault");

const LOGIN_URL = "https://play.ekoloko.org/ekoloko/login.html";
const DISCORD_URL = "https://discord.gg/5uBSQx4yWa";
const CONTROL_BAR_HEIGHT = 100;
// Must match the bundled plugins/ DLLs. We ship CleanFlash 34.0.0.301
// (kill-switch-free) PPAPI players: the plain release build in plugins/x64
// (used by normal launches) and the content-debugger build in plugins/x64-debug
// (used only with --devtools; it writes trace()/error output to flashlog.txt
// when mm.cfg enables it — see DEBUG_MODE and ensureFlashDebugConfig).
const FLASH_VERSION = "34.0.0.301";

// DevTools is gated behind a launch flag so support can open live Chrome
// DevTools during a call (`ekoloko.exe --devtools`) without exposing it to
// normal users. Logging happens regardless of this flag.
const DEBUG_MODE =
  process.argv.includes("--devtools") || process.argv.includes("--debug");

let win;
let siteView;
let signInView = null;
let pendingGoogleProfile = null;
let pendingGuestName = null;
let loginSniffAttached = false;
let pluginName;
let osName;
let isDarkMode = false;
let darkModeCSSKey = null;

switch (process.platform) {
  case "win32":
    pluginName = process.arch == "x64" ? "x64/pepflashplayer.dll" : "x32/pepflashplayer32.dll";
    osName = "windows";
    break;
  case "linux":
    pluginName = "linux/libpepflashplayer.so";
    osName = "linux";
    break;
  default:
    pluginName = "x64/pepflashplayer.dll";
    break;
}

// Normal launches use the release Flash player; only --devtools/--debug loads
// the content-debugger build from the parallel "-debug" folder
// (e.g. "x64/pepflashplayer.dll" -> "x64-debug/pepflashplayer.dll").
if (DEBUG_MODE) {
  pluginName = pluginName.replace(/^(x\d+)\//, "$1-debug/");
}

// Resolve the bundled Flash plugin in both development and the packaged app.
// Packaged: electron-builder copies plugins/ via extraResources to
// <process.resourcesPath>/plugins (outside the asar). Dev: it lives at the
// repo-root plugins/ folder, relative to the compiled main in dist/main.
// (Mirrors getAssetPath() below.) The previous `__dirname + "/../plugins/"`
// resolved to a non-existent path inside the asar, so Flash failed to load.
function getPluginPath(rel) {
  const candidates = [
    path.join(process.resourcesPath || "", "plugins", rel),
    path.join(__dirname, "..", "..", "plugins", rel),
    path.join(__dirname, "..", "..", "..", "plugins", rel),
    path.join(__dirname, "..", "plugins", rel),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const flashPluginPath = getPluginPath(pluginName);
app.commandLine.appendSwitch("ppapi-flash-path", flashPluginPath);

app.commandLine.appendSwitch("ppapi-flash-version", FLASH_VERSION);

// Flash (PPAPI) renders into a texture composited by Chromium's GPU process.
// Electron 8 ships a 2020-era GPU blocklist; on newer Windows builds/drivers it
// readily blacklists the GPU and falls back to software (SwiftShader)
// compositing, which makes Flash playable but FPS-laggy — while standalone
// Chrome on the same machine keeps hardware acceleration and runs smooth.
// Force GPU acceleration on regardless of the stale blocklist. (Both spellings:
// Chrome renamed "blacklist" -> "blocklist"; harmless to pass the unused one.)
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("ignore-gpu-blacklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");

function getAssetPath(filename) {
  const candidates = [
    path.join(process.resourcesPath || "", "assets", filename),
    path.join(__dirname, "..", "..", "assets", filename),
    path.join(__dirname, "..", "..", "..", "assets", filename),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getAssetDataUrl(filename) {
  const p = getAssetPath(filename);
  if (!p) return "";
  try {
    return `data:image/png;base64,${fs.readFileSync(p).toString("base64")}`;
  } catch (e) {
    return "";
  }
}

function getAssetFontUrl(filename) {
  const p = getAssetPath(filename);
  if (!p) return "";
  try {
    return `data:font/truetype;base64,${fs.readFileSync(p).toString("base64")}`;
  } catch (e) {
    return "";
  }
}

// google-oauth.json holds the Google OAuth "Desktop app" client id/secret for
// the sign-in-with-Google flow (see googleAuth.js). Placeholder "YOUR_*"
// values are treated as unconfigured, so the checked-in template never breaks
// a build — the sign-in screen shows setup instructions instead.
function getOAuthConfig() {
  const candidates = [
    path.join(process.resourcesPath || "", "google-oauth.json"),
    path.join(__dirname, "..", "..", "google-oauth.json"),
    path.join(__dirname, "..", "..", "..", "google-oauth.json"),
  ];
  for (const p of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      if (cfg.clientId && cfg.clientSecret && cfg.clientId.indexOf("YOUR_") !== 0) {
        return cfg;
      }
    } catch (e) {}
  }
  return null;
}

function getControlPageHtml() {
  const logoSrc = getAssetDataUrl("3.png");
  const discordSrc = getAssetDataUrl("d-1.png");
  const fontSrc = getAssetFontUrl("Gan CLM Bold.ttf");
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ekoloko</title>
        <style>
          ${fontSrc ? `@font-face { font-family: 'GanCLM'; src: url('${fontSrc}') format('truetype'); font-weight: bold; }` : ""}

          * { box-sizing: border-box; margin: 0; padding: 0; }

          body {
            font-family: 'GanCLM', 'Arial Rounded MT Bold', Arial, sans-serif;
            overflow: hidden;
            height: ${CONTROL_BAR_HEIGHT}px;
            background: linear-gradient(180deg, #8fd42e 0%, #6aaa1e 100%);
            border-bottom: 4px solid #4e8810;
          }

          .bar {
            height: ${CONTROL_BAR_HEIGHT}px;
            position: relative;
            display: flex;
            align-items: center;
            padding: 0 28px;
            gap: 20px;
          }

          .logo-img {
            flex-shrink: 0;
            height: 96px;
          }

          .sep {
            flex-shrink: 0;
            width: 2px;
            height: 68px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 2px;
          }

          .panel {
            flex-shrink: 0;
            background: #3a6fd8;
            border-radius: 14px;
            border: 3px solid #2a55c0;
            padding: 10px 16px 12px;
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 180px;
          }

          .panel-label {
            font-size: 12px;
            color: #b8cdff;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }

          .slider-row {
            display: flex;
            align-items: center;
            gap: 10px;
          }

          input[type="range"] {
            flex: 1;
            cursor: pointer;
            -webkit-appearance: none;
            appearance: none;
            height: 6px;
            border-radius: 4px;
            outline: none;
            background: linear-gradient(to right, #fb7d07 var(--fill, 100%), rgba(255,255,255,0.3) var(--fill, 100%));
          }

          input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 1px 4px rgba(0,0,0,0.4);
            cursor: pointer;
            transition: transform 0.1s;
          }

          input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.2); }
          input[type="range"]:active::-webkit-slider-thumb { transform: scale(1.3); }

          .val {
            font-size: 14px;
            color: #fff;
            min-width: 42px;
            text-align: right;
            font-variant-numeric: tabular-nums;
          }

          .btn {
            flex-shrink: 0;
            border: none;
            border-radius: 14px;
            padding: 0 26px;
            height: 52px;
            background: linear-gradient(180deg, #ff9a2a 0%, #fb7d07 100%);
            border-bottom: 4px solid #c05800;
            color: #fff;
            font-family: inherit;
            font-size: 17px;
            cursor: pointer;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
            transition: transform 0.1s, border-bottom-width 0.1s, filter 0.1s;
            white-space: nowrap;
          }

          .btn:hover { filter: brightness(1.08); }
          .btn:active { transform: translateY(3px); border-bottom-width: 1px; }

          .spacer { width: 10px; flex-shrink: 0; }

          .btn-icon {
            position: absolute;
            top: 6px;
            right: 10px;
            background: none;
            border: none;
            padding: 0;
            cursor: pointer;
            border-radius: 50%;
            width: 72px;
            height: 72px;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.1s, filter 0.1s;
          }

          .btn-icon img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
          .btn-icon:hover { transform: scale(1.06); filter: brightness(1.08); }
          .btn-icon:active { transform: scale(0.95); }

          body.dark {
            background: linear-gradient(180deg, #1a2744 0%, #0d1728 100%);
            border-bottom-color: #060e1c;
          }
          body.dark .panel {
            background: #0f1e3a;
            border-color: #071228;
          }
          body.dark .panel-label { color: #5a80c0; }
          body.dark .btn {
            background: linear-gradient(180deg, #1e2d50 0%, #131d38 100%);
            border-bottom-color: #060e1c;
          }
          body.dark .btn#darkModeBtn {
            background: linear-gradient(180deg, #2a3d6a 0%, #1a2848 100%);
            border-bottom-color: #060e1c;
          }
        </style>
      </head>
      <body>
        <div class="bar">
          ${logoSrc ? `<img class="logo-img" src="${logoSrc}" alt="ekoloko" />` : ""}

          <div class="panel">
            <div class="panel-label">זום</div>
            <div class="slider-row">
              <input id="zoom" type="range" min="0.5" max="2" step="0.05" value="1" />
              <div class="val" id="zoomValue">100%</div>
            </div>
          </div>

          <div class="spacer"></div>

          <button class="btn" id="muteBtn" type="button">🔊 קול</button>

          <div class="spacer"></div>

          <button class="btn" id="clearCache" type="button">🗑️ נקה מטמון</button>

          <div class="spacer"></div>

          <button class="btn" id="restartBtn" type="button">🔄 הפעל מחדש</button>

          <div class="spacer"></div>

          <button class="btn" id="saveLogsBtn" type="button">💾 שמירת לוגים</button>

          <div class="spacer"></div>

          <button class="btn" id="darkModeBtn" type="button">🌙 מצב לילה</button>

          <div class="spacer"></div>

          <button class="btn" id="switchUserBtn" type="button">🔑 החלף חשבון</button>

          ${discordSrc
            ? `<button class="btn-icon" id="openDiscord" type="button" title="דיסקורד"><img src="${discordSrc}" alt="דיסקורד" /></button>`
            : `<button class="btn" id="openDiscord" type="button">דיסקורד</button>`
          }
        </div>
        <script>
          const { ipcRenderer } = require("electron");

          const zoom = document.getElementById("zoom");
          const zoomValue = document.getElementById("zoomValue");
          const muteBtn = document.getElementById("muteBtn");
          const clearCache = document.getElementById("clearCache");
          const restartBtn = document.getElementById("restartBtn");
          const saveLogsBtn = document.getElementById("saveLogsBtn");
          const darkModeBtn = document.getElementById("darkModeBtn");
          const openDiscord = document.getElementById("openDiscord");
          let muted = false;
          let dark = false;

          function formatPercent(value) {
            return Math.round(Number(value) * 100) + "%";
          }

          function setSliderFill(input) {
            const min = parseFloat(input.min) || 0;
            const max = parseFloat(input.max) || 1;
            const pct = ((parseFloat(input.value) - min) / (max - min)) * 100;
            input.style.setProperty("--fill", pct + "%");
          }

          zoom.addEventListener("input", () => {
            zoomValue.textContent = formatPercent(zoom.value);
            setSliderFill(zoom);
            ipcRenderer.send("zoom-change", Number(zoom.value));
          });

          muteBtn.addEventListener("click", () => {
            muted = !muted;
            muteBtn.textContent = muted ? "🔇 מושתק" : "🔊 קול";
            muteBtn.style.background = muted ? "linear-gradient(180deg,#e05050 0%,#c03030 100%)" : "";
            muteBtn.style.borderBottomColor = muted ? "#8b0000" : "";
            ipcRenderer.send("mute-toggle", muted);
          });

          clearCache.addEventListener("click", () => {
            ipcRenderer.send("clear-cache");
            clearCache.textContent = "✓ נוקה!";
            setTimeout(() => { clearCache.textContent = "🗑️ נקה מטמון"; }, 2000);
          });

          darkModeBtn.addEventListener("click", () => {
            dark = !dark;
            document.body.classList.toggle("dark", dark);
            darkModeBtn.textContent = dark ? "☀️ מצב יום" : "🌙 מצב לילה";
            ipcRenderer.send("dark-mode-toggle", dark);
          });

          restartBtn.addEventListener("click", () => {
            ipcRenderer.send("restart");
          });

          let savingLogs = false;
          saveLogsBtn.addEventListener("click", () => {
            if (savingLogs) return;
            savingLogs = true;
            saveLogsBtn.textContent = "⏳ שומר...";
            ipcRenderer.send("save-logs");
          });

          ipcRenderer.on("save-logs-done", (_event, ok) => {
            savingLogs = false;
            saveLogsBtn.textContent = ok ? "✓ נשמר!" : "✗ שגיאה";
            setTimeout(() => { saveLogsBtn.textContent = "💾 שמירת לוגים"; }, 2500);
          });

          openDiscord.addEventListener("click", () => {
            ipcRenderer.send("open-discord");
          });

          document.getElementById("switchUserBtn").addEventListener("click", () => {
            ipcRenderer.send("sign-out");
          });

          zoomValue.textContent = formatPercent(zoom.value);
          setSliderFill(zoom);
        </script>
      </body>
    </html>
  `;
}

// The login page forwards `username` and `directLogin` into shell.swf as URL
// params (login.html builds swfUrl from them), so this is the only automation
// hook we have without server access. What directLogin does exactly lives
// inside the SWF — if it turns out not to complete the login, the user types
// the password once and the --devtools login sniffer (attachLoginSniffer)
// records the real login request so we can replay it properly later.
function buildAutoLoginUrl(username) {
  return `${LOGIN_URL}?username=${encodeURIComponent(username)}&directLogin=true`;
}

function getSignInPageHtml() {
  const logoSrc = getAssetDataUrl("3.png");
  const fontSrc = getAssetFontUrl("Gan CLM Bold.ttf");
  const hasOAuthConfig = !!getOAuthConfig();
  return `
    <!doctype html>
    <html dir="rtl" lang="he">
      <head>
        <meta charset="UTF-8" />
        <title>ekoloko - כניסה</title>
        <style>
          ${fontSrc ? `@font-face { font-family: 'GanCLM'; src: url('${fontSrc}') format('truetype'); font-weight: bold; }` : ""}
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'GanCLM', 'Arial Rounded MT Bold', Arial, sans-serif;
            min-height: 100vh;
            background: linear-gradient(180deg, #8fd42e 0%, #6aaa1e 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-direction: column;
            gap: 24px;
            padding: 24px;
          }
          .logo { height: 120px; }
          .card {
            background: #3a6fd8;
            border: 3px solid #2a55c0;
            border-radius: 18px;
            padding: 28px 32px;
            width: 100%;
            max-width: 440px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            color: #fff;
            text-align: center;
          }
          h1 { font-size: 24px; }
          .sub { font-size: 15px; color: #b8cdff; line-height: 1.5; }
          .setup {
            background: #fff3c4;
            color: #6b5200;
            border-radius: 10px;
            padding: 10px 14px;
            font-size: 13px;
            line-height: 1.5;
            text-align: right;
          }
          .gbtn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            background: #fff;
            color: #333;
            border: none;
            border-radius: 12px;
            border-bottom: 4px solid #c9c9c9;
            height: 52px;
            font-family: inherit;
            font-size: 17px;
            cursor: pointer;
            transition: transform 0.1s, filter 0.1s;
          }
          .gbtn:hover:not(:disabled) { filter: brightness(0.96); }
          .gbtn:active:not(:disabled) { transform: translateY(3px); border-bottom-width: 1px; }
          .gbtn:disabled { opacity: 0.55; cursor: default; }
          .status { font-size: 14px; min-height: 20px; color: #ffe08a; }
          #step2 { display: none; flex-direction: column; gap: 12px; }
          .who { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 16px; }
          .who img { width: 36px; height: 36px; border-radius: 50%; }
          input[type="text"], input[type="password"] {
            height: 46px;
            border-radius: 10px;
            border: none;
            padding: 0 14px;
            font-family: inherit;
            font-size: 16px;
            text-align: center;
          }
          .link-note { font-size: 12.5px; color: #b8cdff; line-height: 1.5; }
          .btn {
            border: none;
            border-radius: 12px;
            height: 50px;
            background: linear-gradient(180deg, #ff9a2a 0%, #fb7d07 100%);
            border-bottom: 4px solid #c05800;
            color: #fff;
            font-family: inherit;
            font-size: 17px;
            cursor: pointer;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
            transition: transform 0.1s, border-bottom-width 0.1s;
          }
          .btn:active { transform: translateY(3px); border-bottom-width: 1px; }
          .alt { font-size: 13.5px; color: #dce8ff; }
          .alt a { color: #ffd36a; cursor: pointer; text-decoration: underline; }
          .guest {
            display: flex;
            flex-direction: column;
            gap: 10px;
            border-top: 2px solid rgba(255,255,255,0.25);
            padding-top: 14px;
          }
          .guest-name-row { display: flex; align-items: center; justify-content: center; gap: 10px; }
          .guest-name {
            background: rgba(255,255,255,0.15);
            border-radius: 10px;
            padding: 8px 16px;
            font-size: 17px;
            letter-spacing: 0.03em;
            min-width: 180px;
            direction: ltr;
          }
          .dice {
            background: none;
            border: none;
            font-size: 26px;
            cursor: pointer;
            transition: transform 0.15s;
          }
          .dice:hover { transform: rotate(20deg) scale(1.15); }
          .dice:active { transform: rotate(180deg) scale(0.9); }
        </style>
      </head>
      <body>
        ${logoSrc ? `<img class="logo" src="${logoSrc}" alt="ekoloko" />` : ""}
        <div class="card">
          <h1>ברוכים הבאים לאקולוקו!</h1>
          <div class="sub">מתחברים פעם אחת עם Google — ומכאן והלאה נכנסים למשחק בלחיצה אחת.</div>
          ${hasOAuthConfig ? "" : `<div class="setup">התחברות עם Google עוד לא הופעלה בהתקנה הזו: חסר הקובץ google-oauth.json (מזהה לקוח OAuth מסוג Desktop מ-Google Cloud Console). בינתיים אפשר להיכנס למשחק כרגיל למטה.</div>`}
          <button class="gbtn" id="googleBtn" type="button" ${hasOAuthConfig ? "" : "disabled"}>
            <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            התחברות עם Google
          </button>
          <div class="status" id="status"></div>
          <div id="step2">
            <div class="who"><img id="gPic" src="" alt="" /><span id="gName"></span></div>
            <div class="sub">כמעט סיימנו! מחברים את חשבון אקולוקו שלך — פעם אחת בלבד:</div>
            <input type="text" id="gameUser" placeholder="שם משתמש במשחק" autocomplete="off" />
            <input type="password" id="gamePass" placeholder="סיסמה" />
            <button class="btn" id="linkBtn" type="button">חיבור וכניסה למשחק</button>
            <div class="link-note">הפרטים נשמרים מוצפנים על המחשב הזה בלבד, ולא נשלחים לשום מקום חוץ משרת המשחק.</div>
          </div>
          <div class="guest">
            <div class="guest-name-row">
              <button class="dice" id="rerollBtn" type="button" title="הגרילו שם אחר">🎲</button>
              <span class="guest-name" id="guestName"></span>
            </div>
            <button class="btn" id="guestBtn" type="button">🎮 משחק כאורח</button>
            <div class="link-note">לאורח מוגרל שם אקראי, בלי שמירה בין כניסות. כדי לשמור את ההתקדמות — מתחברים עם Google.</div>
          </div>
          <div class="alt">אין לך חשבון? <a id="registerLink">להרשמה</a> &middot; <a id="skipLink">כניסה רגילה בלי Google</a></div>
        </div>
        <script>
          const { ipcRenderer } = require("electron");
          const googleBtn = document.getElementById("googleBtn");
          const status = document.getElementById("status");
          const step2 = document.getElementById("step2");

          googleBtn.addEventListener("click", () => {
            googleBtn.disabled = true;
            status.textContent = "פותחים את הדפדפן... אשרו שם את ההתחברות";
            ipcRenderer.send("google-signin");
          });

          ipcRenderer.on("google-signin-result", (_event, result) => {
            googleBtn.disabled = false;
            if (!result.ok) {
              status.textContent = "ההתחברות לא הושלמה, אפשר לנסות שוב";
              return;
            }
            status.textContent = "";
            googleBtn.style.display = "none";
            document.getElementById("gName").textContent = result.profile.name || result.profile.email;
            if (result.profile.picture) document.getElementById("gPic").src = result.profile.picture;
            step2.style.display = "flex";
          });

          document.getElementById("linkBtn").addEventListener("click", () => {
            const username = document.getElementById("gameUser").value.trim();
            const password = document.getElementById("gamePass").value;
            if (!username || !password) {
              status.textContent = "צריך למלא שם משתמש וסיסמה";
              return;
            }
            ipcRenderer.send("link-account", { username, password });
          });

          ipcRenderer.on("link-account-result", (_event, result) => {
            if (!result.ok) status.textContent = result.error || "משהו השתבש";
          });

          document.getElementById("registerLink").addEventListener("click", () => ipcRenderer.send("open-register"));
          document.getElementById("skipLink").addEventListener("click", () => ipcRenderer.send("open-game-plain"));

          const GUEST_ADJECTIVES = ["Green", "Eco", "Sunny", "Wild", "Happy", "Swift", "Leafy", "Brave", "Magic", "Cosmic", "Funky", "Turbo"];
          const GUEST_ANIMALS = ["Frog", "Turtle", "Panda", "Fox", "Owl", "Koala", "Dolphin", "Bee", "Tiger", "Whale", "Gecko", "Otter"];
          const guestNameEl = document.getElementById("guestName");

          function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
          function rerollGuestName() {
            guestNameEl.textContent = pick(GUEST_ADJECTIVES) + pick(GUEST_ANIMALS) + (100 + Math.floor(Math.random() * 900));
          }

          document.getElementById("rerollBtn").addEventListener("click", rerollGuestName);
          document.getElementById("guestBtn").addEventListener("click", () => {
            ipcRenderer.send("play-as-guest", guestNameEl.textContent);
          });
          rerollGuestName();
        </script>
      </body>
    </html>
  `;
}

function setViewBounds() {
  const view = siteView || signInView;
  if (!win || !view) {
    return;
  }

  const bounds = win.getContentBounds();
  view.setBounds({
    x: 0,
    y: CONTROL_BAR_HEIGHT,
    width: bounds.width,
    height: Math.max(0, bounds.height - CONTROL_BAR_HEIGHT),
  });

  view.setAutoResize({ width: true, height: true });
}

async function applyZoom(zoomFactor) {
  if (!siteView) return;
  await siteView.webContents.setZoomFactor(zoomFactor);
}

async function applyDarkModeCSS(isDark) {
  if (!siteView) return;
  if (darkModeCSSKey) {
    await siteView.webContents.removeInsertedCSS(darkModeCSSKey);
    darkModeCSSKey = null;
  }
  if (isDark) {
    darkModeCSSKey = await siteView.webContents.insertCSS(
      "html, body { background-color: #1c2d4a !important; }"
    );
  }
}

function applyMute(muted) {
  if (!siteView) return;
  siteView.webContents.setAudioMuted(muted);
}

function openDiscordLink() {
  shell.openExternal(DISCORD_URL);
}

// Path the debug Flash player writes trace()/ActionScript error output to.
function getFlashLogPath() {
  switch (process.platform) {
    case "win32":
      return path.join(app.getPath("appData"), "Macromedia", "Flash Player", "Logs", "flashlog.txt");
    case "darwin":
      return path.join(os.homedir(), "Library", "Preferences", "Macromedia", "Flash Player", "Logs", "flashlog.txt");
    default:
      return path.join(os.homedir(), ".macromedia", "Flash_Player", "Logs", "flashlog.txt");
  }
}

// Flash Player reads mm.cfg from the user's home directory at startup. These
// flags make the *debug* player write trace()/error output to flashlog.txt.
// SuppressDebuggerExceptionDialogs stops the debug player from popping
// ActionScript-error dialogs at end users while still logging them.
function ensureFlashDebugConfig() {
  const mmCfgPath = path.join(os.homedir(), "mm.cfg");
  const contents = [
    "ErrorReportingEnable=1",
    "TraceOutputFileEnable=1",
    "MaxWarnings=0",
    "SuppressDebuggerExceptionDialogs=1",
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(mmCfgPath, contents, "utf8");
    logger.info("flash", `wrote mm.cfg at ${mmCfgPath}`);
  } catch (e) {
    logger.warn("flash", `could not write mm.cfg: ${(e && e.message) || e}`);
  }

  // The sandboxed PPAPI Flash process can write to an existing flashlog.txt but
  // usually cannot CREATE the Logs directory tree itself. Pre-create the dir and
  // an empty, world-writable flashlog.txt so the debug player's trace()/error
  // output actually lands on disk.
  try {
    const flashLogPath = getFlashLogPath();
    fs.mkdirSync(path.dirname(flashLogPath), { recursive: true });
    if (!fs.existsSync(flashLogPath)) fs.writeFileSync(flashLogPath, "");
    logger.info("flash", `flashlog ready at ${flashLogPath}`);
  } catch (e) {
    logger.warn("flash", `could not prepare flashlog dir: ${(e && e.message) || e}`);
  }
}

// Assemble one shareable .txt (app log + flashlog) and let the user save it
// wherever they like (defaulting to the Desktop) so they can send it to us.
async function saveLogsBundle() {
  const parts = [
    logger.metadataHeader(),
    "\n\n========== APP LOG ==========\n",
    logger.getExportText(),
    "\n\n========== FLASH LOG (flashlog.txt) ==========\n",
  ];
  const flashLogPath = getFlashLogPath();
  try {
    if (fs.existsSync(flashLogPath)) {
      parts.push(fs.readFileSync(flashLogPath, "utf8"));
    } else {
      parts.push("(flashlog.txt not found — only produced by the debug Flash player)\n");
    }
  } catch (e) {
    parts.push(`(could not read flashlog.txt: ${(e && e.message) || e})\n`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "שמירת לוגים",
    defaultPath: path.join(app.getPath("desktop"), `ekoloko-logs-${stamp}.txt`),
    filters: [{ name: "Log", extensions: ["txt"] }],
  });
  if (canceled || !filePath) {
    logger.info("save-logs", "user cancelled the save dialog");
    return false;
  }

  fs.writeFileSync(filePath, parts.join(""), "utf8");
  logger.info("save-logs", `saved logs to ${filePath}`);
  shell.showItemInFolder(filePath);
  return true;
}

// Mirror a webContents' console + lifecycle/crash events into the log file so
// the saved bundle reflects what actually happened in the game.
function attachWebContentsLogging(wc, source) {
  const levelName = (level) => ["INFO", "WARN", "ERROR", "INFO"][level] || "INFO";

  wc.on("console-message", (_e, level, message, line, sourceId) => {
    const where = sourceId ? ` (${sourceId}:${line})` : "";
    logger.info(source, `console[${levelName(level)}]: ${message}${where}`);
  });
  wc.on("did-fail-load", (_e, code, desc, url) => {
    logger.error(source, `did-fail-load ${code} ${desc} ${url || ""}`);
  });
  wc.on("did-fail-provisional-load", (_e, code, desc, url) => {
    logger.error(source, `did-fail-provisional-load ${code} ${desc} ${url || ""}`);
  });
  wc.on("dom-ready", () => logger.info(source, "dom-ready"));
  wc.on("did-finish-load", () => logger.info(source, "did-finish-load"));
  wc.on("did-navigate", (_e, url) => logger.info(source, `did-navigate ${url}`));
  // Electron 8 has no `render-process-gone` — use `crashed`.
  wc.on("crashed", (_e, killed) => logger.error(source, `renderer crashed (killed=${killed})`));
  wc.on("unresponsive", () => logger.warn(source, "unresponsive"));
  wc.on("responsive", () => logger.info(source, "responsive"));
  wc.on("plugin-crashed", (_e, name, version) =>
    logger.error(source, `plugin-crashed: ${name} ${version}`)
  );
  wc.on("certificate-error", (_e, url, error) =>
    logger.warn(source, `certificate-error ${error} ${url}`)
  );
}

// When launched with --devtools, F12 / Ctrl+Shift+I toggle the game's DevTools.
// getTarget is a function because the game view is created/destroyed across
// sign-in/sign-out, while the shortcut stays attached to the window.
function attachDevtoolsShortcut(wc, getTarget) {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isF12 = input.key === "F12";
    const isCtrlShiftI =
      input.control && input.shift && String(input.key).toLowerCase() === "i";
    if (isF12 || isCtrlShiftI) {
      const targetWc = getTarget();
      if (!targetWc) return;
      if (targetWc.isDevToolsOpened()) targetWc.closeDevTools();
      else targetWc.openDevTools({ mode: "detach" });
      event.preventDefault();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: "#6aaa1e",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: DEBUG_MODE,
      plugins: true,
    },
  });

  win.maximize();

  const controlHtmlPath = path.join(app.getPath("temp"), `ekoloko-control-${Date.now()}.html`);
  fs.writeFileSync(controlHtmlPath, getControlPageHtml(), "utf8");
  win.loadFile(controlHtmlPath);

  attachWebContentsLogging(win.webContents, "control-bar");

  if (DEBUG_MODE) {
    logger.info("devtools", "launched with --devtools; DevTools enabled");
    attachDevtoolsShortcut(win.webContents, () => siteView && siteView.webContents);
  }

  win.on("resize", setViewBounds);
  win.on("closed", () => {
    win = null;
    siteView = null;
    signInView = null;
  });

  showApp();
}

// Entry decision on startup: a linked account goes straight into the game
// with the auto-login params; otherwise the sign-in-with-Google screen.
function showApp() {
  const stored = vault.load();
  if (stored && stored.game && stored.game.username) {
    logger.info("auth", `auto-login as linked account "${stored.game.username}"`);
    createGameView(buildAutoLoginUrl(stored.game.username));
  } else {
    createSignInView();
  }
}

function createGameView(url) {
  destroySignInView();

  if (siteView) {
    win.setBrowserView(siteView);
    setViewBounds();
    siteView.webContents.loadURL(url);
    return;
  }

  siteView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: DEBUG_MODE,
      plugins: true,
      allowRunningInsecureContent: true,
      // The control bar is a separate view, so the game view can lose focus
      // while the user is playing. Without this, Chromium throttles the blurred
      // webContents to ~1fps and Flash visibly stutters.
      backgroundThrottling: false,
    },
  });

  win.setBrowserView(siteView);
  // Paint the game view solid ekoloko green. Without this the BrowserView is
  // transparent, so while a page is navigating it briefly reveals the control
  // bar's gradient body underneath (propagated across the whole viewport),
  // which reads as a "broken" stretched gradient. Matches the window bg and
  // the light-mode value used by the dark-mode toggle below.
  siteView.setBackgroundColor("#6aaa1e");
  setViewBounds();

  attachWebContentsLogging(siteView.webContents, "game");

  if (DEBUG_MODE) {
    attachDevtoolsShortcut(siteView.webContents, () => siteView && siteView.webContents);
    siteView.webContents.once("dom-ready", () => {
      siteView.webContents.openDevTools({ mode: "detach" });
    });
    attachLoginSniffer();
  }

  siteView.webContents.loadURL(url);
  siteView.webContents.setAudioMuted(false);

  siteView.webContents.on("new-window", (event, popupUrl) => {
    event.preventDefault();
    if (popupUrl === DISCORD_URL) {
      openDiscordLink();
      return;
    }
    const popup = new BrowserWindow({
      width: 1024,
      height: 768,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        plugins: true,
        allowRunningInsecureContent: true,
      },
    });
    popup.loadURL(popupUrl);
  });

  siteView.webContents.on("did-finish-load", () => {
    if (isDarkMode) applyDarkModeCSS(true);
  });
}

function destroyGameView() {
  if (!siteView) return;
  win.setBrowserView(null);
  siteView.destroy();
  siteView = null;
  darkModeCSSKey = null;
}

function createSignInView() {
  if (signInView) return;
  destroyGameView();

  signInView = new BrowserView({
    webPreferences: {
      // Local app-generated page (same trust level as the control bar); it
      // needs ipcRenderer for the sign-in choreography. Never load remote
      // content in this view.
      nodeIntegration: true,
      contextIsolation: false,
      devTools: DEBUG_MODE,
    },
  });

  win.setBrowserView(signInView);
  signInView.setBackgroundColor("#6aaa1e");
  setViewBounds();
  attachWebContentsLogging(signInView.webContents, "signin");

  const signInHtmlPath = path.join(app.getPath("temp"), `ekoloko-signin-${Date.now()}.html`);
  fs.writeFileSync(signInHtmlPath, getSignInPageHtml(), "utf8");
  signInView.webContents.loadFile(signInHtmlPath);
}

function destroySignInView() {
  if (!signInView) return;
  win.setBrowserView(null);
  signInView.destroy();
  signInView = null;
}

// DEBUG-only: mirror the game's POST traffic into the log (passwords masked)
// so we can discover the actual login request. Once known, auto-login can
// replay it directly instead of relying on the page's directLogin flag.
function attachLoginSniffer() {
  if (loginSniffAttached || !siteView) return;
  loginSniffAttached = true;
  siteView.webContents.session.webRequest.onBeforeRequest(
    { urls: ["*://play.ekoloko.org/*"] },
    (details, callback) => {
      if (details.method === "POST") {
        let body = "";
        try {
          if (details.uploadData && details.uploadData[0] && details.uploadData[0].bytes) {
            body = details.uploadData[0].bytes.toString("utf8").slice(0, 300);
          }
        } catch (e) {}
        const masked = `${details.url}${body ? ` body=${body}` : ""}`.replace(
          /(pass(word)?["']?[=:]["']?)[^&\s"']*/gi,
          "$1***"
        );
        logger.info("net", `POST ${masked}`);
      }
      callback({});
    }
  );
}

function getUninstallerPath() {
  return path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
}

function uninstallApp() {
  const uninstallerPath = getUninstallerPath();

  if (!fs.existsSync(uninstallerPath)) {
    dialog.showErrorBox("Uninstaller not found", `Could not find ${path.basename(uninstallerPath)}.`);
    return;
  }

  const response = dialog.showMessageBoxSync(win, {
    type: "warning",
    buttons: ["Cancel", "Uninstall"],
    defaultId: 1,
    cancelId: 0,
    title: "Uninstall ekoloko",
    message: "This will remove ekoloko from your computer.",
    detail: "The app will close and launch the Windows uninstaller.",
  });

  if (response !== 1) {
    return;
  }

  execFile(uninstallerPath, [], {
    detached: true,
    stdio: "ignore",
  }).unref();

  app.quit();
}

function createAppMenu() {
  if (process.platform !== "win32") {
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Uninstall ekoloko",
            click: uninstallApp,
          },
          { type: "separator" },
          { role: "quit" },
          ],
      },
    ])
  );
}

function initAutoUpdater() {
  // Auto-update pulls each new GitHub Release from the public repo (see the
  // `publish` provider in package.json). Only meaningful in packaged builds.
  // macOS is skipped: the app is unsigned, and Squirrel.Mac refuses to apply
  // updates to an unsigned bundle. Windows + Linux update silently.
  if (!app.isPackaged || process.platform === "darwin") return;

  autoUpdater.autoDownload = true;
  autoUpdater.on("error", (err) => {
    // never let a failed update check disrupt the game, but record it
    logger.error("updater", (err && err.message) || String(err));
  });
  autoUpdater.on("checking-for-update", () => logger.info("updater", "checking for update"));
  autoUpdater.on("update-available", (info) =>
    logger.info("updater", `update available: ${(info && info.version) || "?"}`)
  );
  autoUpdater.on("update-not-available", () => logger.info("updater", "no update available"));

  autoUpdater.on("update-downloaded", (info) => {
    logger.info("updater", `update downloaded: ${(info && info.version) || "?"}`);
    const response = dialog.showMessageBoxSync(win, {
      type: "info",
      buttons: ["Later", "Restart now"],
      defaultId: 1,
      cancelId: 0,
      title: "Update ready",
      message: "A new version of ekoloko is ready to install.",
      detail: `Version ${info && info.version ? info.version : ""} will be applied after restart.`,
    });
    if (response === 1) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // Re-check periodically for long-running sessions.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  logger.init({ flashVersion: FLASH_VERSION });
  logger.info("app", `ekoloko starting (debugMode=${DEBUG_MODE})`);
  logger.info(
    "flash",
    `ppapi-flash v${FLASH_VERSION} path=${flashPluginPath} exists=${fs.existsSync(flashPluginPath)}`
  );

  // Surface whether Chromium is hardware-accelerated or fell back to software
  // (SwiftShader) compositing. Software compositing is the prime suspect for
  // Flash FPS lag that only shows up in the app and not in standalone Chrome.
  try {
    const gpu = app.getGPUFeatureStatus();
    logger.info(
      "gpu",
      `gpu_compositing=${gpu.gpu_compositing} 2d_canvas=${gpu.gpu_compositing && gpu["2d_canvas"]} webgl=${gpu.webgl} rasterization=${gpu.rasterization}`
    );
  } catch (e) {
    logger.warn("gpu", `could not read GPU feature status: ${(e && e.message) || e}`);
  }

  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", (err && err.stack) || String(err));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", (reason && reason.stack) || String(reason));
  });

  // Only configure Flash trace/error logging when launched in debug mode; normal
  // users run the plain release player with no mm.cfg / flashlog side effects.
  if (DEBUG_MODE) ensureFlashDebugConfig();

  createAppMenu();
  createWindow();
  initAutoUpdater();

  ipcMain.on("zoom-change", async (_event, zoomFactor) => {
    await applyZoom(zoomFactor);
  });

  ipcMain.on("mute-toggle", (_event, muted) => {
    applyMute(muted);
  });

  ipcMain.on("restart", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.on("dark-mode-toggle", async (_event, isDark) => {
    isDarkMode = isDark;
    const bg = isDark ? "#1c2d4a" : "#6aaa1e";
    if (win) win.setBackgroundColor(bg);
    if (siteView) {
      siteView.setBackgroundColor(bg);
      await applyDarkModeCSS(isDark);
    }
  });

  ipcMain.on("open-discord", () => {
    openDiscordLink();
  });

  ipcMain.on("google-signin", async (event) => {
    const config = getOAuthConfig();
    if (!config) {
      event.reply("google-signin-result", { ok: false, error: "missing google-oauth.json" });
      return;
    }
    try {
      const profile = await googleAuth.signIn(config);
      pendingGoogleProfile = profile;
      logger.info("auth", `google sign-in ok (${profile.email || profile.sub})`);
      event.reply("google-signin-result", {
        ok: true,
        profile: { name: profile.name, email: profile.email, picture: profile.picture },
      });
    } catch (e) {
      logger.error("auth", `google sign-in failed: ${(e && e.message) || e}`);
      event.reply("google-signin-result", { ok: false, error: (e && e.message) || String(e) });
    }
  });

  ipcMain.on("link-account", (event, creds) => {
    if (!creds || !creds.username || !creds.password) {
      event.reply("link-account-result", { ok: false, error: "חסרים פרטים" });
      return;
    }
    vault.save({
      google: pendingGoogleProfile,
      game: { username: creds.username, password: creds.password },
      linkedAt: new Date().toISOString(),
    });
    logger.info("auth", `linked game account "${creds.username}"`);
    createGameView(buildAutoLoginUrl(creds.username));
  });

  ipcMain.on("sign-out", () => {
    vault.clear();
    pendingGoogleProfile = null;
    logger.info("auth", "signed out; vault cleared");
    createSignInView();
  });

  ipcMain.on("open-register", () => {
    createGameView(`${LOGIN_URL}?register=1`);
  });

  ipcMain.on("open-game-plain", () => {
    createGameView(LOGIN_URL);
  });

  ipcMain.on("play-as-guest", (_event, guestName) => {
    // "Auto-create, reuse per device": one throwaway account per machine,
    // remembered in the vault. If we already have it, log straight in;
    // otherwise create it once via the game's real registration screen
    // (register=1, name prefilled). The server deliberately blocks headless
    // registration (register.php gates on an anti-bot "authentication" check),
    // so the one-time creation must go through the genuine flow — after that,
    // every launch is one click. See vault.load()/auto-login in showApp().
    const stored = vault.load();
    if (stored && stored.guest && stored.game && stored.game.username) {
      logger.info("auth", `guest auto-login as "${stored.game.username}"`);
      createGameView(buildAutoLoginUrl(stored.game.username));
      return;
    }
    const name = /^[A-Za-z0-9]{3,20}$/.test(String(guestName || ""))
      ? guestName
      : `EcoGuest${100 + Math.floor(Math.random() * 900)}`;
    // Remember the intended guest name so the post-registration capture can
    // pair it with whatever password the player sets and store the pair.
    pendingGuestName = name;
    logger.info("auth", `creating guest account "${name}" via registration`);
    createGameView(`${LOGIN_URL}?register=1&username=${encodeURIComponent(name)}`);
  });

  ipcMain.on("clear-cache", async () => {
    if (siteView) {
      // clearCache() only drops the HTTP cache. The game's preload_assets.js
      // stashes the SWFs in localStorage for 24h offline use, and a corrupt or
      // over-quota entry there renders a blank screen that survives restarts and
      // the old cache-only clear. Wipe the persistent stores too, then reload so
      // the page re-fetches everything fresh.
      await siteView.webContents.session.clearCache();
      await siteView.webContents.session.clearStorageData({
        storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"],
      });
      siteView.webContents.reload();
    }
  });

  ipcMain.on("save-logs", async () => {
    let ok = false;
    try {
      ok = await saveLogsBundle();
    } catch (e) {
      logger.error("save-logs", (e && e.stack) || String(e));
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send("save-logs-done", ok);
    }
  });

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});
