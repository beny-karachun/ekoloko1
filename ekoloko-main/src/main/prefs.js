// Tiny, non-secret "which mode to resume" marker.
//
// We deliberately do NOT store game passwords: the Flash client's own
// "remember me" keeps players logged in (its relogin token lives in the
// PPAPI Flash local store), so all this file needs to remember is which
// entry mode to drop the user into on the next launch — guest / google /
// plain — plus the last username, purely to prefill the game's field. None
// of it is sensitive, so it's plain JSON under userData.

const { app } = require("electron");
const fs = require("fs");
const path = require("path");

function prefsPath() {
  return path.join(app.getPath("userData"), "session.json");
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function save(obj) {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(obj || {}), "utf8");
  } catch (e) {}
}

function clear() {
  try {
    fs.unlinkSync(prefsPath());
  } catch (e) {}
}

module.exports = { load, save, clear };
