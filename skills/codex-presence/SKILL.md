---
name: codex-presence
description: Show, update, or clear the "Playing Codex" Discord Rich Presence while the user works in ChatGPT or Codex.
---

Use this skill when the user asks to display Codex activity in Discord, update the Discord status or presence, or remove the activity.

1. Call `get_discord_presence_status` first.
2. If `configured` is false, follow the `setup-discord-app` skill. Do not attempt to invent or reuse another user's Application ID.
3. If configured but not connected, ask the user to open the Discord desktop app and sign in, then check again.
4. Call `show_codex_activity` with optional `details` and `state`. Defaults are `Pair programming with ChatGPT` and `Building with Codex`.
5. Use `resetTimer: true` only when the user asks to restart the elapsed-time counter.
6. Treat the result as successful only when it has `ok: true`, `connected: true`, and a non-null `currentActivity`.
7. When clearing, call `clear_discord_activity`; `cleared: false` can still mean there was no active IPC session because Discord was closed.
8. Report the actual `applicationName`. Discord displays `Playing <applicationName>`; exact `Playing Codex` requires the Discord application itself to be named `Codex`.
9. If `server/live-presence.js` is running (check `%USERPROFILE%\.codex-discord-presence\live.pid`), it already owns the Discord IPC connection and updates the second line automatically with thinking / answering / executing / editing states. Prefer letting it manage the subtitle instead of calling `show_codex_activity` repeatedly; Discord only honors one IPC connection per application ID.

This plugin only changes the local user's Discord Rich Presence. It cannot read another Discord user's activity, set a free-form Discord custom status, or work while the Discord desktop client is closed. Do not claim otherwise.
