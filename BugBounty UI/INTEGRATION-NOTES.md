# Bug Bounty Tab — Nexus Integration Notes

## preload.js

Your existing preload already exposes `window.nexus.invoke` via contextBridge.
The `bugbounty:run` and `bugbounty:abort` channels go through the same invoke — nothing extra needed IF your contextBridge already has a generic invoke:

```js
contextBridge.exposeInMainWorld('nexus', {
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),
});
```

If your preload uses a channel whitelist, add both channels:

```js
const ALLOWED = [
  'elysium:handoff',
  'bugbounty:run',    // ← add
  'bugbounty:abort',  // ← add
  // ...other channels
];
```

## main.js

Add these two lines near where other handlers are registered:

```js
const { registerBugBountyHandlers } = require('./bugBountyHandler');
registerBugBountyHandlers(ipcMain);
```

## Tab registration

In your sidebar nav, add Bug Bounty alongside existing tabs:

```js
{ key: 'bugbounty', label: 'Bug Bounty', icon: '◈' }
```

In your tab router:

```js
import BugBountyTab from './components/tabs/BugBountyTab';

{activeTab === 'bugbounty' && <BugBountyTab />}
```

## File locations

```
src/
├── components/
│   └── tabs/
│       └── BugBountyTab.jsx        ← drop here
├── main.js                         ← add registerBugBountyHandlers
└── preload.js                      ← check/add channels if whitelisted

bugBountyHandler.js                 ← drop alongside main.js (root or src/)
```

## Dependencies

`@anthropic-ai/sdk` is required in the main process. If not already installed:

```
npm install @anthropic-ai/sdk
```

`ANTHROPIC_API_KEY` must be in your `.env` (already present in Nexus).
