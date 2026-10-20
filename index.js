const TelegramBot = require("node-telegram-bot-api");
const http = require("http");

// Render Dashboard -> Service -> Environment: set these variables there.
// Never put your real bot token in source code or commit it to GitHub.
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_ID;
const ADMINS = new Set((process.env.ADMIN_IDS || "").split(",").map(v => v.trim()).filter(Boolean));
const NO_PREVIEW = /^(1|true|yes)$/i.test(process.env.NO_PREVIEW || "false");

if (!TOKEN || !CHANNEL || ADMINS.size === 0) {
  console.error("Configuration error: set BOT_TOKEN, CHANNEL_ID, and ADMIN_IDS in Render Environment.");
  process.exit(1);
}

// Render Free Web Service needs an HTTP port. This endpoint is for health checks;
// it does not keep a free service awake or make Telegram polling wake it from sleep.
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, service: "telegram-post-maker" }));
  }
  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});
server.listen(Number(process.env.PORT) || 10000, "0.0.0.0", () => {
  console.log(`HTTP health server listening on port ${Number(process.env.PORT) || 10000}`);
});
const bot = new TelegramBot(TOKEN, { polling: true });
const drafts = new Map();
const MAX_BUTTONS = 40, MAX_ROWS = 8, MAX_PER_ROW = 8;
const allowed = id => ADMINS.has(String(id));
const fresh = () => ({phase:"idle",type:"text",fileId:null,caption:"",buttons:[],active:null,editIndex:null,wizardId:null,userIds:[]});
const get = id => { if (!drafts.has(String(id))) drafts.set(String(id),fresh()); return drafts.get(String(id)); };
const reset = id => drafts.set(String(id),fresh());

