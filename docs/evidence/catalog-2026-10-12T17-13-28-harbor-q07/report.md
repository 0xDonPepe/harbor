# Catalog qualification catalog-2026-10-12T17-13-28-harbor-q07

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| blinko | fail | harbor install blinko --name blinko-q1713 --yes exited 1:  9080757a46384e5dbf5ae2cf9fca2915_app on the drive (/srv/harbor/harbor-apps/blinko/blinko-q1713/volumes/app)"
    },
    {
      "cursor": "8",
      "at": "2026-10-12T17:14:51Z",
      "phase": "preparing",
      "message": "generated retained secret app-seed"
    },
    {
      "cursor": "9",
      "at": "2026-10-12T17:14:51Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "10",
      "at": "2026-10-12T17:14:51Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "11",
      "at": "2026-10-12T17:15:28Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "12",
      "at": "2026-10-12T17:18:10Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "13",
      "at": "2026-10-12T17:18:10Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): 2cf9fca2915-db-1 Healthy \n Container hb_9080757a46384e5dbf5ae2cf9fca2915-app-1 Starting \n Container hb_9080757a46384e5dbf5ae2cf9fca2915-app-1 Started \n Container hb_9080757a46384e5dbf5ae2cf9fca2915-app-1 Waiting \n Container hb_9080757a46384e5dbf5ae2cf9fca2915-db-1 Waiting \n Container hb_9080757a46384e5dbf5ae2cf9fca2915-db-1 Healthy \ncontainer hb_9080757a46384e5dbf5ae2cf9fca2915-app-1 is unhealthy\n"
    }
  ]
}
 |
| convertx | pass | healthy after 127s; page title "ConvertX / Setup"; health 302; removed after the check; volumes and folders retained |
| grocy | pass | healthy after 43s; page title "Login / Grocy"; health 302; removed after the check; volumes and folders retained |
| localai | pass | healthy after 53s; page title "LocalAI"; health 301; removed after the check; volumes and folders retained |
| nitter | fail | harbor install nitter --name nitter-q1713 --yes exited 1:  t": "2026-10-12T17:22:04Z",
      "phase": "preparing",
      "message": "kernel-sealed /srv/harbor/harbor-apps/nitter/nitter-q1713/volumes (fscrypt v2, per-app key)"
    },
    {
      "cursor": "86",
      "at": "2026-10-12T17:22:04Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/nitter/nitter-q1713 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "87",
      "at": "2026-10-12T17:22:04Z",
      "phase": "preparing",
      "message": "created retained volume hb_e27232599c4c4f73bcda7536a28b6f0f_redis on the drive (/srv/harbor/harbor-apps/nitter/nitter-q1713/volumes/redis)"
    },
    {
      "cursor": "88",
      "at": "2026-10-12T17:22:04Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "89",
      "at": "2026-10-12T17:22:04Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "90",
      "at": "2026-10-12T17:22:13Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "91",
      "at": "2026-10-12T17:22:16Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "92",
      "at": "2026-10-12T17:22:16Z",
      "phase": "failed",
      "message": "install failed: service web is not running after start"
    }
  ]
}
 |
| papra | pass | healthy after 54s; page title "Papra - Document archiving and sharing platform"; health 200; removed after the check; volumes and folders retained |
| snapdrop | pass | healthy after 32s; page title "Snapdrop"; health 200; removed after the check; volumes and folders retained |
| trilium-notes | fail | harbor install trilium-notes --name trilium-notes-q1713 --yes exited 1:      "cursor": "144",
      "at": "2026-10-12T17:23:51Z",
      "phase": "preparing",
      "message": "created retained volume hb_143b170b1bc94176a39e463383167b24_data on the drive (/srv/harbor/harbor-apps/trilium-notes/trilium-notes-q1713/volumes/data)"
    },
    {
      "cursor": "145",
      "at": "2026-10-12T17:23:51Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "146",
      "at": "2026-10-12T17:23:51Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "147",
      "at": "2026-10-12T17:24:01Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "148",
      "at": "2026-10-12T17:24:03Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "149",
      "at": "2026-10-12T17:24:03Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): ted \n Container hb_143b170b1bc94176a39e463383167b24-server-1 Creating \n Container hb_143b170b1bc94176a39e463383167b24-server-1 Created \n Container hb_143b170b1bc94176a39e463383167b24-server-1 Starting \n Container hb_143b170b1bc94176a39e463383167b24-server-1 Started \n Container hb_143b170b1bc94176a39e463383167b24-server-1 Waiting \ncontainer hb_143b170b1bc94176a39e463383167b24-server-1 is unhealthy\n"
    }
  ]
}
 |
