# Catalog qualification catalog-2026-10-12T19-35-30-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| wireguard | fail | harbor --accept-permissions install wireguard --name wireguard-q1935 --yes exited 1:     },
    {
      "cursor": "6",
      "at": "2026-10-12T19:36:52Z",
      "phase": "preparing",
      "message": "created retained volume hb_99c41dcfbd34470280fe78329a57afdc_config on the drive (/srv/harbor/harbor-apps/wireguard/wireguard-q1935/volumes/config)"
    },
    {
      "cursor": "7",
      "at": "2026-10-12T19:36:52Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "8",
      "at": "2026-10-12T19:36:52Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "9",
      "at": "2026-10-12T19:36:57Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "10",
      "at": "2026-10-12T19:39:53Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "11",
      "at": "2026-10-12T19:39:53Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): b_99c41dcfbd34470280fe78329a57afdc_default Created \n Container hb_99c41dcfbd34470280fe78329a57afdc-app-1 Creating \n Container hb_99c41dcfbd34470280fe78329a57afdc-app-1 Created \n Container hb_99c41dcfbd34470280fe78329a57afdc-app-1 Starting \n Container hb_99c41dcfbd34470280fe78329a57afdc-app-1 Started \n Container hb_99c41dcfbd34470280fe78329a57afdc-app-1 Waiting \napplication not healthy after 2m55s\n"
    }
  ]
}
 |
