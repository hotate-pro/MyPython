import * as CheerpX from "https://cxrtnc.leaningtech.com/1.2.8/cx.esm.js";

const DISK_URL = "wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2";
const DB_ROOT = "webpython-root-v1";
const DB_WORKSPACE = "webpython-workspace-v1";
const decoder = new TextDecoder();
const encoder = new TextEncoder();

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const fileTree = $("fileTree");
const tabsEl = $("tabs");
const terminalPanel = $("terminalPanel");
const terminalOutput = $("terminalOutput");
const terminalForm = $("terminalForm");
const terminalInput = $("terminalInput");
const statusText = $("statusText");
const cursorText = $("cursorText");
const currentPath = $("currentPath");
const vmBadge = $("vmBadge");
const toast = $("toast");

let cx = null;
let dataDevice = null;
let workspaceDevice = null;
let rootOverlay = null;
let payloadCounter = 0;
let commandQueue = Promise.resolve();
let captureContext = null;
let shellInput = null;
let shellRunning = false;
let tabs = [];
let activeTab = null;
let treeEntries = [];

const normalOpts = {
  env: [
    "HOME=/home/user",
    "TERM=dumb",
    "USER=user",
    "SHELL=/bin/bash",
    "EDITOR=vim",
    "LANG=C.UTF-8",
    "LC_ALL=C",
    "PS1=$ ",
  ],
  cwd: "/home/user",
  uid: 1000,
  gid: 1000,
};

const rootOpts = { ...normalOpts, uid: 0, gid: 0, HOME: undefined };

autoBoot();

async function autoBoot() {
  try {
    if (location.protocol === "file:") {
      throw new Error("file:// では動きません。HTTPSのWebサイトか localhost で開いてください。");
    }
    if (!window.crossOriginIsolated) {
      setStatus("COOP/COEP待機中…");
      // coi-serviceworker can reload once; give it a moment before hard-failing.
      await new Promise((r) => setTimeout(r, 900));
    }
    if (!window.crossOriginIsolated) {
      throw new Error("Cross-Origin Isolation が有効になっていません。GitHub Pagesなら coi-serviceworker、Cloudflare Pagesなら _headers を使用してください。");
    }

    setStatus("Debianディスクへ接続中…");
    const cloud = await CheerpX.CloudDevice.create(DISK_URL);
    const rootCache = await CheerpX.IDBDevice.create(DB_ROOT);
    rootOverlay = await CheerpX.OverlayDevice.create(cloud, rootCache);
    workspaceDevice = await CheerpX.IDBDevice.create(DB_WORKSPACE);
    dataDevice = await CheerpX.DataDevice.create();

    const mounts = [
      { type: "ext2", path: "/", dev: rootOverlay },
      { type: "dir", path: "/workspace", dev: workspaceDevice },
      { type: "dir", path: "/data", dev: dataDevice },
      { type: "devs", path: "/dev" },
      { type: "devpts", path: "/dev/pts" },
      { type: "proc", path: "/proc" },
      { type: "sys", path: "/sys" },
    ];

    cx = await CheerpX.Linux.create({ mounts });
    shellInput = cx.setCustomConsole((buf) => {
      const text = decoder.decode(new Uint8Array(buf), { stream: true });
      if (captureContext) {
        captureContext.chunks.push(text);
        if (captureContext.show) appendTerminal(text);
      } else {
        appendTerminal(text);
      }
    });

    setStatus("Linux初期化中…");
    await enqueue(() => cx.run("/bin/chmod", ["-R", "u+rwX,g+rwX", "/workspace"], rootOpts));

    await ensureInitialWorkspace();
    await refreshExplorer();
    startInteractiveShell();
    vmBadge.textContent = "Linux online";
    vmBadge.className = "badge online";
    setStatus("Linux ready");

    const saved = localStorage.getItem("webpython-active") || "/workspace/main.py";
    if (treeEntries.some((e) => e.path === saved && e.type === "f")) {
      await openFile(saved);
    } else {
      await openFile("/workspace/main.py");
    }

    appendTerminal("WebPython Linux ready. 例: python3 --version / apt --version\n", "system");
  } catch (error) {
    console.error(error);
    vmBadge.textContent = "Error";
    vmBadge.className = "badge error";
    setStatus("起動失敗");
    appendTerminal(`[WebPython] ${error?.stack || error}\n`, "error");
    showToast(error.message || String(error), true);
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => (toast.className = "toast"), 2200);
}

