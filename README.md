# Idea Party 🎉

One shared canvas, point-to-point voice & video, and a party agent that programs the board with you.

No accounts. No build step. No dependencies — just [Bun](https://bun.sh).

## Run it

```bash
bun install   # nothing to install, really
bun start     # serves on http://localhost:3011 (PORT env overrides)
```

Open the URL, type your name, and either **start a party** (you get an 8-character party code + invite link) or **join** with a code. Share the invite link — everyone who opens it lands in the same room.

## The board

- **Stickies** (📝), **labels** (🏷), and **freehand strokes** (✏️) with an eraser (🧽)
- Drag to move, double-click text to edit, palette to recolor
- Pan (drag empty space / move tool), zoom (wheel / pinch)
- Live peer cursors with name tags
- **Voting**: the agent (or anyone) opens a vote; tap 👍 +1 on favorites, then tally
- **Shared timer** with a countdown banner

Everything is a sequenced operation broadcast over WebSocket and persisted in SQLite — late joiners replay the full board history.

## The party agent 🤖

The agent is deterministic and shared: everyone sees what it does. Two ways to drive it:

**From chat** — send a message starting with `agent:` (or open the agent panel):

```
agent: add sticky Ship it color green at 400,200
agent: add label Pricing
agent: move <id or words> to 100,200
agent: delete <id or words>
agent: color <id or words> pink
agent: arrange
agent: cluster
agent: count
agent: vote start · agent: vote stop · agent: tally
agent: timer 10
agent: clear      (asks for confirmation → agent: clear yes)
```

**From any program** (Milton, a script, anything):

```bash
curl -X POST http://localhost:3011/api/parties/<code>/agent \
  -H 'Content-Type: application/json' \
  -d '{"instruction": "cluster"}'
```

The agent's replies and board edits arrive as ordinary chat messages and canvas ops, so remote participants watch it work in real time.

## Voice & video

True **point-to-point WebRTC mesh**: the server only routes SDP/ICE signaling to the intended peer — audio/video packets never touch it. Click *Enable camera & mic*, and each participant gets a filmstrip tile with mute/deafen, speaking indicators, and connection-quality dots.

Caveats:

- **No TURN server is bundled.** Peers behind symmetric NATs may fail to connect directly; for those networks, run a coturn instance and point `RTC` at it in `public/app.js`.
- **Camera/mic need a secure origin.** On `localhost` it just works. On LAN devices, use HTTPS or add the URL under `chrome://flags` → *Insecure origins treated as secure*.

## Exposing it (Cloudflare Tunnel)

Idea Party works well behind [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/): you get a real `https://` URL (so camera/mic works on any device with no flags), no port forwarding, and the public URL doubles as the invite link. WebRTC media stays peer-to-peer — only signaling rides the tunnel.

```bash
# quick share: random https://*.trycloudflare.com URL
cloudflared tunnel --url http://localhost:3011
```

For a stable address, create a named tunnel and route DNS to it (`cloudflared tunnel create idea-party`, then `cloudflared tunnel route dns <id> party.example.com` with an ingress rule pointing at `http://localhost:3011`).

Note: Cloudflare drops WebSocket connections idle for ~100s. The client sends a `{t:"ping"}` heartbeat every 30s (server replies `{t:"pong"}`) to keep the socket alive.

## API

| Method | Path | What |
|---|---|---|
| `POST` | `/api/parties` | `{name}` → `{code, name}` |
| `GET` | `/api/parties/:code` | party info + peer count |
| `GET` | `/api/parties/:code/canvas` | full op history (for replay) |
| `POST` | `/api/parties/:code/agent` | `{"instruction": "…"}` → agent runs it |
| `WS` | `/ws?code=…&name=…` | live hub: ops, chat, cursors, signaling, presence |

WebSocket message types: `hello`, `welcome`, `op`, `chat`, `cursor`, `signal` (WebRTC), `media`, `timer`, `peer-join`, `peer-leave`.

## Tests

```bash
bun test
```

Covers the agent parser (24 tests), the real HTTP+WebSocket server (3 integration tests), and the client is verified with headless-Chromium screenshots (landing, board, voting, agent panel, chat, filmstrip, mobile).

## Data

Parties, canvas history, and chat persist in `./data/idea-party.db` (gitignored, created on first boot).
