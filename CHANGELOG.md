# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-11-22

### Changed

- New website: [netspy-js.vercel.app](https://netspy-js.vercel.app). It is now the
  package homepage on npm and GitHub, and is linked from the README.

## [1.0.0] - 2026-11-19

First stable release. Mostly bug fixes; a few behaviour changes are marked
**Breaking**.

### Fixed

- **Fast requests no longer show up twice or stay "pending" forever.** The
  "start" and "end" reports could arrive out of order; the panel now merges
  them whatever the order.
- **`fetch()` headers are captured.** Request headers passed as a `Headers`
  instance or on a `Request` object, and all `fetch()` response headers, used to
  show up as `{}`.
- **Request bodies are readable.** `Buffer`/binary, `Blob`, stream and form-data
  bodies used to be serialised byte by byte (huge payloads, or dropped entirely
  above 1 MB). They are now summarised, `URLSearchParams` is shown as text, and
  long text bodies are truncated.
- **Stopping NetSpy now also stops your app.** On SIGTERM the wrapped process
  was orphaned behind an intermediate shell and kept running. NetSpy now exits
  with the command's exit code, or 128 + signal number.
- **NetSpy no longer crashes when no browser opener is installed** (headless
  Linux, Docker, CI, WSL without `xdg-open`).
- **Your command's flags are no longer taken by NetSpy.** `netspy next dev -p 3001`
  used to start the panel on 3001; options are now parsed only before the
  command.
- **Arguments with spaces or quotes reach the command intact.** They used to be
  re-split by the shell.
- Clear in the panel used to leave the request hanging and didn't update other
  open tabs.
- The request-details drawer covered the Clear button and filter box.
- URLs containing quotes could break the panel markup (missing attribute escaping).
- The panel rebuilt the whole table on every event and animated every element;
  rendering is now batched per frame.
- An `http`/`https` request error without an `error` listener no longer gets
  silently swallowed by the interceptor (the app now behaves the same as
  without NetSpy).
- `https` module requests are labelled `https` (they were labelled `http`), and
  URLs built from request options handle `host:port`, custom protocols, default
  ports and IPv6.
- Unknown commands now print `command not found` and exit 127; invalid ports
  are rejected with a clear message.

### Security

- **Breaking:** the panel now listens on `127.0.0.1` only. It used to be
  reachable from your local network, exposing captured `Authorization` headers
  and cookies. The printed URL is now `http://127.0.0.1:<port>`.
- The panel rejects requests whose `Host` header isn't localhost (DNS-rebinding
  protection).
- Upgraded `zod` to v4 (fixes GHSA-mrhx-c7xc-m3w5).

### Added

- `--no-open`, `--help`, `--version`, `--port <n>` / `--port=<n>`, and `--` to
  end NetSpy's options.
- Leading `NAME=value` arguments set environment variables for the command, on
  every platform (`netspy PORT=3001 node server.js`).
- `npm test` runs before publishing; new tests cover the CLI, the panel server
  and the wrapper end to end.

### Changed

- **Breaking:** a command given as several arguments is now spawned directly
  instead of through a shell. To use shell features (`&&`, pipes, globs), pass
  the whole command as one quoted argument: `netspy "npm run build && npm start"`.
  Windows still uses `cmd` so `.cmd` shims like `npm` keep working.
- `LICENCE` was renamed to `LICENSE` to match `package.json`.

## [0.3.5] and earlier

Pre-1.0 releases. See the git history.

[1.0.1]: https://github.com/mursel05/netspy/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mursel05/netspy/compare/v0.3.5...v1.0.0
[0.3.5]: https://github.com/mursel05/netspy/releases/tag/v0.3.5
