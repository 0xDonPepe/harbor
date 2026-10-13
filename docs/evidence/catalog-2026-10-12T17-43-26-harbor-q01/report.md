# Catalog qualification catalog-2026-10-12T17-43-26-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| bitboard | fail | harbor install bitboard --name bitboard-q1743 --yes exited 1:  ": "18",
      "at": "2026-10-12T17:47:08Z",
      "phase": "checking",
      "message": "readiness attempt 70: 500"
    },
    {
      "cursor": "19",
      "at": "2026-10-12T17:47:28Z",
      "phase": "checking",
      "message": "readiness attempt 80: 500"
    },
    {
      "cursor": "20",
      "at": "2026-10-12T17:47:48Z",
      "phase": "checking",
      "message": "readiness attempt 90: 500"
    },
    {
      "cursor": "21",
      "at": "2026-10-12T17:48:08Z",
      "phase": "checking",
      "message": "readiness attempt 100: 500"
    },
    {
      "cursor": "22",
      "at": "2026-10-12T17:48:29Z",
      "phase": "checking",
      "message": "readiness attempt 110: 500"
    },
    {
      "cursor": "23",
      "at": "2026-10-12T17:48:49Z",
      "phase": "checking",
      "message": "readiness attempt 120: 500"
    },
    {
      "cursor": "24",
      "at": "2026-10-12T17:49:09Z",
      "phase": "checking",
      "message": "readiness attempt 130: 500"
    },
    {
      "cursor": "25",
      "at": "2026-10-12T17:49:29Z",
      "phase": "checking",
      "message": "readiness attempt 140: 500"
    },
    {
      "cursor": "26",
      "at": "2026-10-12T17:49:49Z",
      "phase": "checking",
      "message": "readiness attempt 150: 500"
    },
    {
      "cursor": "27",
      "at": "2026-10-12T17:49:49Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 500); containers were kept for inspection"
    }
  ]
}
 |
| blinko | fail | harbor install blinko --name blinko-q1743 --yes exited 1:  46303ebe6d4d9f88685f9ded959c5d_app on the drive (/srv/harbor/harbor-apps/blinko/blinko-q1743/volumes/app)"
    },
    {
      "cursor": "41",
      "at": "2026-10-12T17:50:13Z",
      "phase": "preparing",
      "message": "generated retained secret app-seed"
    },
    {
      "cursor": "42",
      "at": "2026-10-12T17:50:14Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "43",
      "at": "2026-10-12T17:50:14Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "44",
      "at": "2026-10-12T17:50:39Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "45",
      "at": "2026-10-12T17:53:22Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "46",
      "at": "2026-10-12T17:53:22Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): f9ded959c5d-db-1 Healthy \n Container hb_8b46303ebe6d4d9f88685f9ded959c5d-app-1 Starting \n Container hb_8b46303ebe6d4d9f88685f9ded959c5d-app-1 Started \n Container hb_8b46303ebe6d4d9f88685f9ded959c5d-db-1 Waiting \n Container hb_8b46303ebe6d4d9f88685f9ded959c5d-app-1 Waiting \n Container hb_8b46303ebe6d4d9f88685f9ded959c5d-db-1 Healthy \ncontainer hb_8b46303ebe6d4d9f88685f9ded959c5d-app-1 is unhealthy\n"
    }
  ]
}
 |
