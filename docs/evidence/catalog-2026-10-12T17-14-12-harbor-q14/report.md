# Catalog qualification catalog-2026-10-12T17-14-12-harbor-q14

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| autobrr | pass | healthy after 27s; page title "autobrr"; health 200; removed after the check; volumes and folders retained |
| bitwatch | pass | healthy after 53s; page title "Bitwatch"; health 200; removed after the check; volumes and folders retained |
| emby | pass | healthy after 58s; page title "2374fb252539"; health 302; removed after the check; volumes and folders retained |
| emby (external storage) | fail | harbor install emby --name emby-q1714x --storage downloads=/mnt/harbor-test-storage/emby-downloads-q1714 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "emby does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| influxdb | pass | healthy after 40s; page title "Chronograf"; health 200; removed after the check; volumes and folders retained |
| jackett | pass | healthy after 43s; page title "Jackett"; health 301; removed after the check; volumes and folders retained |
| jackett (external storage) | fail | harbor install jackett --name jackett-q1714x --storage downloads=/mnt/harbor-test-storage/jackett-downloads-q1714 --yes exited 3:  {
  "error": {
    "code": "NAME_CONFLICT",
    "message": "jackett does not support multiple instances",
    "nextAction": "Remove the existing instance first."
  }
}
 |
| networkingtoolbox | fail | harbor install networkingtoolbox --name networkingtoolbox-q1714 --yes exited 1:     {
      "cursor": "105",
      "at": "2026-10-12T17:19:39Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/networkingtoolbox/networkingtoolbox-q1714 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "106",
      "at": "2026-10-12T17:19:39Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "107",
      "at": "2026-10-12T17:19:39Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "108",
      "at": "2026-10-12T17:19:48Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "109",
      "at": "2026-10-12T17:21:29Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "110",
      "at": "2026-10-12T17:21:29Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): 0e217_default Created \n Container hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 Creating \n Container hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 Created \n Container hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 Starting \n Container hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 Started \n Container hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 Waiting \ncontainer hb_5b230b277bdc43b8b33bc0565ce0e217-app-1 is unhealthy\n"
    }
  ]
}
 |
| pingvin-share | pass | healthy after 82s; page title "Home - Pingvin Share"; health 200; removed after the check; volumes and folders retained |
| super-productivity | pass | healthy after 38s; page title "Super Productivity"; health 200; removed after the check; volumes and folders retained |
| wikijs | pass | healthy after 56s; page title "Wiki.js Setup"; health 200; removed after the check; volumes and folders retained |
