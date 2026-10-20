# Telegram Inline Post Maker (Render Environment Variables)

## Render deployment

Create a **Web Service** from your GitHub repository.

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

In Render, open **your service → Environment → Add Environment Variable** and add:

| Key | Value |
|---|---|
| `BOT_TOKEN` | Your Telegram bot token from `@BotFather` |
| `CHANNEL_ID` | Channel username such as `@yourchannel`, or numeric channel ID such as `-1001234567890` |
| `ADMIN_IDS` | Your numeric Telegram user ID(s), comma-separated, e.g. `123456789` or `123456789,987654321` |
| `NO_PREVIEW` | `true` or `false` (optional; defaults to `false`) |

Save the variables, then choose **Manual Deploy → Deploy latest commit**. Do not add quotes around values. Do not put the bot token in GitHub, `index.js`, screenshots, or chat messages. If a token has been exposed, revoke it with `@BotFather` and set the replacement in Render.

After deployment, open `https://YOUR-SERVICE.onrender.com/health`. A successful response looks like:
```json
{"ok":true,"service":"telegram-post-maker"}
```

The health endpoint is required for a Render Web Service. It does **not** keep a free service awake; Render Free Web Services may sleep after inactivity, and Telegram polling will not wake a sleeping service until it starts again.

## Telegram setup

- Add the bot as an administrator in your channel with permission to post messages.
- `ADMIN_IDS` must contain the numeric Telegram user ID of each person allowed to use the bot, not their username.
- `CHANNEL_ID` must identify the channel where posts should be published.

## Commands

- `/start` — open the welcome menu
- `/newpost` — start creating a post
- `/skip` — skip an optional caption where supported
- `/cancel` — cancel the current draft
- `/help` — show help

Drafts are held in memory and are lost if the service restarts. The bot uses long polling and therefore should run as a single service instance.
