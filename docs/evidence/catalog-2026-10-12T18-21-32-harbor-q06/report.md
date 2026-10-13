# Catalog qualification catalog-2026-10-12T18-21-32-harbor-q06

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| bitaxe-sentry | pass | healthy after 47s; page title "Dashboard - Bitaxe Sentry"; health 200; removed after the check; volumes and folders retained |
| changedetection-io | pass | healthy after 53s; page title "Change Detection"; health 200; removed after the check; volumes and folders retained |
| foldergram | pass | healthy after 46s; page title "Foldergram"; health 200; removed after the check; volumes and folders retained |
| libreddit | fail | harbor install libreddit --name libreddit-q1821 --yes exited 1:  r": "77",
      "at": "2026-10-12T18:27:38Z",
      "phase": "checking",
      "message": "readiness attempt 60: 404"
    },
    {
      "cursor": "78",
      "at": "2026-10-12T18:27:58Z",
      "phase": "checking",
      "message": "readiness attempt 70: 404"
    },
    {
      "cursor": "79",
      "at": "2026-10-12T18:28:18Z",
      "phase": "checking",
      "message": "readiness attempt 80: 404"
    },
    {
      "cursor": "80",
      "at": "2026-10-12T18:28:38Z",
      "phase": "checking",
      "message": "readiness attempt 90: 404"
    },
    {
      "cursor": "81",
      "at": "2026-10-12T18:28:58Z",
      "phase": "checking",
      "message": "readiness attempt 100: 404"
    },
    {
      "cursor": "82",
      "at": "2026-10-12T18:29:19Z",
      "phase": "checking",
      "message": "readiness attempt 110: 404"
    },
    {
      "cursor": "83",
      "at": "2026-10-12T18:29:39Z",
      "phase": "checking",
      "message": "readiness attempt 120: 404"
    },
    {
      "cursor": "84",
      "at": "2026-10-12T18:30:00Z",
      "phase": "checking",
      "message": "readiness attempt 130: 404"
    },
    {
      "cursor": "85",
      "at": "2026-10-12T18:30:20Z",
      "phase": "checking",
      "message": "readiness attempt 140: 404"
    },
    {
      "cursor": "86",
      "at": "2026-10-12T18:30:36Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 404); containers were kept for inspection"
    }
  ]
}
 |
| llama-gpt | pass | healthy after 250s; page title "LlamaGPT"; health 200; removed after the check; volumes and folders retained |
| opencode | pass | healthy after 50s; page title "OpenCode"; health 200; removed after the check; volumes and folders retained |
| seedtool | pass | healthy after 30s; page title "Seed Tool"; health 200; removed after the check; volumes and folders retained |
| threema | pass | healthy after 29s; page title "Threema Web"; health 200; removed after the check; volumes and folders retained |
| zeronote | pass | healthy after 25s; page title "ZeroNote - Zero Knowledge Encrypted Notes"; health 200; removed after the check; volumes and folders retained |