async function delMsg(chat,id) { try { await bot.deleteMessage(chat,id); } catch (_) {} }
async function clearReplies(chat,d) {
  const ids=[...new Set(d.userIds)]; d.userIds=[];
  for (const id of ids) await delMsg(chat,id);
}
function styleKeyboard(markup) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  markup.inline_keyboard = markup.inline_keyboard.map(row => row.map(button => {
    const action = String(button.callback_data || "").toLowerCase();
    const label = String(button.text || "").toLowerCase();
    let style = "primary";
    if (action.includes("cancel") || action.includes("delete") || label.includes("cancel") || label.includes("delete")) style = "danger";
    else if (action === "publish" || label.includes("publish") || label.includes("confirm")) style = "success";
    return { ...button, style };
  }));
  return markup;
}
async function wizard(chat,d,text,markup=baseKeys()) {
  markup = styleKeyboard(markup);
  // On the first step there is no wizard message to edit yet.
  if (!d.wizardId) {
    const m = await bot.sendMessage(chat, text, { reply_markup: markup });
    d.wizardId = m.message_id;
    return;
  }
  const opts = { chat_id: chat, message_id: d.wizardId, reply_markup: markup };
  try {
    await bot.editMessageText(text, opts);
  } catch (e) {
    const message = String(e.message || "").toLowerCase();
    if (message.includes("message is not modified")) return;
    // If the wizard message was deleted or can no longer be edited, recreate it.
    const m = await bot.sendMessage(chat, text, { reply_markup: markup });
    d.wizardId = m.message_id;
  }
}
async function beginWizard(chat,d,text,markup=baseKeys()) {
  markup = styleKeyboard(markup);
  const m=await bot.sendMessage(chat,text,{reply_markup:markup}); d.wizardId=m.message_id;
}
function baseKeys(){return {inline_keyboard:[[{text:"Cancel",callback_data:"cancel"}]]};}
function mediaKeys(){return {inline_keyboard:[[{text:"Skip attachment",callback_data:"skip_media"},{text:"Cancel",callback_data:"cancel"}]]};}
function captionKeys(){return {inline_keyboard:[[{text:"Skip caption",callback_data:"skip_caption"},{text:"Cancel",callback_data:"cancel"}]]};}
function validUrl(s){try{const u=new URL(s);return u.protocol==="https:"||u.protocol==="http:";}catch(_){return false;}}
function grouped(buttons){
  const m=new Map();
  for(const b of buttons){if(!m.has(b.row))m.set(b.row,[]);m.get(b.row).push({text:b.text,url:b.url,style:"primary"});}
  return [...m.keys()].sort((a,b)=>a-b).map(k=>m.get(k));
}
function listButtons(d){return d.buttons.length?d.buttons.map((b,i)=>`${i+1}. [Row ${b.row}] ${b.text}\n   ${b.url}`).join("\n"):"(No buttons added yet)";}
function editKeys(d){
  const rows=[
    [{text:"Edit media",callback_data:"edit_media"},{text:"Edit caption/text",callback_data:"edit_caption"}],
    [{text:"Add button",callback_data:"add_button"}]
  ];
  d.buttons.forEach((b,i)=>rows.push([{text:`Edit ${i+1}: ${b.text}`.slice(0,60),callback_data:`edit_button:${i}`},{text:"Delete",callback_data:`delete_button:${i}`}]));
  rows.push([{text:"Back to preview",callback_data:"preview"}],[{text:"Delete draft",callback_data:"delete_draft"},{text:"Cancel",callback_data:"cancel"}]);
  return {inline_keyboard:rows};
}
async function askMedia(chat,d,editing=false){
  d.phase="media";
  await wizard(chat,d,editing?
    "EDIT MEDIA\n\nSend a new photo, video, or text-only post. This replaces the current media and removes the current buttons.":
    "STEP 1 — MEDIA OR TEXT\n\nSend a photo or video, with an optional caption. You can also send a text-only post.");
}
async function askCaption(chat,d){d.phase="caption";await wizard(chat,d,"STEP 2 — CAPTION\n\nSend caption text, or use /skip to leave it empty.");}
async function askButtonText(chat,d){
  if(d.buttons.length>=MAX_BUTTONS)return preview(chat,d);
  d.phase="button_text";d.active={text:"",url:"",row:1};
  await wizard(chat,d,`STEP 3 — BUTTON TEXT\n\nSend the text for button ${d.buttons.length+1}.`);
}
async function askUrl(chat,d){d.phase="button_url";await wizard(chat,d,`STEP 4 — BUTTON URL\n\nButton: ${d.active.text}\n\nSend an http:// or https:// URL.`);}
async function askRow(chat,d){
  d.phase="row";const previous=d.buttons.length?d.buttons[d.buttons.length-1].row:1;
  const rows=[[{text:`Use row ${previous}`,callback_data:`setrow:${previous}`}]];
  if(previous<MAX_ROWS)rows.push([{text:`Create row ${previous+1}`,callback_data:`setrow:${previous+1}`}]);
  if(previous!==1)rows.push([{text:"Use row 1",callback_data:"setrow:1"}]);
  rows.push([{text:"Cancel",callback_data:"cancel"}]);
  await wizard(chat,d,"STEP 5 — BUTTON ROW\n\nChoose a row. Buttons in the same row appear side by side.",{inline_keyboard:rows});
}
async function askMore(chat,d){
  d.phase="more";
  await wizard(chat,d,`BUTTON SAVED\n\n${d.buttons.length} button(s) added. Add another button or preview the post.`,{inline_keyboard:[
    [{text:"Add another button",callback_data:"add_button"}],
    [{text:"Preview post",callback_data:"preview"}],
    [{text:"Manage buttons",callback_data:"edit_menu"}],
    [{text:"Cancel",callback_data:"cancel"}]
  ]});
}
async function preview(chat,d){
  d.phase="preview";
  const type=d.type==="photo"?"Photo":d.type==="video"?"Video":"Text";
  const text=`POST PREVIEW\n\nType: ${type}\n\nCaption / text:\n${d.caption||"(Empty)"}\n\nButtons:\n${listButtons(d)}\n\nConfirm to publish or edit any part.`;
  const rows=grouped(d.buttons);
  rows.push([{text:"CONFIRM & PUBLISH",callback_data:"publish"}]);
  rows.push([{text:"Edit post / buttons",callback_data:"edit_menu"},{text:"Add button",callback_data:"add_button"}]);
  rows.push([{text:"Cancel",callback_data:"cancel"}]);
  await wizard(chat,d,text,{inline_keyboard:rows});
}
async function publish(chat,uid,qid){
  const d=get(uid);
  if(d.type==="text"&&!d.caption.trim())return bot.answerCallbackQuery(qid,{text:"Post text cannot be empty.",show_alert:true});
  await bot.answerCallbackQuery(qid,{text:"Publishing..."});
  const markup=d.buttons.length?{inline_keyboard:grouped(d.buttons)}:undefined;
  let sent;
  if(d.type==="photo")sent=await bot.sendPhoto(CHANNEL,d.fileId,{caption:d.caption||undefined,reply_markup:markup});
  else if(d.type==="video")sent=await bot.sendVideo(CHANNEL,d.fileId,{caption:d.caption||undefined,reply_markup:markup});
  else if(d.type==="document")sent=await bot.sendDocument(CHANNEL,d.fileId,{caption:d.caption||undefined,reply_markup:markup});
  else if(d.type==="audio")sent=await bot.sendAudio(CHANNEL,d.fileId,{caption:d.caption||undefined,reply_markup:markup});
  else if(d.type==="animation")sent=await bot.sendAnimation(CHANNEL,d.fileId,{caption:d.caption||undefined,reply_markup:markup});
  else sent=await bot.sendMessage(CHANNEL,d.caption,{reply_markup:markup,disable_web_page_preview:NO_PREVIEW});
  await clearReplies(chat,d);const id=d.wizardId;reset(uid);
  try{await bot.editMessageText(`PUBLISHED SUCCESSFULLY\n\nChannel message ID: ${sent.message_id}\n\nSend /newpost to create another post.`,{chat_id:chat,message_id:id,reply_markup:{inline_keyboard:[[{text:"Create new post",callback_data:"new_post",style:"primary"}]]}});}
  catch(_){await bot.sendMessage(chat,`Published successfully. Message ID: ${sent.message_id}`);}
}

