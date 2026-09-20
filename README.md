# WebPython

Browser-first Python IDE powered by CheerpX/WebVM's Debian environment.

## What it does

- Runs real `python3` inside a browser Linux VM.
- Uses a persistent `/workspace` backed by IndexedDB.
- Save / Run / tabs / Explorer.
- Integrated one-command terminal.
- Optional `root` mode for package management (`apt`).
- Folder import/export via the File System Access API.
- No npm / Node.js is required on the user's PC.

## Hosting

### GitHub Pages

Push the repository to GitHub, enable **Pages → GitHub Actions**, and let `.github/workflows/pages.yml` deploy it.
The included `coi-serviceworker.js` is the standard static-host workaround for COOP/COEP.

### Cloudflare Pages

Deploy the folder as a static site. The `_headers` file enables COOP/COEP directly.

## Important

Do not open `index.html` with `file://`. CheerpX requires a cross-origin-isolated secure web context. Local development should use an HTTP server with the required COOP/COEP headers.

The Linux image is the public WebVM Debian image selected by the WebVM project. CheerpX/WebVM licensing and hosting restrictions still apply; this project does not redistribute the CheerpX runtime. See the official WebVM and CheerpX licensing pages before public/commercial redistribution.

## First test

Once the page starts, use the terminal:

```bash
python3 --version
apt --version
```

Then edit `main.py` and press **▶ 実行**.

## Package management

The Terminal has a `root` checkbox. Turn it on for commands such as:

```bash
apt update
apt install python3-pip
```

Then normal user commands can use Python/pip as appropriate.