function appendTerminal(text, kind = "normal") {
  if (!text) return;
  const prefix = kind === "error" ? "[error] " : kind === "system" ? "[webpython] " : "";
  terminalOutput.textContent += prefix + text;
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
  terminalPanel.classList.remove("hidden");
}

function shQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
}

function shellPath(path) {
  if (!path.startsWith("/workspace/")) throw new Error(`不正なworkspace path: ${path}`);
  return path;
}

function enqueue(fn) {
  const run = commandQueue.then(fn, fn);
  commandQueue = run.catch(() => {});
  return run;
}

async function captureCommand(command, { root = false, show = true, cwd = "/home/user" } = {}) {
  if (!cx) throw new Error("Linuxがまだ起動していません");
  return enqueue(async () => {
    const ctx = { chunks: [], show };
    const previous = captureContext;
    captureContext = ctx;
    try {
      const result = await cx.run("/bin/bash", ["-lc", command], {
        ...(root ? rootOpts : normalOpts),
        cwd,
      });
      return { text: ctx.chunks.join(""), status: result?.status ?? 0 };
    } finally {
      captureContext = previous;
    }
  });
}

function startInteractiveShell() {
  if (!cx || shellRunning) return;
  shellRunning = true;
  void cx.run("/bin/bash", ["--noprofile", "--norc", "-i"], {
    ...normalOpts,
    env: [...normalOpts.env, "PS2=> "]
  }).then((result) => {
    shellRunning = false;
    appendTerminal(`\n[ shell exited: ${result?.status ?? 0} ]\n`);
  }).catch((e) => {
    shellRunning = false;
    appendTerminal(`\n[ shell error ] ${e?.message || e}\n`, "error");
  });
}

function sendShellText(text) {
  if (!shellInput) throw new Error("Linux shell is not ready");
  for (const byte of encoder.encode(text)) shellInput(byte);
}

function sendShellCommand(command) {
  if (!shellRunning) startInteractiveShell();
  sendShellText(command + "\n");
}

async function copyDataToWorkspace(bytesOrText, targetPath) {
  shellPath(targetPath);
  const payload = `/payload_${++payloadCounter}`;
  await dataDevice.writeFile(payload, typeof bytesOrText === "string" ? bytesOrText : new Uint8Array(bytesOrText));
  const parent = targetPath.slice(0, targetPath.lastIndexOf("/")) || "/workspace";
  const result = await enqueue(() => cx.run("/bin/bash", ["-lc", `mkdir -p ${shQuote(parent)} && cp -- ${shQuote("/data" + payload)} ${shQuote(targetPath)}`], rootOpts));
  if (result.status !== 0) throw new Error(`ファイル配置に失敗しました: ${targetPath}`);
}

async function readWorkspaceText(path) {
  shellPath(path);
  const result = await captureCommand(`cat -- ${shQuote(path)}`, { show: false });
  if (result.status !== 0) throw new Error(`読み込み失敗: ${path}`);
  return result.text;
}

async function ensureInitialWorkspace() {
  const result = await captureCommand("find /workspace -mindepth 1 -maxdepth 1 -print", { show: false });
  if (result.status !== 0 || result.text.trim() === "") {
    await copyDataToWorkspace("print(\"Hello Linux!\")\n", "/workspace/main.py");
    await copyDataToWorkspace("# WebPython test\nprint(2 + 3)\n", "/workspace/test.py");
  }
}

async function refreshExplorer() {
  const result = await captureCommand("find /workspace -mindepth 1 -maxdepth 4 -printf '%y\\t%p\\n' | sort", { show: false });
  if (result.status !== 0) return;
  treeEntries = result.text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [type, ...rest] = line.split("\t");
      return { type, path: rest.join("\t") };
    });
  renderTree();
}

