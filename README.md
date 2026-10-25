# Markdown Reader

A VS Code extension for listening to a Markdown file while you follow it with your eyes. Click a sentence and it is read aloud from there, highlighted as it goes, so you can re-read long specs fast and stop to edit where needed.

The reader is a working draft; remaining deliverables are tracked in [`docs/specs/0002-reader.md`](docs/specs/0002-reader.md).

## Build and install

With Node.js 24 or newer and desktop VS Code 1.110 or newer:

```sh
npm ci
npm run check
npx --yes @vscode/vsce package --no-dependencies --out markdown-reader.vsix
```

Packaging runs the production bundle automatically. Install the VSIX in VS Code through **Extensions: Install from VSIX...**, or run this in a terminal on your local computer:

```sh
code --install-extension ./markdown-reader.vsix --force
```

Reload the window, run **Markdown Reader: Set API Key**, open a Markdown file and click **Read Aloud** in the editor title bar.

## Remote SSH and audio

Install Markdown Reader on your **local computer**, including when you use Remote SSH. When building on an SSH host, download the generated VSIX and install it from a local VS Code window, then reconnect. The extension runs in the local UI extension host: VS Code provides the remote document while Inworld requests, audio caching and playback run on the client. Source-line navigation still opens the remote document.

On Linux and macOS, install FFmpeg/ffplay locally and leave `markdownReader.audioOutput` at `auto`, or choose `ffplay` explicitly. FFmpeg is not bundled. Windows uses the local webview because native pause requires POSIX signals. The `webview` option remains available on every supported client; some VS Code builds, including the tested Linux snap, may have silent webview audio.

An old remote installation's audio cache and spend history are not copied to the local computer. This extension requires desktop VS Code; browser-only VS Code has no local Node.js host for ffplay.
