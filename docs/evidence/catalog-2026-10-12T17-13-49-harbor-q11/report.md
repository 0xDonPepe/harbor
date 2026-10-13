# Catalog qualification catalog-2026-10-12T17-13-49-harbor-q11

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| dumbpad | pass | healthy after 33s; page title "DumbPad - Simple Notes"; health 200; removed after the check; volumes and folders retained |
| flaresolverr | pass | healthy after 50s; page title "FlareSolverr Status"; health 200; removed after the check; volumes and folders retained |
| homarr | pass | healthy after 51s; page title "Homarr"; health 307; removed after the check; volumes and folders retained |
| mqttx-web | pass | healthy after 32s; page title "Easy-to-Use Online MQTT Client / Try Now"; health 200; removed after the check; volumes and folders retained |
| perplexica | pass | healthy after 225s; page title "Chat - Vane"; health 200; removed after the check; volumes and folders retained |
| stash | pass | healthy after 124s; page title "Stash"; health 200; removed after the check; volumes and folders retained |
| termix | fail | harbor install termix --name termix-q1713 --yes exited 1:     },
    {
      "cursor": "122",
      "at": "2026-10-12T17:23:52Z",
      "phase": "preparing",
      "message": "created retained volume hb_550b3194f1d247af9d8b7fd7be7f5208_data on the drive (/srv/harbor/harbor-apps/termix/termix-q1713/volumes/data)"
    },
    {
      "cursor": "123",
      "at": "2026-10-12T17:23:52Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "124",
      "at": "2026-10-12T17:23:52Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "125",
      "at": "2026-10-12T17:24:07Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "126",
      "at": "2026-10-12T17:27:03Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "127",
      "at": "2026-10-12T17:27:03Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): _550b3194f1d247af9d8b7fd7be7f5208-guacd-1 Started \n Container hb_550b3194f1d247af9d8b7fd7be7f5208-web-1 Starting \n Container hb_550b3194f1d247af9d8b7fd7be7f5208-web-1 Started \n Container hb_550b3194f1d247af9d8b7fd7be7f5208-web-1 Waiting \n Container hb_550b3194f1d247af9d8b7fd7be7f5208-guacd-1 Waiting \n Container hb_550b3194f1d247af9d8b7fd7be7f5208-web-1 Healthy \napplication not healthy after 2m55s\n"
    }
  ]
}
 |
| wallos | pass | healthy after 37s; page title "Wallos - Subscription Tracker"; health 302; removed after the check; volumes and folders retained |
