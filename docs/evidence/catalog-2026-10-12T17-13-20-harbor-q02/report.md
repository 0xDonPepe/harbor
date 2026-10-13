# Catalog qualification catalog-2026-10-12T17-13-20-harbor-q02

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| budibase | pass | healthy after 232s; page title "Budibase"; health 301; removed after the check; volumes and folders retained |
| fizzy | pass | healthy after 48s; page title "Enter your email / Fizzy"; health 302; removed after the check; volumes and folders retained |
| kokoro | fail | harbor install kokoro --name kokoro-q1713 --yes exited 1:  ": "57",
      "at": "2026-10-12T17:22:57Z",
      "phase": "checking",
      "message": "readiness attempt 70: 404"
    },
    {
      "cursor": "58",
      "at": "2026-10-12T17:23:17Z",
      "phase": "checking",
      "message": "readiness attempt 80: 404"
    },
    {
      "cursor": "59",
      "at": "2026-10-12T17:23:37Z",
      "phase": "checking",
      "message": "readiness attempt 90: 404"
    },
    {
      "cursor": "60",
      "at": "2026-10-12T17:23:57Z",
      "phase": "checking",
      "message": "readiness attempt 100: 404"
    },
    {
      "cursor": "61",
      "at": "2026-10-12T17:24:17Z",
      "phase": "checking",
      "message": "readiness attempt 110: 404"
    },
    {
      "cursor": "62",
      "at": "2026-10-12T17:24:37Z",
      "phase": "checking",
      "message": "readiness attempt 120: 404"
    },
    {
      "cursor": "63",
      "at": "2026-10-12T17:24:57Z",
      "phase": "checking",
      "message": "readiness attempt 130: 404"
    },
    {
      "cursor": "64",
      "at": "2026-10-12T17:25:17Z",
      "phase": "checking",
      "message": "readiness attempt 140: 404"
    },
    {
      "cursor": "65",
      "at": "2026-10-12T17:25:38Z",
      "phase": "checking",
      "message": "readiness attempt 150: 404"
    },
    {
      "cursor": "66",
      "at": "2026-10-12T17:25:38Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 404); containers were kept for inspection"
    }
  ]
}
 |
| librephotos | pass | healthy after 159s; page title "LibrePhotos"; health 200; removed after the check; volumes and folders retained |
| ollama | pass | healthy after 147s; page title ""; health 200; removed after the check; volumes and folders retained |
| rotki | pass | healthy after 42s; page title "rotki"; health 200; removed after the check; volumes and folders retained |
| telegrapho | pass | healthy after 46s; page title "Telegrapho"; health 200; removed after the check; volumes and folders retained |
| yuvomi | pass | healthy after 53s; page title "Yuvomi"; health 200; removed after the check; volumes and folders retained |
