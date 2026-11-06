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
| `NO_PREVIEW` | Link previews are disabled by default in text posts. |\n| `POST_STORE_PATH` | Optional path for the published-post index. Use a mounted persistent disk path on Render, e.g. `/var/data/published-posts.json`. |

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

## Editing published posts

The bot stores message IDs and post content in `published-posts.json` and exposes `/editposts`.
For Render, attach a persistent disk and set `POST_STORE_PATH` to a file on that disk (for example `/var/data/published-posts.json`). Without a persistent disk, the edit list can be lost when Render replaces the service filesystem. The bot can edit text in place and edit captions/media/buttons in place. Telegram does not allow changing a text message into a media message (or vice versa) while retaining the same message ID; that format change must be published as a separate post.

Channel posts sent by the bot are published to the channel itself, so the channel name/photo are the sender identity. If the channel has admin signatures enabled, turn off **Sign Messages** in the channel's settings to avoid showing an individual admin name.
