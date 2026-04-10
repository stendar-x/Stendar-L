# Feature Request Data Policy

When a user submits a feature request, the system stores:

- `title`
- `description`
- `category`
- moderation metadata (`status`, `moderation_notes`, timestamps)

The system does **not** store for feature requests:

- wallet address
- contact email
- IP-derived user identity fields in the feature request table

This policy aligns with the public schema in `schema.sql`.

## Support Messages and Bug Reports

Support messages and bug reports are transmitted via email notifications only.

The platform database does **not** persist support message or bug report payloads, including:

- name
- email
- wallet address
- message/description content
