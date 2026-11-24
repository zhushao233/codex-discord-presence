---
name: setup-discord-app
description: Set up Discord Codex Presence for the first time by saving a Discord application client ID locally, then verifying that the Discord desktop IPC connection works.
---

Use this skill when the plugin is first installed, when `get_discord_presence_status` reports `configured: false`, or when the user wants to change the Discord application used for the activity.

1. Explain that Rich Presence uses the local Discord desktop client and does **not** need a bot token, Discord password, or OAuth login.
2. Tell the user to open <https://discord.com/developers/applications>, create an application named `Codex`, and copy its **Application ID** from **General Information**.
3. The Discord application name becomes the activity label. If it is named `Codex`, Discord shows `Playing Codex`. If it has another name, do not claim the label will be exactly `Playing Codex`.
4. Ask the user for the Application ID. It is a 15-25 digit public identifier, not a secret.
5. Call `configure_discord_app` with `clientId` and `applicationName: "Codex"` unless the user explicitly chose another name.
6. Ask the user to keep the Discord desktop app open and signed in. Then call `get_discord_presence_status`.
7. If connected, call `show_codex_activity` once and report the result. If not connected, explain that Discord must be running and that the plugin runs only in the ChatGPT/Codex desktop app.
8. Never ask for a bot token, password, MFA code, or Discord account credentials. Never send the Application ID anywhere except the local plugin configuration.