| kokoro | fail | harbor install kokoro --name kokoro-q1743 --yes exited 1:  ": "70",
      "at": "2026-10-12T17:56:50Z",
      "phase": "checking",
      "message": "readiness attempt 70: 404"
    },
    {
      "cursor": "71",
      "at": "2026-10-12T17:57:10Z",
      "phase": "checking",
      "message": "readiness attempt 80: 404"
    },
    {
      "cursor": "72",
      "at": "2026-10-12T17:57:30Z",
      "phase": "checking",
      "message": "readiness attempt 90: 404"
    },
    {
      "cursor": "73",
      "at": "2026-10-12T17:57:50Z",
      "phase": "checking",
      "message": "readiness attempt 100: 404"
    },
    {
      "cursor": "74",
      "at": "2026-10-12T17:58:10Z",
      "phase": "checking",
      "message": "readiness attempt 110: 404"
    },
    {
      "cursor": "75",
      "at": "2026-10-12T17:58:31Z",
      "phase": "checking",
      "message": "readiness attempt 120: 404"
    },
    {
      "cursor": "76",
      "at": "2026-10-12T17:58:51Z",
      "phase": "checking",
      "message": "readiness attempt 130: 404"
    },
    {
      "cursor": "77",
      "at": "2026-10-12T17:59:11Z",
      "phase": "checking",
      "message": "readiness attempt 140: 404"
    },
    {
      "cursor": "78",
      "at": "2026-10-12T17:59:31Z",
      "phase": "checking",
      "message": "readiness attempt 150: 404"
    },
    {
      "cursor": "79",
      "at": "2026-10-12T17:59:31Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 404); containers were kept for inspection"
    }
  ]
}
 |
| libreddit | fail | harbor install libreddit --name libreddit-q1743 --yes exited 1:  per-app key)"
    },
    {
      "cursor": "90",
      "at": "2026-10-12T17:59:43Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/libreddit/libreddit-q1743 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "91",
      "at": "2026-10-12T17:59:43Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "92",
      "at": "2026-10-12T17:59:43Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "93",
      "at": "2026-10-12T17:59:47Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "94",
      "at": "2026-10-12T18:02:43Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "95",
      "at": "2026-10-12T18:02:43Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): b_58bc0df14f774a03b94a2651525ed9a2_default Created \n Container hb_58bc0df14f774a03b94a2651525ed9a2-web-1 Creating \n Container hb_58bc0df14f774a03b94a2651525ed9a2-web-1 Created \n Container hb_58bc0df14f774a03b94a2651525ed9a2-web-1 Starting \n Container hb_58bc0df14f774a03b94a2651525ed9a2-web-1 Started \n Container hb_58bc0df14f774a03b94a2651525ed9a2-web-1 Waiting \napplication not healthy after 2m55s\n"
    }
  ]
}
 |
| networkingtoolbox | fail | harbor install networkingtoolbox --name networkingtoolbox-q1743 --yes exited 1:     {
      "cursor": "106",
      "at": "2026-10-12T18:03:07Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/networkingtoolbox/networkingtoolbox-q1743 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "107",
      "at": "2026-10-12T18:03:07Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "108",
      "at": "2026-10-12T18:03:07Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "109",
      "at": "2026-10-12T18:03:13Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "110",
      "at": "2026-10-12T18:04:54Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "111",
      "at": "2026-10-12T18:04:54Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): 029d0_default Created \n Container hb_2c6433c788384d43a282e9a9627029d0-app-1 Creating \n Container hb_2c6433c788384d43a282e9a9627029d0-app-1 Created \n Container hb_2c6433c788384d43a282e9a9627029d0-app-1 Starting \n Container hb_2c6433c788384d43a282e9a9627029d0-app-1 Started \n Container hb_2c6433c788384d43a282e9a9627029d0-app-1 Waiting \ncontainer hb_2c6433c788384d43a282e9a9627029d0-app-1 is unhealthy\n"
    }
  ]
}
 |
| nitter | fail | harbor install nitter --name nitter-q1743 --yes exited 1:  26-10-12T18:05:06Z",
      "phase": "preparing",
      "message": "kernel-sealed /srv/harbor/harbor-apps/nitter/nitter-q1743/volumes (fscrypt v2, per-app key)"
    },
    {
      "cursor": "122",
      "at": "2026-10-12T18:05:06Z",
      "phase": "preparing",
      "message": "created encrypted app home /srv/harbor/harbor-apps/nitter/nitter-q1743 (this machine unlocks it silently) (kernel-sealed)"
    },
    {
      "cursor": "123",
      "at": "2026-10-12T18:05:06Z",
      "phase": "preparing",
      "message": "created retained volume hb_4d81fd5c7d064badb991fc8bdb995e0c_redis on the drive (/srv/harbor/harbor-apps/nitter/nitter-q1743/volumes/redis)"
    },
    {
      "cursor": "124",
      "at": "2026-10-12T18:05:06Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "125",
      "at": "2026-10-12T18:05:06Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "126",
      "at": "2026-10-12T18:05:12Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "127",
      "at": "2026-10-12T18:05:16Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "128",
      "at": "2026-10-12T18:05:16Z",
      "phase": "failed",
      "message": "install failed: service web is not running after start"
    }
  ]
}
 |