function renderTree() {
  fileTree.innerHTML = "";
  const files = treeEntries.filter((e) => e.path !== "/workspace");
  if (!files.length) {
    fileTree.innerHTML = `<div style="padding:12px;color:#777;font-size:12px">/workspace is empty</div>`;
    return;
  }
  for (const entry of files) {
    const relative = entry.path.replace(/^\/workspace\//, "");
    const depth = relative.split("/").length - 1;
    const button = document.createElement("button");
    button.className = `file-item ${entry.type === "d" ? "folder" : ""}${activeTab === entry.path ? " active" : ""}`;
    button.style.paddingLeft = `${10 + depth * 14}px`;
    const icon = entry.type === "d" ? "▸" : "•";
    button.innerHTML = `<span class="kind">${icon}</span><span></span>`;
    button.children[1].textContent = relative.split("/").at(-1) + (entry.type === "d" ? "/" : "");
    button.addEventListener("click", async () => {
      if (entry.type === "d") return;
      await openFile(entry.path);
    });
    fileTree.appendChild(button);
  }
}

async function openFile(path) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) {
    activeTab = path;
    editor.value = existing.content;
    currentPath.textContent = path;
    renderTabs();
    renderTree();
    localStorage.setItem("webpython-active", path);
    updateCursor();
    return;
  }
  const content = await readWorkspaceText(path);
  tabs.push({ path, content, dirty: false });
  activeTab = path;
  editor.value = content;
  currentPath.textContent = path;
  renderTabs();
  renderTree();
  localStorage.setItem("webpython-active", path);
  updateCursor();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const tab of tabs) {
    const el = document.createElement("button");
    el.className = `tab${tab.path === activeTab ? " active" : ""}`;
    const name = tab.path.split("/").at(-1);
    const dirty = tab.dirty ? " •" : "";
    el.innerHTML = `<span></span><span class="close">×</span>`;
    el.children[0].textContent = name + dirty;
    el.addEventListener("click", () => switchTab(tab.path));
    el.children[1].addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await closeTab(tab.path);
    });
    tabsEl.appendChild(el);
  }
}

function switchTab(path) {
  const tab = tabs.find((t) => t.path === path);
  if (!tab) return;
  activeTab = path;
  editor.value = tab.content;
  currentPath.textContent = path;
  renderTabs();
  renderTree();
  updateCursor();
}

async function closeTab(path) {
  const tab = tabs.find((t) => t.path === path);
  if (!tab) return;
  if (tab.dirty && !confirm(`${path} には未保存の変更があります。閉じますか？`)) return;
  tabs = tabs.filter((t) => t.path !== path);
  if (activeTab === path) {
    activeTab = tabs.at(-1)?.path || null;
    if (activeTab) switchTab(activeTab);
    else {
      editor.value = "";
      currentPath.textContent = "—";
    }
  }
  renderTabs();
}

async function saveActive() {
  const tab = tabs.find((t) => t.path === activeTab);
  if (!tab) return;
  tab.content = editor.value;
  await copyDataToWorkspace(tab.content, tab.path);
  tab.dirty = false;
  renderTabs();
  await refreshExplorer();
  showToast("保存しました");
}

async function runActive() {
  const tab = tabs.find((t) => t.path === activeTab);
  if (!tab) return;
  await saveActive();
  terminalPanel.classList.remove("hidden");
  sendShellCommand(`cd /workspace && python3 ${shQuote(tab.path)}; code=$?; printf "\n[webpython exit %s]\n" "$code"`);
}

async function executeTerminalInput() {
  const command = terminalInput.value.trim();
  if (!command) return;
  const root = $("rootMode").checked;
  terminalInput.value = "";
  if (root) {
    appendTerminal(`\n# ${command}\n`);
    const result = await captureCommand(command, { root: true, show: true });
    appendTerminal(`[root exit ${result.status}]\n`);
  } else {
    sendShellCommand(command);
  }
}

async function newFile() {
  const name = prompt("workspace内のファイル名", "main2.py");
  if (!name) return;
  const clean = name.replace(/^\/+/, "");
  const path = `/workspace/${clean}`;
  if (clean.includes("..")) return showToast(".. は使えません", true);
  await copyDataToWorkspace("", path);
  await refreshExplorer();
  await openFile(path);
}

async function newFolder() {
  const name = prompt("workspace内のフォルダ名", "project");
  if (!name) return;
  const clean = name.replace(/^\/+/, "");
  if (clean.includes("..")) return showToast(".. は使えません", true);
  const result = await captureCommand(`mkdir -p ${shQuote(`/workspace/${clean}`)}`, { root: false });
  if (result.status !== 0) return showToast("フォルダ作成に失敗", true);
  await refreshExplorer();
}

