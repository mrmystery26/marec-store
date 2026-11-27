# Developer rules (version 2026-11)

These are the plain-language rules a developer accepts in the Publisher portal before a developer
account is created. They are the house rules of this project, written to be easy to read. They are
not legal advice: have a lawyer review them (and your privacy policy) before real money or a wide
public launch.

1. You made the game, or you have the right to share every file you upload. Do not upload other
   people's work.
2. Your files must be safe: no viruses, malware or anything that harms a player's computer or data.
3. For now MAREC only accepts free demos. Every demo is reviewed by MAREC before it appears in the
   store.
4. Be honest in the description, the age rating and the system requirements. Players rely on them.
5. MAREC can ask you to make changes, and can suspend or remove a demo that breaks these rules.
6. Your studio name and your demo's details are shown publicly in the store.

**Changing the rules.** The text is in `apps/launcher/src/renderer/js/views-publisher.js` (`RULES`) and
this file. The version is `TERMS_VERSION` in `services/api/app/modules/developer/service.py`. When
you change the rules, change the version. The API refuses a registration that names an old
version, so nobody accepts rules they were not shown. Developers who registered earlier are not asked
again automatically yet.
