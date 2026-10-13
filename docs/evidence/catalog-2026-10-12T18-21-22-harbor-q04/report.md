# Catalog qualification catalog-2026-10-12T18-21-22-harbor-q04

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| bazarr | pass | healthy after 64s; page title "General - Bazarr (Settings)"; health 200; removed after the check; volumes and folders retained |
| bazarr (external storage) | pass | healthy after 46s; page title "General - Bazarr (Settings)"; health 200; external storage: --storage downloads=/mnt/harbor-test-storage/bazarr-downloads-q1821 mounted as bind; removed after the check; volumes and folders retained |
| budibase | pass | healthy after 191s; page title "Budibase"; health 301; removed after the check; volumes and folders retained |
| docmost | pass | healthy after 144s; page title "Setup Workspace - Docmost"; health 200; removed after the check; volumes and folders retained |
| fizzy | pass | healthy after 45s; page title "Enter your email / Fizzy"; health 302; removed after the check; volumes and folders retained |
| kokoro | fail | harbor install kokoro --name kokoro-q1821 --yes exited 1:        "at": "2026-10-12T18:34:31Z",
      "phase": "checking",
      "message": "readiness attempt 70: 404"
    },
    {
      "cursor": "129",
      "at": "2026-10-12T18:34:51Z",
      "phase": "checking",
      "message": "readiness attempt 80: 404"
    },
    {
      "cursor": "130",
      "at": "2026-10-12T18:35:11Z",
      "phase": "checking",
      "message": "readiness attempt 90: 404"
    },
    {
      "cursor": "131",
      "at": "2026-10-12T18:35:31Z",
      "phase": "checking",
      "message": "readiness attempt 100: 404"
    },
    {
      "cursor": "132",
      "at": "2026-10-12T18:35:51Z",
      "phase": "checking",
      "message": "readiness attempt 110: 404"
    },
    {
      "cursor": "133",
      "at": "2026-10-12T18:36:11Z",
      "phase": "checking",
      "message": "readiness attempt 120: 404"
    },
    {
      "cursor": "134",
      "at": "2026-10-12T18:36:31Z",
      "phase": "checking",
      "message": "readiness attempt 130: 404"
    },
    {
      "cursor": "135",
      "at": "2026-10-12T18:36:51Z",
      "phase": "checking",
      "message": "readiness attempt 140: 404"
    },
    {
      "cursor": "136",
      "at": "2026-10-12T18:37:11Z",
      "phase": "checking",
      "message": "readiness attempt 150: 404"
    },
    {
      "cursor": "137",
      "at": "2026-10-12T18:37:11Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 404); containers were kept for inspection"
    }
  ]
}
 |
| ollama | pass | healthy after 146s; page title ""; health 200; removed after the check; volumes and folders retained |
| rotki | pass | healthy after 46s; page title "rotki"; health 200; removed after the check; volumes and folders retained |
| telegrapho | pass | healthy after 40s; page title "Telegrapho"; health 200; removed after the check; volumes and folders retained |
| yuvomi | pass | healthy after 54s; page title "Yuvomi"; health 200; removed after the check; volumes and folders retained |
