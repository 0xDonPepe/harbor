# Live VM run vm-2026-10-13T04-44-26

- Target: digitalocean droplet 605947960 ({"kind":"digitalocean","dropletId":605947960,"size":"s-4vcpu-8gb","image":"ubuntu-24-04-x64","region":"sfo3"})
- Archive: harbor-0.31.0-linux-x64.tar.gz
- Fresh VM: false · reboot test: true
- Versions: {}
- Started 2026-10-13T04:44:26.653Z, finished 2026-10-13T04:46:45.971Z

| ID | Test | Result | Evidence notes |
|---|---|---|---|
| B04 | Public exposure of n8n as primary: HTTPS via Let's Encrypt, owner login and workflow through the public URL | **PASS** | n8n published at https://harbor-n8n-mv675izi.apein.space/ (active); certificate: issuer=C = US, O = Let's Encrypt, CN = YE2<br>primary switched to public: N8N_EDITOR_BASE_URL: "https://harbor-n8n-mv675izi.apein.space/" \|       WEBHOOK_URL: "https://harbor-n8n-mv675izi.apein.space/"<br>owner login + credentialed workflow through the public URL: success |
| B05 | Public exposure of BentoPDF with basic protection: 401 without credentials, merge works with them | **PASS** | https://harbor-pdf-mv6766kj.apein.space/: 401 without credentials, 200 with; merge in the browser produced a 2-page PDF<br>credentials appeared once in the operation result and not in later DTOs |
| B10 | Negative: invalid hostname, duplicate hostname → clear errors, no partial config; a second name for the same app is a second route (decision 127) | **PASS** | invalid hostname -> INVALID_REQUEST; duplicate hostname -> NAME_CONFLICT; a second public name for the same endpoint -> its own route (decision 127); both withdrawn again |
| B09 | Reconfigure primary back to loopback; n8n works locally again; unexpose withdraws routes | **FAIL** | reconfigure/unexpose wrong: N8N_EDITOR_BASE_URL: "http://harbor-test.local:18086/" success routes 2->0 |

Files in this directory: report.json (full details), bootstrap logs, screenshots, exported PNG/PDF fixtures.
