# Moving a number off the WhatsApp Business app

Many businesses already answer customers from the **WhatsApp Business app** on a phone. The bridge uses the **WhatsApp Cloud API**,
so the number has to be connected to the Cloud API. There are two ways. Neither is reversible in a few clicks, so read both first.

## Option A: coexistence (keep the app, add the API)

Meta lets a number that is active in the WhatsApp Business app also connect to the Cloud API ("coexistence"): 1:1 chats appear in
both, so staff can keep answering from the phone. Points to know (from Meta partner documentation, October 2026; check Meta's
current page before you start):

- It runs only through a **Meta Tech Provider / Solution Partner's Embedded Signup**. A self-made Meta app (the path in
  [META-SETUP.md](META-SETUP.md)) cannot switch it on by itself.
- Business app version 2.24.17 or later, a number with real recent activity, no other partner still attached.
- Meta creates a WhatsApp Business Account with that single number; throughput is capped at 20 messages per second.
- Changes in the app: companion devices are unlinked (relink them), disappearing and view-once messages are turned off, broadcast lists
  become read-only, group chats are not synced, calls and app tools (catalog, labels, quick replies) stay app-only.
- Keep the app open at least every 13 days; uninstalling it disconnects the number.
- Messages staff send from the phone reach the API as "echo" webhooks. **This bridge does not process those echoes**: the agent
  will not see replies typed on the phone. Use takeover in `/admin` (or pause auto-reply) while staff answer from the phone.

Not tested with this bridge.

## Option B: move the number to the Cloud API only

1. Back up what you need: export important chats (the app's chat history does not move to the API).
2. In the WhatsApp Business app: **Settings → Account → Delete my account**. This releases the number. It can take a few minutes
   before Meta accepts it elsewhere.
3. In your Meta app: **WhatsApp → API Setup → Add phone number**. Enter the display name and category, receive the code by SMS or a
   voice call on that number, and confirm. Set a 6-digit two-step PIN when asked (keep it; Meta asks for it on re-registration).
4. Run the bridge setup for this number ([META-SETUP.md](META-SETUP.md)); it stores the number's id in `WA_PHONE_NUMBER_IDS`.
5. Re-enter the business profile (about text, address, hours, photo) in WhatsApp Manager; it does not move with the number.
6. Start in `LAUNCH_MODE=test` with your own phone in `TEST_RECIPIENTS`, then go live.

After this the number can no longer be used in the WhatsApp Business app (until it is removed from the API again).

## Which to choose

- Staff want to keep answering from the phone → Option A, through a provider that offers coexistence.
- A clean start, everything through the bot and `/admin` → Option B.
- Unsure → test with a **new** number first (Meta's test number, or a spare SIM), then move the real number.
