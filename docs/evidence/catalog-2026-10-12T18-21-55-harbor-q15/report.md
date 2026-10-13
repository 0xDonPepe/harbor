# Catalog qualification catalog-2026-10-12T18-21-55-harbor-q15

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| autobrr | pass | healthy after 22s; page title "autobrr"; health 200; removed after the check; volumes and folders retained |
| bitboard | fail | harbor install bitboard --name bitboard-q1821 --yes exited 1:  ": "37",
      "at": "2026-10-12T18:26:10Z",
      "phase": "checking",
      "message": "readiness attempt 70: 500"
    },
    {
      "cursor": "38",
      "at": "2026-10-12T18:26:30Z",
      "phase": "checking",
      "message": "readiness attempt 80: 500"
    },
    {
      "cursor": "39",
      "at": "2026-10-12T18:26:50Z",
      "phase": "checking",
      "message": "readiness attempt 90: 500"
    },
    {
      "cursor": "40",
      "at": "2026-10-12T18:27:10Z",
      "phase": "checking",
      "message": "readiness attempt 100: 500"
    },
    {
      "cursor": "41",
      "at": "2026-10-12T18:27:31Z",
      "phase": "checking",
      "message": "readiness attempt 110: 500"
    },
    {
      "cursor": "42",
      "at": "2026-10-12T18:27:51Z",
      "phase": "checking",
      "message": "readiness attempt 120: 500"
    },
    {
      "cursor": "43",
      "at": "2026-10-12T18:28:11Z",
      "phase": "checking",
      "message": "readiness attempt 130: 500"
    },
    {
      "cursor": "44",
      "at": "2026-10-12T18:28:31Z",
      "phase": "checking",
      "message": "readiness attempt 140: 500"
    },
    {
      "cursor": "45",
      "at": "2026-10-12T18:28:51Z",
      "phase": "checking",
      "message": "readiness attempt 150: 500"
    },
    {
      "cursor": "46",
      "at": "2026-10-12T18:28:51Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: 500); containers were kept for inspection"
    }
  ]
}
 |
| element | pass | healthy after 34s; page title "Element"; health 200; removed after the check; volumes and folders retained |
| influxdb2 | pass | healthy after 36s; page title "InfluxDB"; health 200; removed after the check; volumes and folders retained |
| invio | pass | healthy after 71s; page title "Invio"; health 303; removed after the check; volumes and folders retained |
| myspeed | pass | healthy after 51s; page title "MySpeed"; health 200; removed after the check; volumes and folders retained |
| pinchflat | pass | healthy after 55s; page title "Pinchflat"; health 200; removed after the check; volumes and folders retained |
| pinchflat (external storage) | pass | healthy after 30s; page title "Pinchflat"; health 200; external storage: --storage downloads=/mnt/harbor-test-storage/pinchflat-downloads-q1821 mounted as bind; removed after the check; volumes and folders retained |
| strix | pass | healthy after 25s; page title "Strix - Camera Stream Discovery"; health 200; removed after the check; volumes and folders retained |
| whoogle-search | pass | healthy after 48s; page title "Whoogle Search"; health 200; removed after the check; volumes and folders retained |