bot.onText(/^\/start(?:@\w+)?$/,async m=>{
  if(m.chat.type!=="private")return;
  if(!allowed(m.from.id))return bot.sendMessage(m.chat.id,"Access denied. Ask the owner to add your numeric Telegram user ID to ADMIN_IDS.");
  await bot.sendMessage(m.chat.id,
    "✨ Welcome to Post Maker!\n\nTurn your ideas into beautiful Telegram channel posts with media, text, and custom URL buttons. Preview everything before publishing.\n\nReady to create something? Tap below to get started.",
    { reply_markup: { inline_keyboard: [[{text:"✍️ Create New Post", callback_data:"new_post", style:"primary"}]] } });
});
bot.onText(/^\/help(?:@\w+)?$/,async m=>{
  if(!allowed(m.from.id))return;
  await bot.sendMessage(m.chat.id,`HELP — TELEGRAM INLINE POST MAKER

COMMANDS
/newpost — start a post
/skip — skip an empty media caption
/cancel — cancel the current draft
/help — show this guide

WORKFLOW
1. Send /newpost.
2. Send a photo/video with an optional caption, or send text for a text-only post.
3. If media has no caption, send a caption or /skip.
4. Enter button text, then its http(s) URL.
5. Choose the button row.
6. Add more buttons or open Preview.
7. Confirm & Publish.

EDIT / DELETE
Use Edit post / buttons to change media, caption/text, or each button's text and URL. Delete individual buttons or delete the whole draft.

MESSAGE CLEANUP
The bot edits one main wizard message as steps advance. After processing your reply, it attempts to delete your reply. Telegram may reject deletion in some cases, so cleanup is best-effort.

SETUP
Set BOT_TOKEN from @BotFather, CHANNEL_ID to your channel username or private numeric ID, and ADMIN_IDS to your numeric Telegram user ID. Add the bot as channel admin with Post Messages permission. Keep .env private. Drafts are in memory and disappear on restart. Run one polling instance per token.`);
});
bot.onText(/^\/newpost(?:@\w+)?$/,async m=>{
  if(m.chat.type!=="private"||!allowed(m.from.id))return;
  reset(m.from.id);await askMedia(m.chat.id,get(m.from.id));
});
bot.onText(/^\/cancel(?:@\w+)?$/,async m=>{
  if(m.chat.type!=="private"||!allowed(m.from.id))return;
  const d=get(m.from.id);await clearReplies(m.chat.id,d);const id=d.wizardId;reset(m.from.id);
  if(id){try{await bot.editMessageText("Draft cancelled. Send /newpost to start again.",{chat_id:m.chat.id,message_id:id,reply_markup:{inline_keyboard:[[{text:"Create new post",callback_data:"new_post",style:"primary"}]]}});}catch(_){await bot.sendMessage(m.chat.id,"Draft cancelled. Send /newpost to start again.");}}
  else await bot.sendMessage(m.chat.id,"Draft cancelled. Send /newpost to start again.");
});
bot.onText(/^\/skip(?:@\w+)?$/,async m=>{
  if(m.chat.type!=="private"||!allowed(m.from.id))return;
  const d=get(m.from.id);if(d.phase!=="caption")return;
  await clearReplies(m.chat.id,d);d.caption="";await askButtonText(m.chat.id,d);
});

