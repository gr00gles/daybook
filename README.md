# Daybook

A Chrome new tab page that shows the time, the weather (with severe weather alerts), your Google and Outlook calendars with when to leave for each event, unread Gmail and Outlook mail, your deliveries, pages for the companies you deal with, the latest YouTube uploads, stocks, your teams' next games, headlines, a search bar, your most-visited sites and a notes pad.

It is a small Chrome extension. Everything runs in the browser; there is no server.

## Install (for anyone you share it with)

1. Unzip `daybook.zip` and move the `daybook` folder somewhere permanent, such as Documents. Chrome loads the extension from that folder, so don't delete it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `daybook` folder.
4. Open a new tab. If Chrome asks whether to keep the new tab page, choose **Keep it**.
5. Daybook's setup screen walks through three steps:
   - **Connect Google.** Click *Sign in with Google*. Chrome may ask you to sign in to Chrome with your Google account. Google then says *"Google hasn't verified this app"*: click **Advanced**, then **Go to Daybook**, tick the calendar box and click **Continue**. Daybook also finds every Gmail account signed into Chrome; if none is, click *Sign in to Gmail*.
   - **Connect Outlook** (optional). Click *Sign in with Microsoft* and accept. If Microsoft asks *"Stay signed in?"*, choose **Yes**. Work or school accounts often need IT approval first; Daybook gives you a link to send them.
   - **Make it yours.** Name, °F or °C, weather location, headline topics.

You can change all of this later with the gear icon, or rerun setup from Settings → Accounts.

## For the owner: what's set up and how to keep it working

Sign-in works for everyone because this copy carries two app IDs you registered once:

- **Google:** the `oauth2.client_id` in `manifest.json` (Google Cloud project "Daybook", Chrome Extension client, Item ID `flgomcdbgonicihokfkbpopedcilcpdn`).
- **Microsoft:** `MICROSOFT_CLIENT_ID` in `config.js` (Entra app registration "Daybook", SPA redirect `https://flgomcdbgonicihokfkbpopedcilcpdn.chromiumapp.org/`).

Things to know:

- **Never change the `key` in `manifest.json`.** It fixes the extension ID, and both app registrations are tied to that ID.
- **Google Cloud APIs to keep enabled:** Google Calendar API, Gmail API (mark as read/delete) and YouTube Data API v3 (YouTube card). Scopes on the Data Access page: `calendar.readonly`, `calendar.events` (adding events), `userinfo.email`, `userinfo.profile`, `gmail.modify`, `youtube.readonly`.
- **Google publishing status must be "In production"**, not "Testing". In Testing, only listed test users can sign in and everyone has to sign in again every 7 days. Publishing needs the home page and privacy policy at `https://gr00gles.github.io/`.
- **The Google app is unverified, so it can be used by at most 100 different Google accounts, ever.** That's plenty for friends and family. Going past it would require Google's verification review.
- **Keep both registrations alive.** Google deletes OAuth clients nobody has used for 6 months, and Microsoft may delete an unused directory. Using Daybook yourself keeps the Google client active; sign in to entra.microsoft.com every few months.
- **Gmail** is read through Gmail's inbox feed using the browser's own Gmail sign-in, so it needs no permission screen. Google doesn't officially document this feed for personal accounts, so it could change someday.

## Sharing it

Zip the `daybook` folder (or reuse `daybook.zip`) and send it. Each person installs it as above and signs in with their own accounts; nobody sees anyone else's data.

## Troubleshooting

- **"Google hasn't verified this app" with no Advanced link:** the person's Google account is a work or school account whose admin blocks unverified apps. Personal @gmail.com accounts work.
- **Google sign-in does nothing:** Chrome sign-in may be turned off (Chrome settings → You and Google → *Allow Chrome sign-in*), or the window is incognito.
- **Gmail shows nothing:** make sure you're signed in to Gmail in Chrome, and that Daybook's *Site access* in `chrome://extensions` → Details is *On all sites*.
- **Outlook asks to reconnect now and then:** Microsoft limits browser apps to a day at a time and renews quietly using your Microsoft sign-in. If you signed out of Outlook.com or cleared cookies, click *Reconnect Outlook*.

## Using it

