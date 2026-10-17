# Meta setup checklist

**Status: partly walked through.** The maintainer created a Meta app, used Meta's free test number, and set the webhook with `scripts/meta-setup.mjs` on 2026-10-16; one message round trip followed ([STATUS.md](STATUS.md)). The **real-number path** (adding your own number, the SMS/voice code, registration) and **Business Verification** were not walked through by the maintainer. Meta's screens move often: if a screen differs from this page, trust the screen and open a documentation issue (secrets hidden).

**You do all of this yourself.** The Meta developer, Business and WhatsApp accounts are yours; so are Business Verification (with your own legal documents) and the SMS or voice code for your number. Nobody else creates these accounts or sees your code, and the bridge never does either. Do the dashboard clicks on your own device and network, logged in to your own Facebook account. An assistant may explain the steps and wait; it should never ask for your Facebook password or the code.

## 0. Rules for secrets

| Value | Secret? | Rule |
|---|---|---|
| Facebook password, 2FA and checkpoint codes | yes | Type only into Meta |
| Developer-registration and number-verification SMS or voice codes | yes | Type only into Meta |
| Card number and bank codes | yes | Type only into Meta or your bank |
| **App secret** (Part B) | **yes** | Hidden prompt or environment variable; ends up as `WA_APP_SECRET` |
| **System-user token** (Part D) | **yes** | Hidden prompt or environment variable; ends up as `WA_ACCESS_TOKEN`. Never given to the agent |
| Registration PIN (6 digits, real number) | yes | Hidden prompt. Keep it: Meta needs it to change the PIN or delete the number |
| App ID, business portfolio id, WABA id, phone number id, webhook URL | no | Safe to share |
| `WA_VERIFY_TOKEN` | low (a handshake string) | Needed in Meta's webhook form; keep it out of public places |

## 1. Before you start

1. The bridge is deployed ([DEPLOY.md](DEPLOY.md)) in test mode (`LAUNCH_MODE=test`, auto-reply paused). Note the callback URL `https://<worker>.<your-subdomain>.workers.dev/api/webhook`.
2. Choose a path: the **test number** (Meta's free test number, no code to enter, a small list of allowed recipients; proves the plumbing, which is what the maintainer ran) or a **real number** (see Part C-real).

## 2. Part A: developer registration (skip if developers.facebook.com already shows "My Apps")

1. Open developers.facebook.com, click **Get Started**, accept the Meta Platform Terms.
2. Enter your mobile number, request the SMS code, type it into Meta. Then the email code.
3. Pick your role and complete registration. If Meta shows a checkpoint, solve it yourself.

## 3. Part B: create the Business-type app

1. **Create App**, enter an app name and contact email, choose the use case **Connect with customers through WhatsApp**, create or pick a business portfolio.
2. Copy the **App ID** (not secret). In **App settings > Basic** click **Show** beside **App secret** and keep it for the setup step (secret).

## 4. Part C-test: the Meta test number

Meta can create a test WhatsApp Business Account with a free test number and a short allowed-recipient list when the app is created.

1. **WhatsApp > API Setup**. Copy the **Phone number ID** and the **WhatsApp Business Account ID** (not secret).
2. Under **To**, manage the phone number list and add your own WhatsApp number. Meta may send a confirmation code to that WhatsApp; type it into Meta. These numbers become `TEST_RECIPIENTS`.
3. Tokens generated on this page can be short-lived. Check the expiry (the setup script in Part 7 reports it and fails on an expiring token unless you pass `--allow-expiring`); for anything long lived use Part D.

## 5. Part C-real: your own number

- **Bring your own SIM or line.** Use a new local SIM, eSIM or landline number that has **never been registered in the WhatsApp or WhatsApp Business phone app** (a number already on an app must first be removed from it). The Cloud API number cannot also be used in the phone app; coexistence is out of scope.
- **You personally enter the number and then the SMS or voice code** that Meta sends, at the Meta number step. Landlines receive the code by voice call: the line must not sit behind a menu or voicemail.
- No toll-free numbers, short codes, or number-rental and shared-SMS websites. Keep the SIM active; Meta may re-verify later.
- Create or select the WhatsApp Business Account in Business Settings, add a payment method in Meta's billing settings (card details go into Meta only; check Meta's current billing page for when one is required), choose the display name (Meta reviews display names; review can take days).
- **Business Verification** is Meta's identity check for your business. Meta documents it as the usual route to higher messaging limits and some features. You submit your own documents in your own Business Settings; nobody does it for you.

## 6. Part D: the system-user token

1. In Business Settings create a **system user**, add the app and the WhatsApp account as assets, give it `whatsapp_business_management` and `whatsapp_business_messaging`, and generate a token with expiry **Never**.
2. Keep it for the next step only (secret).

## 7. Run the setup

On **your own computer**, from the repository folder, with the token and app secret at hidden prompts:

```bash
node scripts/meta-setup.mjs --waba-id <id> --phone-number-id <id> \
  --webhook-url https://<worker>/api/webhook --verify-token <your verify token>
```

It checks the token's scopes, tests your webhook handshake, sets the app-level callback, subscribes the app to the account and prints a result bundle with non-secret facts. Add `--push-cloudflare` to store the two secrets in a wrangler-managed Worker, or use self-provisioning ([SELF-PROVISIONING.md](SELF-PROVISIONING.md)). `--register` and `--test-to <number>` are the only steps that change the number or send a message, and they ask for confirmation. Details: [META-SETUP.md](META-SETUP.md). Which of these calls have been run against Meta: [META-API-CONFORMANCE.md](META-API-CONFORMANCE.md).

## 8. Round trip before going live

1. In Meta's webhook configuration check the callback URL and verify token, and subscribe to the **messages** field.
2. Send one WhatsApp message from an allowed phone to the number. Confirm it appears in `/admin` as pending.
3. Connect your agent ([WAKE-ROUTINE.md](WAKE-ROUTINE.md)), or drive MCP by hand: `list_pending`, `claim_conversation`, `get_history`, `send_reply`, `finish_conversation`. Activate auto-reply in `/admin` for the test; replies only reach `TEST_RECIPIENTS` while `LAUNCH_MODE=test`.
4. Only then set `LAUNCH_MODE=live` and keep auto-reply active deliberately.

**Who does what.** An assistant you trust can drive the Meta developer-account screens with you (create the app, add the WhatsApp product, copy ids), and it can run `scripts/meta-setup.mjs` steps you approve. **You personally** enter the SMS or voice code that Meta sends to your own SIM or line at the number-verification step, in Meta's own form. The assistant never sees that code and must not ask for it, for your Meta password, or for a two-factor code. You also do Business Verification and accept Meta's terms yourself.

**Calling** needs more (Business Verification, an explicit decision to go, extra configuration) and stays off until you decide: [VOICE-CALLS.md](VOICE-CALLS.md).