bot.on("message",async m=>{
  if(!m.from||m.chat.type!=="private"||!allowed(m.from.id))return;
  const d=get(m.from.id),chat=m.chat.id,uid=m.from.id,text=typeof m.text==="string"?m.text:null;
  if(text&&text.startsWith("/"))return;
  if(m.message_id)d.userIds.push(m.message_id);
  console.log("Incoming post input:", { userId: uid, phase: d.phase, hasText: Boolean(text), hasPhoto: Boolean(m.photo), hasVideo: Boolean(m.video) });
  try{
    if(d.phase==="media"){
      if(m.photo){d.type="photo";d.fileId=m.photo[m.photo.length-1].file_id;d.caption=m.caption||"";await clearReplies(chat,d);return d.caption?askButtonText(chat,d):askCaption(chat,d);}
      if(m.video){d.type="video";d.fileId=m.video.file_id;d.caption=m.caption||"";await clearReplies(chat,d);return d.caption?askButtonText(chat,d):askCaption(chat,d);}
      if(m.document){d.type="document";d.fileId=m.document.file_id;d.fileName=m.document.file_name||"attachment";d.caption=m.caption||"";await clearReplies(chat,d);return d.caption?askButtonText(chat,d):askCaption(chat,d);}
      if(m.audio){d.type="audio";d.fileId=m.audio.file_id;d.caption=m.caption||"";await clearReplies(chat,d);return d.caption?askButtonText(chat,d):askCaption(chat,d);}
      if(m.animation){d.type="animation";d.fileId=m.animation.file_id;d.caption=m.caption||"";await clearReplies(chat,d);return d.caption?askButtonText(chat,d):askCaption(chat,d);}
      if(text&&text.trim()){d.type="text";d.caption=text.trim();await clearReplies(chat,d);return askButtonText(chat,d);}
      await clearReplies(chat,d);return wizard(chat,d,"STEP 1 — MEDIA OR TEXT\n\nSend a photo, video, or text-only post.");
    }
    if(d.phase==="caption"){
      if(!text||text.length>1024){await clearReplies(chat,d);return wizard(chat,d,"STEP 2 — CAPTION\n\nSend caption text up to 1024 characters, or use /skip.");}
      d.caption=text;await clearReplies(chat,d);return askButtonText(chat,d);
    }
    if(d.phase==="button_text"){
      if(!text||!text.trim()||text.trim().length>64){await clearReplies(chat,d);return wizard(chat,d,"STEP 3 — BUTTON TEXT\n\nButton text must be 1–64 characters. Try again.");}
      d.active.text=text.trim();await clearReplies(chat,d);return askUrl(chat,d);
    }
    if(d.phase==="button_url"){
      if(!text||!validUrl(text.trim())){await clearReplies(chat,d);return wizard(chat,d,`STEP 4 — BUTTON URL\n\nButton: ${d.active.text}\n\nSend a valid http(s) URL.`);}
      d.active.url=text.trim();await clearReplies(chat,d);return askRow(chat,d);
    }
    if(d.phase==="edit_caption"){
      const limit=d.type==="text"?4096:1024;
      if(!text||text.length>limit){await clearReplies(chat,d);return wizard(chat,d,`EDIT CAPTION / TEXT\n\nSend text up to ${limit} characters.`);}
      d.caption=text;await clearReplies(chat,d);return preview(chat,d);
    }
    if(d.phase==="edit_button_text"){
      if(!text||!text.trim()||text.trim().length>64||!d.buttons[d.editIndex]){await clearReplies(chat,d);return wizard(chat,d,"EDIT BUTTON TEXT\n\nSend text between 1 and 64 characters.");}
      d.buttons[d.editIndex].text=text.trim();d.editIndex=null;await clearReplies(chat,d);return preview(chat,d);
    }
    if(d.phase==="edit_button_url"){
      if(!text||!validUrl(text.trim())||!d.buttons[d.editIndex]){await clearReplies(chat,d);return wizard(chat,d,"EDIT BUTTON URL\n\nSend a valid http(s) URL.");}
      d.buttons[d.editIndex].url=text.trim();d.editIndex=null;await clearReplies(chat,d);return preview(chat,d);
    }
  }catch(e){console.error("Message handler:",e.message);await clearReplies(chat,d);await wizard(chat,d,"An error occurred. Check the terminal log or use /cancel.");}
});

