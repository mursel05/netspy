# Netspy

Wrap any dev command and watch its server-side requests live, in a
DevTools-style network panel in your browser — even though those requests
never touch the browser's own Network tab.

```bash
netspy npm run dev
# -> opens http://localhost:4000 with a live list of every request
#    your server process makes (SSR data fetching, RSC loaders, etc.)
```

Works with Next.js, Remix, plain Express, or anything else that runs on
Node 18+, since it patches the _global_ `fetch`, not framework internals.

## Install & use

```bash
npm install -g netspy

netspy npm run dev          # default port 4000
netspy -p 9000 npm run dev          # specify a port
netspy node server.js          # run a custom server script
```

Open the printed URL (it also tries to auto-open your default browser).
Every server-side request call made by the wrapped process — at boot,
during SSR, in route handlers, anywhere — shows up as a row with method,
URL, status, and duration. Click a row for details. Use the filter box to
narrow by URL. "Clear" wipes the current session's log.