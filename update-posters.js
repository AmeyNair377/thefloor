/*
  update-posters.js  —  keeps THE FLOOR in sync with your posters/ folders.

  WHAT IT DOES
  - Looks inside  posters/  : every sub-folder is a trapdoor, every image inside it is a poster.
  - Writes that list into index.html (between the POSTERS-MANIFEST markers), so you never type names.
  - Remembers WHEN it first saw each folder / poster. The site shows a NEW badge for 7 days after that.
  - Folders and posters are sorted A–Z by the website itself.

  HOW TO USE
  1. Put images in posters/<folder>/   (new folder = new trapdoor)
  2. Double-click update-posters.bat   (or run:  node update-posters.js)
  3. Commit + push as usual.

  RULES
  - Images: .webp .png .jpg .jpeg   (if the same name exists as .webp AND .png, the .webp is used)
  - A file or folder whose name starts with _ or . is ignored  (rename  dice.webp -> _dice.webp  to hide it)
  - "about" is special: its posters keep the order intro, bio, contact (new files go after them)
  - Options:  --dry   show what would change without touching index.html
*/
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const HTML = path.join(ROOT, "index.html");
const POSTERS = path.join(ROOT, "posters");
const START = "/*POSTERS-MANIFEST-START";
const END = "/*POSTERS-MANIFEST-END*/";
const OPEN = "const MANIFEST = ";
const EXTS = ["webp", "png", "jpg", "jpeg"]; // priority order
const ABOUT_ORDER = ["intro", "bio", "contact"];
const PALETTE = ["#F2E5A3", "#F2F06B", "#5EEAD4", "#F2B5C4", "#B9CDEB", "#FF8B5C", "#C4B5FD", "#86EFAC", "#FCA5A5", "#93C5FD"];

const pad2 = (n) => String(n).padStart(2, "0");
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder";

/* ---------- manifest <-> text ---------- */
function renderBlock(manifest, eol) {
  const lines = [];
  lines.push(`${START} — written by update-posters.js, do not edit by hand*/`);
  lines.push(`${OPEN}{`);
  lines.push(`  "initialized": ${manifest.initialized ? "true" : "false"},`);
  lines.push(`  "folders": [`);
  manifest.folders.forEach((f, fi) => {
    const head = JSON.stringify({ id: f.id, dir: f.dir, name: f.name, seam: f.seam, keepOrder: !!f.keepOrder, added: f.added || "" });
    lines.push(`    ${head.slice(0, -1)},"posters":[`);
    f.posters.forEach((p, pi) => {
      lines.push(`      ${JSON.stringify([p.name, p.file || "", p.added || ""])}${pi < f.posters.length - 1 ? "," : ""}`);
    });
    lines.push(`    ]}${fi < manifest.folders.length - 1 ? "," : ""}`);
  });
  lines.push(`  ]`);
  lines.push(`};`);
  lines.push(END);
  return lines.join(eol);
}

function readManifest(html) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("Could not find the POSTERS-MANIFEST markers in index.html.");
  const block = html.slice(a, b);
  const o = block.indexOf(OPEN);
  const semi = block.lastIndexOf(";");
  if (o === -1 || semi < o) throw new Error("The manifest block in index.html looks damaged.");
  const data = JSON.parse(block.slice(o + OPEN.length, semi));
  data.folders = (data.folders || []).map((f) => ({
    ...f,
    posters: (f.posters || []).map((p) => (Array.isArray(p) ? { name: p[0], file: p[1] || "", added: p[2] || "" } : p))
  }));
  return { data, start: a, end: b + END.length };
}