bot.on("callback_query",async q=>{
  const uid=q.from.id,chat=q.message&&q.message.chat.id,data=q.data||"";
  if(!allowed(uid)||!chat||q.message.chat.type!=="private")return bot.answerCallbackQuery(q.id,{text:"Access denied.",show_alert:true});
  const d=get(uid);
  try{
    if(data==="new_post"){await bot.answerCallbackQuery(q.id);reset(uid);return askMedia(chat,get(uid));}
    if(data==="skip_media"){if(d.phase!=="media")return bot.answerCallbackQuery(q.id,{text:"This step is no longer active."});await bot.answerCallbackQuery(q.id);d.type="text";d.fileId=null;d.caption="";return askCaption(chat,d);}
    if(data==="skip_caption"){if(d.phase!=="caption")return bot.answerCallbackQuery(q.id,{text:"This step is no longer active."});await bot.answerCallbackQuery(q.id);await clearReplies(chat,d);d.caption="";return askButtonText(chat,d);}
    if(data==="edit_menu"){await bot.answerCallbackQuery(q.id);return wizard(chat,d,`EDIT MENU\n\nChoose what to edit or delete.\n\nButtons:\n${listButtons(d)}`,editKeys(d));}
    if(data==="edit_media"){await bot.answerCallbackQuery(q.id);d.buttons=[];d.caption="";d.fileId=null;d.type="text";return askMedia(chat,d,true);}
    if(data==="edit_caption"){await bot.answerCallbackQuery(q.id);d.phase="edit_caption";return wizard(chat,d,`EDIT CAPTION / TEXT\n\nCurrent:\n${d.caption||"(Empty)"}\n\nSend replacement text.`);}
    if(data==="add_button"){await bot.answerCallbackQuery(q.id);return askButtonText(chat,d);}
    if(data==="preview"){await bot.answerCallbackQuery(q.id);return preview(chat,d);}
    if(data.startsWith("edit_button:")){
      const i=Number(data.split(":")[1]);if(!d.buttons[i])return bot.answerCallbackQuery(q.id,{text:"Button not found.",show_alert:true});
      await bot.answerCallbackQuery(q.id);return wizard(chat,d,`EDIT BUTTON ${i+1}\n\n${d.buttons[i].text}\n${d.buttons[i].url}`,{inline_keyboard:[
        [{text:"Edit text",callback_data:`edit_text:${i}`},{text:"Edit URL",callback_data:`edit_url:${i}`}],
        [{text:"Delete button",callback_data:`delete_button:${i}`}],[{text:"Back",callback_data:"edit_menu"}]
      ]});
    }
    if(data.startsWith("edit_text:")){const i=Number(data.split(":")[1]);if(!d.buttons[i])return bot.answerCallbackQuery(q.id,{text:"Button not found."});d.editIndex=i;d.phase="edit_button_text";await bot.answerCallbackQuery(q.id);return wizard(chat,d,"EDIT BUTTON TEXT\n\nSend the replacement text.");}
    if(data.startsWith("edit_url:")){const i=Number(data.split(":")[1]);if(!d.buttons[i])return bot.answerCallbackQuery(q.id,{text:"Button not found."});d.editIndex=i;d.phase="edit_button_url";await bot.answerCallbackQuery(q.id);return wizard(chat,d,"EDIT BUTTON URL\n\nSend the replacement URL.");}
    if(data.startsWith("delete_button:")){
      const i=Number(data.split(":")[1]);if(!d.buttons[i])return bot.answerCallbackQuery(q.id,{text:"Button not found."});
      d.buttons.splice(i,1);await bot.answerCallbackQuery(q.id,{text:"Button deleted."});return preview(chat,d);
    }
    if(data.startsWith("setrow:")){
      const row=Number(data.split(":")[1]);
      if(!d.active||!d.active.url||row<1||row>MAX_ROWS)return bot.answerCallbackQuery(q.id,{text:"Complete button text and URL first.",show_alert:true});
      if(d.buttons.filter(b=>b.row===row).length>=MAX_PER_ROW)return bot.answerCallbackQuery(q.id,{text:"This row is full.",show_alert:true});
      d.active.row=row;d.buttons.push(d.active);d.active=null;await bot.answerCallbackQuery(q.id);return askMore(chat,d);
    }
    if(data==="delete_draft"||data==="cancel"){
      const id=d.wizardId;await clearReplies(chat,d);reset(uid);await bot.answerCallbackQuery(q.id,{text:data==="cancel"?"Cancelled":"Draft deleted."});
      try{return await bot.editMessageText(data==="cancel"?"Draft cancelled. Send /newpost to start again.":"Draft deleted. Send /newpost to start again.",{chat_id:chat,message_id:id,reply_markup:{inline_keyboard:[[{text:"Create new post",callback_data:"new_post",style:"primary"}]]}});}
      catch(_){return bot.sendMessage(chat,"Draft cleared. Send /newpost to start again.");}
    }
    if(data==="publish")return publish(chat,uid,q.id);
    return bot.answerCallbackQuery(q.id,{text:"Unknown action."});
  }catch(e){console.error("Callback error:",e.message);try{await bot.answerCallbackQuery(q.id,{text:"Action failed. Check bot logs and channel permissions.",show_alert:true});}catch(_){}}
});
bot.on("polling_error",e=>console.error("Telegram polling error:",e.message));
console.log("Telegram Inline Post Maker is running.");