async function importFolder() {
  if (!window.showDirectoryPicker) {
    $("folderInput").click();
    return;
  }
  const dir = await window.showDirectoryPicker({ mode: "read" });
  await importDirectoryHandle(dir, "");
  await refreshExplorer();
  showToast("インポート完了");
}

async function importDirectoryHandle(handle, relative) {
  for await (const [name, entry] of handle.entries()) {
    const rel = relative ? `${relative}/${name}` : name;
    if (entry.kind === "directory") {
      await importDirectoryHandle(entry, rel);
    } else {
      const file = await entry.getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      await copyDataToWorkspace(bytes, `/workspace/${rel}`);
    }
  }
}

async function exportFolder() {
  if (!window.showDirectoryPicker) return showToast("このブラウザはフォルダ書き込みをサポートしていません", true);
  const dir = await window.showDirectoryPicker({ mode: "readwrite" });
  const result = await captureCommand("find /workspace -type f -print", { show: false });
  const paths = result.text.split("\n").map((x) => x.trim()).filter(Boolean);
  for (const path of paths) {
    const relative = path.replace(/^\/workspace\//, "");
    const pieces = relative.split("/");
    let target = dir;
    for (const folder of pieces.slice(0, -1)) target = await target.getDirectoryHandle(folder, { create: true });
    const fileHandle = await target.getFileHandle(pieces.at(-1), { create: true });
    const writable = await fileHandle.createWritable();
    try {
      const b64 = await captureCommand(`base64 -w 0 ${shQuote(path)}`, { show: false });
      const bytes = Uint8Array.from(atob(b64.text.trim()), (c) => c.charCodeAt(0));
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }
  showToast("エクスポート完了");
}

async function removeActive() {
  if (!activeTab) return;
  if (!confirm(`${activeTab} を削除しますか？`)) return;
  const path = activeTab;
  await captureCommand(`rm -rf -- ${shQuote(path)}`, { root: true });
  await closeTab(path);
  await refreshExplorer();
}

function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split("\n").length;
  const col = before.length - before.lastIndexOf("\n");
  cursorText.textContent = `Ln ${line}, Col ${col}`;
}

editor.addEventListener("input", () => {
  const tab = tabs.find((t) => t.path === activeTab);
  if (!tab) return;
  tab.content = editor.value;
  tab.dirty = true;
  renderTabs();
  updateCursor();
});
editor.addEventListener("click", updateCursor);
editor.addEventListener("keyup", updateCursor);
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText("    ", start, end, "end");
    editor.dispatchEvent(new Event("input"));
  }
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    saveActive().catch((err) => showToast(err.message, true));
  }
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    runActive().catch((err) => appendTerminal(`[error] ${err.message}\n`, "error"));
  }
});

$("saveButton").addEventListener("click", () => saveActive().catch((e) => showToast(e.message, true)));
$("runButton").addEventListener("click", () => runActive().catch((e) => appendTerminal(`[error] ${e.message}\n`, "error")));
$("runToolbarButton").addEventListener("click", () => runActive().catch((e) => appendTerminal(`[error] ${e.message}\n`, "error")));
$("clearTerminal").addEventListener("click", () => (terminalOutput.textContent = ""));
$("closeTerminal").addEventListener("click", () => terminalPanel.classList.add("hidden"));
$("terminalOutput").addEventListener("click", () => terminalInput.focus());

$("terminalForm").addEventListener("submit", (e) => {
  e.preventDefault();
  executeTerminalInput().catch((err) => appendTerminal(`[error] ${err.message}\n`, "error"));
});

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", async () => {
    try {
      switch (button.dataset.action) {
        case "new-file": return await newFile();
        case "new-folder": return await newFolder();
        case "refresh": return await refreshExplorer();
        case "terminal-toggle": terminalPanel.classList.toggle("hidden"); terminalInput.focus(); return;
        case "import": return await importFolder();
        case "export": return await exportFolder();
      }
    } catch (e) {
      console.error(e);
      appendTerminal(`[error] ${e.message || e}\n`, "error");
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Shift" && false) return;
  if (e.key === "Escape" && !terminalPanel.classList.contains("hidden")) terminalPanel.classList.add("hidden");
});