| termix | fail | harbor install termix --name termix-q1743 --yes exited 1:     },
    {
      "cursor": "141",
      "at": "2026-10-12T18:05:26Z",
      "phase": "preparing",
      "message": "created retained volume hb_2d5283946b084f5cb181b64aa49c6dc4_data on the drive (/srv/harbor/harbor-apps/termix/termix-q1743/volumes/data)"
    },
    {
      "cursor": "142",
      "at": "2026-10-12T18:05:26Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "143",
      "at": "2026-10-12T18:05:26Z",
      "phase": "pulling",
      "message": "pulling 2 image(s) by digest"
    },
    {
      "cursor": "144",
      "at": "2026-10-12T18:05:38Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "145",
      "at": "2026-10-12T18:08:34Z",
      "phase": "starting",
      "message": "recorded 2 owned container(s) and the project network"
    },
    {
      "cursor": "146",
      "at": "2026-10-12T18:08:34Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): _2d5283946b084f5cb181b64aa49c6dc4-guacd-1 Started \n Container hb_2d5283946b084f5cb181b64aa49c6dc4-web-1 Starting \n Container hb_2d5283946b084f5cb181b64aa49c6dc4-web-1 Started \n Container hb_2d5283946b084f5cb181b64aa49c6dc4-guacd-1 Waiting \n Container hb_2d5283946b084f5cb181b64aa49c6dc4-web-1 Waiting \n Container hb_2d5283946b084f5cb181b64aa49c6dc4-web-1 Healthy \napplication not healthy after 2m55s\n"
    }
  ]
}
 |
| trilium-notes | fail | harbor install trilium-notes --name trilium-notes-q1743 --yes exited 1:      "cursor": "159",
      "at": "2026-10-12T18:08:45Z",
      "phase": "preparing",
      "message": "created retained volume hb_f7dfc690b0554c898724cda8658d787b_data on the drive (/srv/harbor/harbor-apps/trilium-notes/trilium-notes-q1743/volumes/data)"
    },
    {
      "cursor": "160",
      "at": "2026-10-12T18:08:45Z",
      "phase": "preparing",
      "message": "generated private Compose file and validated it with Compose"
    },
    {
      "cursor": "161",
      "at": "2026-10-12T18:08:45Z",
      "phase": "pulling",
      "message": "pulling 1 image(s) by digest"
    },
    {
      "cursor": "162",
      "at": "2026-10-12T18:08:54Z",
      "phase": "starting",
      "message": "creating and starting the Compose project"
    },
    {
      "cursor": "163",
      "at": "2026-10-12T18:08:56Z",
      "phase": "starting",
      "message": "recorded 1 owned container(s) and the project network"
    },
    {
      "cursor": "164",
      "at": "2026-10-12T18:08:56Z",
      "phase": "failed",
      "message": "install failed: docker compose up failed (exit 1): ted \n Container hb_f7dfc690b0554c898724cda8658d787b-server-1 Creating \n Container hb_f7dfc690b0554c898724cda8658d787b-server-1 Created \n Container hb_f7dfc690b0554c898724cda8658d787b-server-1 Starting \n Container hb_f7dfc690b0554c898724cda8658d787b-server-1 Started \n Container hb_f7dfc690b0554c898724cda8658d787b-server-1 Waiting \ncontainer hb_f7dfc690b0554c898724cda8658d787b-server-1 is unhealthy\n"
    }
  ]
}
 |
