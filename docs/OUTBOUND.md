# Rich replies: documents, images, buttons, lists, rich templates

The agent can send more than plain text with `send_reply` and `start_conversation`. Every normal guard still applies first: the
24-hour window, test-mode recipients, the template allowlist, opt-out, takeover, rate limits and idempotency. Code:
[lib/outbound.ts](../lib/outbound.ts).

## One extra part per message

Add **one** of these next to `text`:

| Part | What the customer sees | Limits (Meta) |
| --- | --- | --- |
| `media: {type: "document", url \| id, filename?}` | A file (PDF price list, menu, invoice); `text` becomes the caption | caption 1024 characters |
| `media: {type: "image", url \| id}` | A photo with an optional caption | caption 1024 characters |
| `buttons: [{id, title}]` | Up to 3 quick-reply buttons under the text | title 20 characters |
| `list: {button, sections: [{title?, rows: [{id, title, description?}]}]}` | A menu that opens from a button | button 20, row title 24, description 72; 10 rows in total; section titles needed when there are several sections |

When the customer taps a button or a row, it comes back as a normal customer message whose text is the title (so the agent reads it
like any other answer). Buttons and lists need text, and they are sent only inside the 24-hour window.

Media by **URL**: https only; no IP addresses, `localhost` or internal names; no user:password in the link. Meta downloads the file
itself, so the link must be public. Set `OUTBOUND_MEDIA_HOSTS=files.example.com,cdn.example.com` to allow only your own hosts
(subdomains included); this stops a tricked agent from sending an outside link as an attachment. Media by **id**: a Meta media id
you uploaded earlier (digits).

## Templates with a header and buttons

For an approved template whose header or buttons take a value:

- `template_header`: `{type: "text", text}` (60 characters), or `{type: "image" | "document", url | id, filename?}`.
- `template_buttons`: `[{index, sub_type: "quick_reply" | "url", param}]`: `index` is the button's position (0-based); for `url` the
  param is the variable end of the link; for `quick_reply` it is the payload.
- `template_params` still fills the body.

Templates outside the allowlist are refused before any Meta call, as before.

## What history shows

The stored outbound message keeps it readable for staff and the agent: `[document prices.pdf] Here is our price list`,
`Delivery or pickup?` then `[buttons: Delivery | Pickup]`, `[template order_ready with image]`. The send record kind is `media` or
`interactive`. Voice-note replies are never used for a rich message.

## Errors (nothing is sent)

`media_url_not_allowed`, `media_type_unsupported`, `media_give_url_or_id`, `media_id_invalid`, `media_filename_invalid`,
`caption_too_long`, `give_one_of_media_buttons_list`, `interactive_needs_text`, `interactive_text_too_long`, `buttons_one_to_three`,
`buttons_invalid_id_or_title_max_20`, `list_*`, `template_use_template_header_and_template_buttons`,
`template_parts_need_template_name`, `template_header_*`, `template_buttons_invalid`.

Evidence: `tests/outbound.test.ts` (exact Meta payloads checked against the Cloud API message formats). Not sent to a real phone.
