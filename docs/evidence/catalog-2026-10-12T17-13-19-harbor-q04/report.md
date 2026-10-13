# Catalog qualification catalog-2026-10-12T17-13-19-harbor-q04

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| bitboard | fail | harbor install bitboard --name bitboard-q1713 --yes exited 1:  ": "18",
      "at": "2026-10-12T17:17:04Z",
      "phase": "checking",
      "message": "readiness attempt 70: 500"
    },
    {
      "cursor": "19",
      "at": "2026-10-12T17:17:24Z",
      "phase": "checking",
      "message": "readiness attempt 80: 500"
    },
    {
      "cursor": "20",
      "at": "2026-10-12T17:17:44Z",
      "phase": "checking",
      "message": "readiness attempt 90: 500"
    },
    {
      "cursor": "21",
      "at": "2026-10-12T17:18:04Z",
      "phase": "checking",
      "message": "readiness attempt 100: 500"
    },
    {
      "cursor": "22",
      "at": "2026-10-12T17:18:24Z",
      "phase": "checking",
      "message": "readiness attempt 110: 500"
    },
    {
      "cursor": "23",
      "at": "2026-10-12T17:18:44Z",
      "phase": "checking",
      "message": "readiness attempt 120: 500"
    },
    {
      "cursor": "24",
      "at": "2026-10-12T17:19:04Z",
      "phase": "checking",
      "message": "readiness attempt 130: 500"
    },
    {
      "cursor": "25",
      "at": "2026-10-12T17:19:24Z",
      "phase": "checking",
      "message": "readiness attempt 140: 500"
    },
    {
      "cursor": "26",
      "at": "2026-10-12T17:19:45Z",
      "phase": "checking",
      "message": "readiness attempt 150: 500"
    },
    {
      "cursor": "27",
      "at": "2026-10-12T17:19:45Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 500); containers were kept for inspection"
    }
  ]
}
 |
| changedetection-io | pass | healthy after 50s; page title "Change Detection"; health 200; removed after the check; volumes and folders retained |
| docmost | pass | healthy after 77s; page title "Setup Workspace - Docmost"; health 200; removed after the check; volumes and folders retained |
| foldergram | pass | healthy after 43s; page title "Foldergram"; health 200; removed after the check; volumes and folders retained |
| libreddit | fail | harbor install libreddit --name libreddit-q1713 --yes exited 1:  p key)"
    },
    {
      "cursor": "103",
      "at": "2026-10-12T17:22:58Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/libreddit/libreddit-q1713 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "104",
      "at": "2026-10-12T17:22:58Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "105",
      "at": "2026-10-12T17:22:58Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "106",
      "at": "2026-10-12T17:23:02Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "107",
      "at": "2026-10-12T17:25:58Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "108",
      "at": "2026-10-12T17:25:58Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): b_a38ef87e9b7347a191612cbdcf5a5bc7_default Created \n Container hb_a38ef87e9b7347a191612cbdcf5a5bc7-web-1 Creating \n Container hb_a38ef87e9b7347a191612cbdcf5a5bc7-web-1 Created \n Container hb_a38ef87e9b7347a191612cbdcf5a5bc7-web-1 Starting \n Container hb_a38ef87e9b7347a191612cbdcf5a5bc7-web-1 Started \n Container hb_a38ef87e9b7347a191612cbdcf5a5bc7-web-1 Waiting \napplication not healthy after 2m55s\n"
    }
  ]
}
 |
| opencode | pass | healthy after 41s; page title "OpenCode"; health 200; removed after the check; volumes and folders retained |
| seedtool | pass | healthy after 31s; page title "Seed Tool"; health 200; removed after the check; volumes and folders retained |
| threema | pass | healthy after 26s; page title "Threema Web"; health 200; removed after the check; volumes and folders retained |
| zeronote | pass | healthy after 25s; page title "ZeroNote - Zero Knowledge Encrypted Notes"; health 200; removed after the check; volumes and folders retained |