/* ---------- scan the disk ---------- */
function scanDisk() {
  if (!fs.existsSync(POSTERS)) throw new Error("There is no  posters  folder next to index.html.");
  const folders = [];
  const ignoredFiles = [];
  for (const d of fs.readdirSync(POSTERS, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith("_") || d.name.startsWith(".")) continue;
    const byName = new Map();
    for (const f of fs.readdirSync(path.join(POSTERS, d.name), { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith("_") || f.name.startsWith(".")) continue;
      const parsed = path.parse(f.name);
      const ext = parsed.ext.slice(1).toLowerCase();
      if (!EXTS.includes(ext)) { ignoredFiles.push(`${d.name}/${f.name}`); continue; }
      const cur = byName.get(parsed.name);
      if (!cur || EXTS.indexOf(ext) < EXTS.indexOf(cur.ext)) byName.set(parsed.name, { file: f.name, ext });
    }
    const posters = [...byName.entries()].map(([name, v]) => ({ name, file: v.file }));
    folders.push({ dir: d.name, posters });
  }
  folders.sort((a, b) => collator.compare(a.dir, b.dir));
  return { folders, ignoredFiles };
}

/* ---------- reconcile disk with the saved manifest ---------- */
function reconcile(old, disk) {
  const baseline = !old.initialized; // first ever run: nothing counts as "new"
  const day = baseline ? "" : today();
  const report = { newFolders: [], newPosters: [], removedFolders: [], removedPosters: [], baseline, empty: [] };
  const oldByDir = new Map(old.folders.map((f) => [f.dir, f]));
  const usedSeams = new Set(old.folders.filter((f) => f.id !== "about").map((f) => f.seam));
  const usedIds = new Set(old.folders.map((f) => f.id));
  const out = [];

  for (const df of disk.folders) {
    if (!df.posters.length) { report.empty.push(df.dir); continue; }
    const ex = oldByDir.get(df.dir);
    const isAbout = df.dir.toLowerCase() === "about";
    let folder;
    if (ex) {
      folder = { ...ex, posters: [] };
      const oldPosters = new Map(ex.posters.map((p) => [p.name, p]));
      for (const dp of df.posters) {
        const op = oldPosters.get(dp.name);
        if (op) folder.posters.push({ name: dp.name, file: dp.file, added: op.added || "" });
        else { folder.posters.push({ name: dp.name, file: dp.file, added: day }); if (!baseline) report.newPosters.push(`${df.dir}/${dp.name}`); }
      }
      for (const op of ex.posters) if (!df.posters.some((p) => p.name === op.name)) report.removedPosters.push(`${df.dir}/${op.name}`);
      if (ex.keepOrder) {
        const rank = new Map(ex.posters.map((p, i) => [p.name, i]));
        folder.posters.sort((a, b) => (rank.has(a.name) ? rank.get(a.name) : 1e9) - (rank.has(b.name) ? rank.get(b.name) : 1e9) || collator.compare(a.name, b.name));
      } else folder.posters.sort((a, b) => collator.compare(a.name, b.name));
    } else {
      let id = slug(df.dir), n = 2;
      while (usedIds.has(id)) id = `${slug(df.dir)}-${n++}`;
      usedIds.add(id);
      let seam = PALETTE.find((c) => !usedSeams.has(c)) || PALETTE[out.length % PALETTE.length];
      if (isAbout) seam = "#F5F5F5"; else usedSeams.add(seam);
      folder = {
        id, dir: df.dir,
        name: isAbout ? "ABOUT ME" : df.dir.replace(/[-_]+/g, " ").toUpperCase(),
        seam, keepOrder: isAbout, added: day,
        posters: df.posters.map((p) => ({ name: p.name, file: p.file, added: day }))
      };
      if (isAbout) {
        const r = (n) => { const i = ABOUT_ORDER.indexOf(n.toLowerCase()); return i === -1 ? 1e9 : i; };
        folder.posters.sort((a, b) => r(a.name) - r(b.name) || collator.compare(a.name, b.name));
      } else folder.posters.sort((a, b) => collator.compare(a.name, b.name));
      if (!baseline) report.newFolders.push(`${df.dir} (${folder.posters.length} posters)`);
    }
    out.push(folder);
  }
  for (const f of old.folders) if (!disk.folders.some((d) => d.dir === f.dir && d.posters.length)) report.removedFolders.push(f.dir);
  out.sort((a, b) => collator.compare(a.dir, b.dir));
  return { manifest: { initialized: true, folders: out }, report };
}

/* ---------- main ---------- */
function main() {
  const dry = process.argv.includes("--dry");
  const html = fs.readFileSync(HTML, "utf8");
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const { data, start, end } = readManifest(html);
  const disk = scanDisk();
  const { manifest, report } = reconcile(data, disk);

  const total = manifest.folders.reduce((a, f) => a + f.posters.length, 0);
  console.log("");
  console.log(`THE FLOOR — found ${manifest.folders.length} folders and ${total} posters.`);
  manifest.folders.forEach((f) => console.log(`   ${f.name.padEnd(14)} ${String(f.posters.length).padStart(3)} posters`));
  console.log("");
  if (report.baseline) console.log("First run: everything currently in your folders is treated as already published (no NEW badges).");
  report.newFolders.forEach((x) => console.log(`+ NEW folder   ${x}`));
  report.newPosters.forEach((x) => console.log(`+ NEW poster   ${x}`));
  report.removedFolders.forEach((x) => console.log(`- removed folder ${x}  (no longer on disk)`));
  report.removedPosters.forEach((x) => console.log(`- removed poster ${x}  (no longer on disk)`));
  report.empty.forEach((x) => console.log(`! skipped empty folder ${x}`));
  disk.ignoredFiles.forEach((x) => console.log(`! ignored (not .webp/.png/.jpg/.jpeg): ${x}`));

  const next = html.slice(0, start) + renderBlock(manifest, eol) + html.slice(end);
  if (next === html) { console.log("\nNothing changed — index.html is already up to date."); return; }
  if (dry) { console.log("\n--dry: index.html was NOT changed."); return; }
  fs.writeFileSync(HTML, next, "utf8");
  console.log("\nindex.html updated. Now commit + push to publish.");
}

module.exports = { renderBlock, readManifest, reconcile, scanDisk };
if (require.main === module) {
  try { main(); } catch (e) { console.error("\nERROR: " + e.message); process.exitCode = 1; }
}
