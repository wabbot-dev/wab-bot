# Disclaimer (WAB bot)

## Preview software

Version 0.1.0 is a **preview**. It is tested locally against fakes, and earlier revisions were exercised live on a throwaway Cloudflare Free account and on Meta's free test number (a text round trip on 2026-10-16; inbound voice calls answered by Grok Voice from this code on 2026-10-17). It has not been run by this project on a business-owned number, in production, or with a woken agent. The design it comes from is reported by its owner to be proven in production, which is not evidence for this code. [docs/STATUS.md](docs/STATUS.md) lists what is verified, how, and what is not. Review the code and run a test-number round trip before you trust it with customer messages.

## Responsible use

WAB bot is for lawful business messaging with customers who have contacted you or opted in. The project does not support, and will not help with:

- spam, bulk or unsolicited messaging, or evading WhatsApp or Meta rate limits, quality ratings or policies;
- impersonating a person, or denying being an AI when sincerely asked;
- offering a general-purpose AI assistant over the WhatsApp Business API, or using WhatsApp Business message data to train AI models (both restricted by Meta's Business Solution Terms);
- circumventing Meta's identity, verification or number-registration requirements, including number-rental or shared-SMS services;
- reselling or sharing AI or cloud accounts or API access, or creating provider accounts for someone else against the provider's terms.

Requests for help with the uses above will be closed without response in issues and discussions.

## Your responsibility

You are responsible for your deployment, your credentials, your customers' personal data, call-recording and AI-disclosure rules in your jurisdiction, your plan terms with Cloudflare, Meta's platform and commerce policies, and every action you direct an AI agent to take through the MCP tools. The template enforces send guards but cannot make a business compliant. Accounts created for you by an assistant remain yours: you own them and you pay for them.

## No warranty

Provided under the [MIT License](LICENSE), "as is", without warranty of any kind. Measured numbers in the documentation come from specific test runs on specific dates and are not performance guarantees. Quotas, prices and platform behaviour change; check the vendors' current documentation. The Cloudflare Free plan has no service-level agreement.

## Third parties

Meta, WhatsApp, Cloudflare, xAI and other names belong to their owners. This project is independent: it is **not affiliated with or endorsed by Meta or xAI**. WhatsApp and Grok are trademarks of their owners; the names are used only to say which services this template works with, and the project does not use them as its own name. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