- **Unread** mail: click a message to read it right on the page. **Open in Gmail** (or **Outlook**) takes you to the full site, and Ctrl-click or ⌘-click still opens it there directly. Opening a message marks it read, as Gmail does; **Keep unread** undoes that. Pictures from the web stay hidden until you click **Show pictures**, so senders can't tell you opened their email. Whole messages can be read for Outlook and for the Google account connected in Settings; for other signed-in Gmail accounts you see the preview and the Open in Gmail button. The first time, Google asks for permission.
- Hover over a message to **mark it as read** or **delete** it (it goes to Trash or Deleted Items). A bar at the bottom offers **Undo**. The first time, Google or Microsoft asks you to allow it. For Gmail this works on the Google account connected in Settings.
- **YouTube** flips through the latest uploads from the channels you subscribe to, one at a time, every few seconds (hover to hold it still; use the arrows, scroll wheel or arrow keys to flip). Videos from the last 24 hours are tagged **New**. Hover over a video and click the **eye** to mark it as watched and take it out of the stack (Undo is at the bottom); opening a video does the same. YouTube doesn't let apps see your watch history, so this list is Daybook's own, kept on this computer. Click **Show my subscriptions** once to allow it. Shorts are hidden unless you turn that off in Settings → YouTube.
- **Headlines** flip one at a time, every few seconds, for the topic tab you pick (hover to hold one still; use the arrows, scroll wheel or arrow keys to flip).
- Cards with nothing to show, such as an empty inbox, shrink to a single line.
- **Today** lists today's events, with a timeline and Join buttons for video calls, plus the next six days. Under it, the **month calendar** shows every event for the month, with events that last several days drawn as one bar across them; use the arrows to flip months and click a day to see its full schedule.
- **Event details:** click anywhere on an event (in Today, or in a day's schedule under the month calendar) to open its details: the time, calendar, place with Map and Directions links, the forecast and leave-by time, the video call, notes and guests. On a Google calendar you can edit, or your Outlook calendar, **Edit** changes the title, time, place or notes; for a repeating event it changes that one only. A bar at the bottom offers **Undo**. Invitations from someone else, and calendars added by iCal link, can only be read.
- **Add an event** with **+ Add event** on the Today card, **Add event** on a day in the month calendar, or by double-clicking a day. Pick which calendar it goes on: any Google calendar you can edit, or your main Outlook calendar. Google calendars can get a Google Meet link. The Location field suggests addresses as you type (your recent places first, then the nearest matches from Photon, no key needed). The first time, Google or Microsoft asks you to allow adding events. A bar at the bottom offers **Undo**, which deletes the event again. Calendars added by iCal link are read-only.
- **Travel time:** events with an address show the forecast there at that hour and, for the next 24 hours, a **Leave by** time from where you are (drive time plus 5 minutes, which you can change in Settings → Travel time). The **Next** bubble under the clock counts down to leaving. Drive times come from OSRM, which doesn't know about traffic; paste a free TomTom key in Settings → Travel time to use live traffic instead. Video calls, rooms and places more than 250 km away are skipped.
- **Weather alerts** from the US National Weather Service show as a chip above the current conditions and as banners on the Weather card (click one for the full text). Outside the US there are none.
- **Moon and holidays:** the moon's phase sits under the sunrise arc. The next holiday within a month shows under the date, and holidays (plus the days the clocks change) are marked on the month calendar. US holidays are built in; elsewhere they come from Nager.Date for the country your browser's language names. Each holiday has its own look (Halloween is orange with a pumpkin, Christmas wears a Santa hat), and Settings → Holidays picks which ones show; a few more, like Super Bowl Sunday and Election Day, start out off.
- **Deliveries** has its own card above Unread: shipping emails with their latest status and the estimated delivery day. When the email has a UPS, USPS, FedEx, DHL or Amazon tracking number, the link goes to the carrier's tracking page; otherwise it opens the email. Read emails count too for the Google account connected in Settings once you've used **Mark as read** or **Delete** there. For that account, each package shows the product picture from its shipping email; otherwise it shows the store's logo.
- **Site groups** start the shortcuts row, like folders on a bookmarks bar. Hover over a group's icon (the hammer for **Hardware**: Lowe's, Home Depot, Tractor Supply) and its sites pop out as bubbles; click one to go there. **Edit** at the end of the bubbles renames the group, changes its icon and adds or removes sites. Add more groups in Settings → Site groups. Groups sync with your Chrome profile.
- **Companies:** a page for each company you deal with (hover over **Companies** in the shortcuts row, or open it from Settings → Site groups). Keep the phone number, your account number, hours, the people you talk to, notes and links there; **Look up on Wikipedia** adds a short summary. Each page lists the email and deliveries Daybook has seen from that company, matched by its website or email domain. Companies you get email from are suggested under **From your inbox**. Company pages sync with your Chrome profile.
- **Markets** (optional): add a free Finnhub key and your symbols in Settings → Stocks. Quotes refresh every 5 minutes while the US market is open; click a row to open it on Yahoo Finance.
- **Teams** (optional): follow teams in Settings → Teams (NFL, college football, NBA, WNBA, men's college basketball, MLB, NHL or MLS). The Teams card shows each team's next game with the date, time and TV channel, the score while a game is on, the record and the last result, plus recent team news. Their games also show on the Today list and the month calendar with the team's logo; click one for its details and a link to ESPN. Schedules come from ESPN and refresh every few hours, every 15 minutes on game day and every 2 minutes during a game. Games and news can each be turned off in Settings → Teams.
- **Around you** lists concerts, shows, festivals and games near your weather location for the next two weeks, grouped by day with a picture, the venue and the time; click one to open it on Ticketmaster. It needs a free Ticketmaster key: sign up at developer.ticketmaster.com, open **My Apps** and paste the **Consumer Key** in Settings → Area events, where you can also choose how far, how far ahead and which kinds of events. Small local happenings like brewery nights are rarely on Ticketmaster, so the card also has quick **Brewery events**, **Festivals** and **This weekend** searches for your town, which work without a key.
- Chrome puts the cursor in the address bar on a new tab; press `/` to jump to Daybook's search box.
- Pick **Maps** under the search box (or start with `!m`) and type an address: suggestions appear with a map. Nearest places to where you are come first. Use ↑ ↓ to move between them, Enter to open the highlighted one in Google Maps, or click **Directions**. Places you open are kept as **Recent** places (on this computer only): they show when you click into the search box in Maps mode and at the top while you type. Remove one with its **×**, or use **Clear recent places**. Address suggestions come from Photon (OpenStreetMap data); the map is an embedded Google Map.
- **Ask Claude or ChatGPT**: pick **Claude** or **ChatGPT** under the search box (or start with `!c` or `!gpt`). Without an API key the question opens on claude.ai or chatgpt.com, where you're signed in. Add an Anthropic or OpenAI API key in Settings → Claude and ChatGPT and the answer streams into a bubble under the search box instead; type a follow-up to keep the conversation going, press Esc to close it. Ctrl+Enter or ⌘+Enter always opens the site. Keys stay on this computer and API use is billed by Anthropic or OpenAI.
- In the search box, start with `!y` (YouTube), `!m` (Maps), `!c` (Claude), `!gpt` (ChatGPT), `!w` (Wikipedia), `!a` (Amazon) or `!e` (search your Gmail). Ctrl+Enter or ⌘+Enter opens results in a new tab.
- Cards show saved data instantly and refresh in the background: Gmail every minute, Outlook every 2, calendars every 5–10, weather alerts every 5, weather every 15, headlines every 20, stocks every 5 while the market is open. ↻ refreshes everything now. Each feature can be turned off in Settings → Sections.

## Privacy

Daybook never sends email. It changes mail only when you click **Mark as read** or **Delete** (deleted mail goes to Trash or Deleted Items, so it can be recovered), and it changes calendars only to add an event you fill in or save changes you make to one (or put things back when you click Undo). Settings sync through your Chrome profile; sign-ins and cached mail, calendar and weather data stay on your computer. The page talks only to Google, Microsoft, Open-Meteo (weather), BigDataCloud (city name from coordinates), the US National Weather Service (alerts for your weather location), Photon (address suggestions in Maps mode and the event form, and looking up the addresses of upcoming events), the FOSSGIS OSRM server (drive times between your location and those addresses), Google Maps (the map preview), Nager.Date (holidays, outside the US), Google's favicon service (logos for your saved sites, companies and deliveries), Wikipedia (only the company name, when you click Look up), the stores whose product pictures appear on the Deliveries card, ESPN (schedules for the teams you follow), and, only if you add your own keys, TomTom (traffic), Finnhub (stock quotes), Anthropic and OpenAI (questions you ask Claude or ChatGPT on the page), and Ticketmaster (events near your weather location). Full policy: https://gr00gles.github.io/privacy.html

## Updating

**Your own copy (from GitHub):** open GitHub Desktop, choose the `daybook` repository and click **Fetch origin**, then **Pull origin**. The next new tab has the changes. If it shows **Finish update**, click it once and open a new tab.

**Copies you shared as a zip:** send a new zip; the person replaces the files in their `daybook` folder and opens a new tab (clicking **Finish update** if it appears). Sign-ins and settings are kept.
